import crypto from 'node:crypto';
import { AppConfig } from '../config/env.js';
import { HubDatabase } from '../db/database.js';

export type AntiBanPreset = 'conservative' | 'moderate' | 'veteran';

export interface DebouncePayload {
  text: string;
  hadAudio: boolean;
}

export interface AntiBanStatusSnapshot {
  circuitOpen: boolean;
  consecutiveErrors: number;
  lastError: string | null;
  sendsLastHour: number;
  sendsLastDay: number;
  hourlyLimit: number;
  dailyLimit: number;
  preset: string;
}

const OPT_OUT_TERMS = [
  'parar',
  'pare',
  'sair',
  'nao quero',
  'spam',
  'bloquear',
  'bloqueia',
  'remover'
];

const VARIATION_CLOSINGS = [
  'Qualquer duvida, estou por aqui!',
  'Me avisa se precisar de ajuda para escolher.',
  'Se quiser outra opcao parecida, e so falar!'
];

function stripAccentsLower(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AntiBanService {
  private circuitOpen = false;
  private consecutiveErrors = 0;
  private lastError: string | null = null;
  private sendQueue: Promise<unknown> = Promise.resolve();
  private sentInSession = 0;
  private readonly debouncers = new Map<
    string,
    { timer: NodeJS.Timeout; items: DebouncePayload[] }
  >();

  constructor(
    private readonly db: HubDatabase,
    private readonly config: AppConfig
  ) {}

  getPresetValues(preset: AntiBanPreset): {
    antiban_preset: string;
    antiban_debounce_sec: string;
    antiban_hourly_limit: string;
    antiban_daily_limit: string;
    antiban_cooldown_every: string;
    antiban_cooldown_minutes: string;
  } {
    if (preset === 'veteran') {
      return {
        antiban_preset: 'veteran',
        antiban_debounce_sec: '6',
        antiban_hourly_limit: '60',
        antiban_daily_limit: '250',
        antiban_cooldown_every: '25',
        antiban_cooldown_minutes: '3'
      };
    }
    if (preset === 'moderate') {
      return {
        antiban_preset: 'moderate',
        antiban_debounce_sec: '10',
        antiban_hourly_limit: '30',
        antiban_daily_limit: '100',
        antiban_cooldown_every: '15',
        antiban_cooldown_minutes: '4'
      };
    }
    return {
      antiban_preset: 'conservative',
      antiban_debounce_sec: '12',
      antiban_hourly_limit: '15',
      antiban_daily_limit: '40',
      antiban_cooldown_every: '10',
      antiban_cooldown_minutes: '5'
    };
  }

  getStatus(): AntiBanStatusSnapshot {
    const settings = this.db.getAllSettings();
    const counts = this.db.getSendCounts();
    return {
      circuitOpen: this.circuitOpen,
      consecutiveErrors: this.consecutiveErrors,
      lastError: this.lastError,
      sendsLastHour: counts.lastHour,
      sendsLastDay: counts.lastDay,
      hourlyLimit: Number.parseInt(settings.antiban_hourly_limit || '15', 10) || 15,
      dailyLimit: Number.parseInt(settings.antiban_daily_limit || '40', 10) || 40,
      preset: settings.antiban_preset || 'conservative'
    };
  }

  resetCircuitBreaker(): void {
    this.circuitOpen = false;
    this.consecutiveErrors = 0;
    this.lastError = null;
    this.db.addLog('info', 'antiban', 'Circuit Breaker rearmado manualmente.');
  }

  tripCircuitBreaker(reason: string): void {
    this.circuitOpen = true;
    this.lastError = reason;
    this.db.addLog(
      'error',
      'antiban',
      'CIRCUIT BREAKER ACIONADO: envios pausados por seguranca.',
      reason
    );
  }

  isOptOutMessage(text: string): boolean {
    const clean = stripAccentsLower(text);
    if (!clean || clean.length > 60) return false;
    return OPT_OUT_TERMS.some(
      (term) => clean === term || clean.startsWith(`${term} `) || clean.endsWith(` ${term}`)
    );
  }

  checkCanSend(
    channel: 'x1' | 'group',
    jid: string
  ): { allowed: boolean; reason?: string } {
    if (this.circuitOpen) {
      return {
        allowed: false,
        reason: 'Circuit Breaker ativo. Retome os envios no painel.'
      };
    }

    if (this.db.isBlacklisted(jid)) {
      return { allowed: false, reason: 'Contato esta na blacklist (opt-out).' };
    }

    const settings = this.db.getAllSettings();
    const now = Math.floor(Date.now() / 1000);

    if (channel === 'x1') {
      const state = this.db.getContactState(jid);
      if (state?.paused_until && state.paused_until > now) {
        return {
          allowed: false,
          reason: state.pause_reason || 'Contato pausado (intervencao humana).'
        };
      }
      if (settings.antiban_inbound_only_24h === 'true') {
        if (!state?.last_inbound_at || now - state.last_inbound_at > 86400) {
          return {
            allowed: false,
            reason: 'Trava inbound-only 24h: contato nao iniciou conversa recente.'
          };
        }
      }
    }

    const counts = this.db.getSendCounts();
    const hourlyLimit =
      Number.parseInt(settings.antiban_hourly_limit || '15', 10) || 15;
    const dailyLimit =
      Number.parseInt(settings.antiban_daily_limit || '40', 10) || 40;

    if (counts.lastHour >= hourlyLimit) {
      return {
        allowed: false,
        reason: `Teto por hora atingido (${counts.lastHour}/${hourlyLimit}).`
      };
    }
    if (counts.lastDay >= dailyLimit) {
      return {
        allowed: false,
        reason: `Teto diario atingido (${counts.lastDay}/${dailyLimit}).`
      };
    }

    return { allowed: true };
  }

  applyMicroVariation(text: string): string {
    const counts = this.db.getSendCounts();
    const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    if (counts.lastHash && counts.lastHash === hash) {
      const suffix =
        VARIATION_CLOSINGS[
          Math.floor(Math.random() * VARIATION_CLOSINGS.length)
        ]!;
      return `${text.trim()}\n${suffix}`;
    }
    return text;
  }

  scheduleDebounced(
    jid: string,
    payload: DebouncePayload,
    onFlush: (merged: DebouncePayload) => Promise<void>,
    overrideDelayMs?: number
  ): void {
    const existing = this.debouncers.get(jid);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(payload);
    }

    const items = existing ? existing.items : [payload];
    const settings = this.db.getAllSettings();
    const sec = Number.parseFloat(settings.antiban_debounce_sec || '10');
    const delayMs =
      overrideDelayMs ??
      (Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : 10000);

    const timer = setTimeout(() => {
      this.debouncers.delete(jid);
      const mergedText = items
        .map((i) => i.text.trim())
        .filter(Boolean)
        .join('\n');
      const hadAudio = items.some((i) => i.hadAudio);
      void onFlush({ text: mergedText, hadAudio }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.db.addLog('error', 'antiban', `Falha no flush debounce de ${jid}`, msg);
      });
    }, delayMs);

    this.debouncers.set(jid, { timer, items });
  }

  enqueueSend<T>(
    channel: 'x1' | 'group',
    jid: string,
    textForHash: string,
    taskFn: () => Promise<T>
  ): Promise<T> {
    const run = this.sendQueue.then(async () => {
      const check = this.checkCanSend(channel, jid);
      if (!check.allowed) {
        throw new Error(check.reason || 'Envio bloqueado pelo Anti-Ban.');
      }

      const settings = this.db.getAllSettings();
      const cooldownEvery =
        Number.parseInt(settings.antiban_cooldown_every || '12', 10) || 12;
      const cooldownMin =
        Number.parseInt(settings.antiban_cooldown_minutes || '4', 10) || 4;

      if (
        this.config.antibanMinDelayMs > 0 &&
        this.sentInSession > 0 &&
        this.sentInSession % cooldownEvery === 0
      ) {
        this.db.addLog(
          'info',
          'antiban',
          `Pausa de resfriamento (${cooldownMin} min) apos ${this.sentInSession} envios.`
        );
        await sleep(cooldownMin * 60 * 1000);
      } else if (this.config.antibanMaxDelayMs > 0) {
        const min = this.config.antibanMinDelayMs;
        const max = Math.max(min, this.config.antibanMaxDelayMs);
        await sleep(min + Math.floor(Math.random() * (max - min + 1)));
      }

      try {
        const result = await taskFn();
        this.consecutiveErrors = 0;
        this.sentInSession += 1;
        const hash = crypto
          .createHash('sha256')
          .update(textForHash, 'utf8')
          .digest('hex');
        this.db.recordOutboundSend(channel, jid, hash);
        return result;
      } catch (err) {
        this.consecutiveErrors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        if (this.consecutiveErrors >= 3) {
          this.tripCircuitBreaker(
            `3 falhas consecutivas de envio (ultima: ${msg})`
          );
        }
        throw err;
      }
    });

    this.sendQueue = run.catch(() => undefined);
    return run;
  }

  shutdown(): void {
    for (const entry of this.debouncers.values()) {
      clearTimeout(entry.timer);
    }
    this.debouncers.clear();
  }
}
