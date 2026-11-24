import { AppConfig } from '../config/env.js';
import {
  HubDatabase,
  HubSettings,
  normalizeX1Buttons,
  X1ButtonConfig
} from '../db/database.js';
import { AiService } from './aiService.js';
import { AntiBanService } from './antiBanService.js';
import { RagJevService } from './ragJevService.js';
import { VoiceService } from './voiceService.js';

export interface X1ChannelAdapter {
  channelName: 'baileys' | 'cloud_api';
  sendText: (
    jid: string,
    text: string,
    buttons?: X1ButtonConfig[]
  ) => Promise<string | undefined>;
  sendAudio: (jid: string, oggOpusBuffer: Buffer) => Promise<string | undefined>;
  sendPresence?: (
    jid: string,
    presence: 'composing' | 'recording' | 'paused',
    durationMs: number
  ) => Promise<void>;
}

export interface InboundTurnInput {
  jid: string;
  messageId: string;
  fromMe?: boolean;
  text?: string;
  audioBuffer?: Buffer;
  audioMime?: string;
  debounceMsOverride?: number;
}

function formatNumberedOptions(buttons: X1ButtonConfig[]): string {
  if (!buttons.length) return '';
  const lines = buttons.slice(0, 3).map((b, i) => `${i + 1} - ${b.title}`);
  return `\n\nResponda com o numero da opcao:\n${lines.join('\n')}`;
}

export class X1Orchestrator {
  constructor(
    private readonly db: HubDatabase,
    private readonly config: AppConfig,
    private readonly ai: AiService,
    private readonly voice: VoiceService,
    private readonly antiBan: AntiBanService,
    private readonly ragJev: RagJevService
  ) {}

  handleFromMeCheck(jid: string, messageId: string): boolean {
    if (this.db.isBotSentId(messageId)) {
      return false; // Bot's own message — do not trigger human takeover
    }
    const settings = this.db.getAllSettings();
    const pauseMin =
      Number.parseInt(settings.human_takeover_minutes || '30', 10) || 30;
    this.db.pauseContact(jid, pauseMin, 'Intervencao humana pelo WhatsApp');
    this.db.addLog(
      'info',
      'x1',
      `Intervencao humana detectada em ${jid}; IA pausada por ${pauseMin} min.`
    );
    return true;
  }

  async handleInboundQueued(
    input: InboundTurnInput,
    adapter: X1ChannelAdapter
  ): Promise<{ queued: boolean; reason?: string }> {
    const settings = this.db.getAllSettings();
    if (settings.x1_enabled !== 'true') {
      return { queued: false, reason: 'X1 desativado nas configuracoes.' };
    }

    if (input.fromMe) {
      const paused = this.handleFromMeCheck(input.jid, input.messageId);
      return {
        queued: false,
        reason: paused ? 'human_takeover_paused' : 'bot_own_message'
      };
    }

    if (this.db.isBlacklisted(input.jid)) {
      return { queued: false, reason: 'blacklisted' };
    }

    this.db.touchInboundContact(input.jid);

    let text = (input.text || '').trim();
    let hadAudio = false;

    if (input.audioBuffer && input.audioBuffer.length > 0) {
      if (settings.x1_listen_audio !== 'true') {
        return { queued: false, reason: 'audio_listening_disabled' };
      }
      hadAudio = true;
      try {
        const transcribed = await this.voice.transcribeAudio(
          input.audioBuffer,
          input.audioMime || 'audio/ogg',
          settings
        );
        text = text ? `${text}\n${transcribed}` : transcribed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.db.addLog('warn', 'voice', `Falha ao transcrever audio de ${input.jid}`, msg);
        if (!text) {
          text = '[Cliente enviou um audio que nao pode ser transcrito]';
        }
      }
    }

    if (!text) {
      return { queued: false, reason: 'empty_message' };
    }

    // Immediate opt-out handling
    if (this.antiBan.isOptOutMessage(text)) {
      this.db.addToBlacklist(input.jid, `Opt-out: "${text.slice(0, 40)}"`);
      this.db.addLog('info', 'antiban', `Opt-out automatico ativado para ${input.jid}`);
      try {
        const msgId = await adapter.sendText(
          input.jid,
          'Tudo bem! Nao vamos mais te enviar mensagens por aqui. Se precisar no futuro, e so chamar.'
        );
        if (msgId) this.db.recordBotSentId(msgId);
      } catch {
        // Ignore farewell send failure on opt-out
      }
      return { queued: false, reason: 'opt_out_blacklisted' };
    }

    // Immediate quick option 1/2/3 on Baileys
    const trimmed = text.trim();
    if (adapter.channelName === 'baileys' && /^[123]$/.test(trimmed)) {
      const buttons = normalizeX1Buttons(settings.x1_buttons_json);
      const chosen = buttons[Number.parseInt(trimmed, 10) - 1];
      if (chosen) {
        const quickMsg = [chosen.replyText, chosen.linkUrl].filter(Boolean).join('\n\n');
        await this.antiBan.enqueueSend('x1', input.jid, quickMsg, async () => {
          const sentId = await adapter.sendText(input.jid, quickMsg);
          if (sentId) this.db.recordBotSentId(sentId);
        });
        this.db.appendX1Message(input.jid, 'user', `[Opcao ${trimmed}]`);
        this.db.appendX1Message(input.jid, 'assistant', quickMsg);
        return { queued: true, reason: 'quick_option_sent' };
      }
    }

    this.antiBan.scheduleDebounced(
      input.jid,
      { text, hadAudio },
      async (merged) => {
        await this.processResolvedTurn(input.jid, merged.text, merged.hadAudio, adapter);
      },
      input.debounceMsOverride
    );

    return { queued: true };
  }

  async processResolvedTurn(
    jid: string,
    userText: string,
    hadAudio: boolean,
    adapter: X1ChannelAdapter
  ): Promise<{ replyText: string; usedAudio: boolean; humanCheckpoint: boolean }> {
    const settings = this.db.getAllSettings();
    const canSend = this.antiBan.checkCanSend('x1', jid);
    if (!canSend.allowed) {
      throw new Error(canSend.reason || 'Envio X1 bloqueado pelo Anti-Ban.');
    }

    const history = this.db.getRecentX1History(jid, 8);
    this.db.appendX1Message(jid, 'user', userText);

    const jev = this.ragJev.evaluateWithJev(jid, userText, settings);
    let replyText: string;
    let humanCheckpoint = false;

    if (jev.action === 'human_checkpoint' && jev.checkpointReply) {
      replyText = jev.checkpointReply;
      humanCheckpoint = true;
    } else {
      const rawReply = await this.ai.generateX1Reply(
        {
          provider: settings.ai_provider,
          baseUrl: settings.ai_base_url,
          apiKey: settings.ai_api_key,
          model: settings.ai_model,
          temperature: Number.parseFloat(settings.ai_temperature || '0.6'),
          maxTokens: Number.parseInt(settings.ai_max_tokens || '300', 10),
          geminiBaseUrl: this.config.geminiBaseUrl,
          openaiBaseUrl: this.config.openaiBaseUrl
        },
        {
          systemPrompt: settings.x1_system_prompt,
          catalogContext: jev.context,
          history,
          userMessage: userText
        }
      );

      const buttons = normalizeX1Buttons(settings.x1_buttons_json);
      const allowedUrls = [
        ...jev.allowedUrls,
        ...buttons.map((b) => b.linkUrl).filter(Boolean)
      ];
      replyText = this.ragJev.sanitizeOutputUrls(rawReply, allowedUrls);
    }

    replyText = this.antiBan.applyMicroVariation(replyText);

    const buttons = normalizeX1Buttons(settings.x1_buttons_json);
    const shouldSendAudio = this.decideAudioReply(settings, hadAudio, humanCheckpoint);
    const audioMode = settings.x1_audio_reply_mode || 'mirror';
    let usedAudio = false;

    await this.antiBan.enqueueSend('x1', jid, replyText, async () => {
      if (shouldSendAudio) {
        try {
          const oggBuffer = await this.voice.synthesizeToOggOpus(replyText, settings);
          if (adapter.sendPresence) {
            await adapter.sendPresence(
              jid,
              'recording',
              Math.min(12000, Math.max(2000, replyText.length * 40))
            );
          }
          const audioMsgId = await adapter.sendAudio(jid, oggBuffer);
          if (audioMsgId) this.db.recordBotSentId(audioMsgId);
          usedAudio = true;

          // In hybrid mode, also send the clickable text/link right after the voice note
          if (audioMode === 'hybrid' && !humanCheckpoint) {
            const linkFollowup =
              jev.topItem?.affiliate_url ||
              buttons[0]?.linkUrl ||
              '';
            const textPayload =
              adapter.channelName === 'baileys'
                ? `${linkFollowup ? `Link oficial: ${linkFollowup}` : ''}${formatNumberedOptions(buttons)}`.trim()
                : replyText;
            if (textPayload) {
              const txtId = await adapter.sendText(
                jid,
                textPayload,
                adapter.channelName === 'cloud_api' ? buttons : undefined
              );
              if (txtId) this.db.recordBotSentId(txtId);
            }
          }
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.db.addLog(
            'warn',
            'voice',
            `Fallback automatico para texto ao responder ${jid} (TTS falhou).`,
            msg
          );
        }
      }

      if (adapter.sendPresence) {
        await adapter.sendPresence(
          jid,
          'composing',
          Math.min(10000, Math.max(1500, replyText.length * 30))
        );
      }
      const finalText =
        adapter.channelName === 'baileys' && !humanCheckpoint
          ? `${replyText}${formatNumberedOptions(buttons)}`
          : replyText;
      const sentId = await adapter.sendText(
        jid,
        finalText,
        adapter.channelName === 'cloud_api' && !humanCheckpoint ? buttons : undefined
      );
      if (sentId) this.db.recordBotSentId(sentId);
    });

    this.db.appendX1Message(jid, 'assistant', replyText);
    if (humanCheckpoint) {
      const takeoverMin =
        Number.parseInt(settings.human_takeover_minutes || '30', 10) || 30;
      const threshold = settings.jev_threshold || '0.65';
      this.db.pauseContact(
        jid,
        takeoverMin,
        `Jev Checkpoint (score ${jev.topScore} < ${threshold})`,
        true
      );
    }
    return { replyText, usedAudio, humanCheckpoint };
  }

  private decideAudioReply(
    settings: HubSettings,
    hadAudio: boolean,
    humanCheckpoint: boolean
  ): boolean {
    if (humanCheckpoint) return false;
    const mode = settings.x1_audio_reply_mode || 'mirror';
    if (mode === 'never') return false;
    if (mode === 'always' || mode === 'hybrid') return true;
    return hadAudio;
  }
}
