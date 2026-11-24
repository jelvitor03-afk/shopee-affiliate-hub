import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WASocket,
  WAMessage
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { AppConfig } from '../config/env.js';
import { HubDatabase } from '../db/database.js';
import { AiService } from './aiService.js';
import { AntiBanService } from './antiBanService.js';
import {
  ProductOfferNode,
  sanitizeSubId,
  ShopeeAffiliateClient,
  ShopeeCredentials
} from './shopeeAffiliateClient.js';
import { X1ChannelAdapter, X1Orchestrator } from './x1Orchestrator.js';

export type BaileysStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

export interface GroupInfo {
  id: string;
  subject: string;
  size: number;
}

export interface BaileysStateSnapshot {
  status: BaileysStatus;
  qrDataUrl: string | null;
  connectedPhone: string | null;
  lastError: string | null;
}

export interface DispatchOfferResult {
  sent: boolean;
  reason?: string;
  itemId?: string;
  productName?: string;
  shortLink?: string;
  groupJid?: string;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTextFromBaileysMessage(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

export class BaileysGroupService {
  private socket: WASocket | null = null;
  private status: BaileysStatus = 'disconnected';
  private qrDataUrl: string | null = null;
  private connectedPhone: string | null = null;
  private lastError: string | null = null;
  private isShuttingDown = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly authDir: string;

  constructor(
    private readonly db: HubDatabase,
    private readonly config: AppConfig,
    private readonly shopee: ShopeeAffiliateClient,
    private readonly ai: AiService,
    private readonly antiBan: AntiBanService,
    private readonly x1: X1Orchestrator
  ) {
    this.authDir = path.join(config.dataDir, 'baileys_auth');
  }

  getSnapshot(): BaileysStateSnapshot {
    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      connectedPhone: this.connectedPhone,
      lastError: this.lastError
    };
  }

  autoStartIfAuthenticated(): void {
    const credsPath = path.join(this.authDir, 'creds.json');
    if (fs.existsSync(credsPath)) {
      void this.connect().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.db.addLog('warn', 'baileys', 'Falha ao reconectar sessao salva.', msg);
      });
    }
  }

  async connect(): Promise<BaileysStateSnapshot> {
    if (this.status === 'connected' && this.socket) {
      return this.getSnapshot();
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return this.getSnapshot();
    }

    this.isShuttingDown = false;
    this.lastError = null;
    this.status = 'connecting';

    this.connectPromise = this.initSocket().finally(() => {
      this.connectPromise = null;
    });

    await this.connectPromise;
    return this.getSnapshot();
  }

  private buildBaileysX1Adapter(): X1ChannelAdapter {
    return {
      channelName: 'baileys',
      sendPresence: async (jid, presence, durationMs) => {
        if (!this.socket) return;
        await sleep(this.config.antibanReadDelayMs);
        await this.socket.sendPresenceUpdate('available');
        await this.socket.sendPresenceUpdate(presence, jid);
        await sleep(this.config.antibanMinDelayMs > 0 ? durationMs : 0);
      },
      sendText: async (jid, text) => {
        if (!this.socket || this.status !== 'connected') {
          throw new Error('WhatsApp Baileys nao esta conectado.');
        }
        const sent = await this.socket.sendMessage(jid, { text });
        await this.socket.sendPresenceUpdate('paused', jid);
        return sent?.key?.id ?? undefined;
      },
      sendAudio: async (jid, oggOpusBuffer) => {
        if (!this.socket || this.status !== 'connected') {
          throw new Error('WhatsApp Baileys nao esta conectado.');
        }
        const sent = await this.socket.sendMessage(jid, {
          audio: oggOpusBuffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
        await this.socket.sendPresenceUpdate('paused', jid);
        return sent?.key?.id ?? undefined;
      }
    };
  }

  async handleMessagesUpsert(
    messages: WAMessage[],
    type: string,
    adapterOverride?: X1ChannelAdapter,
    debounceMsOverride?: number
  ): Promise<void> {
    if (type !== 'notify') return;

    const settings = this.db.getAllSettings();
    if (settings.x1_enabled !== 'true' || settings.x1_channel !== 'baileys') {
      return;
    }

    const adapter = adapterOverride ?? this.buildBaileysX1Adapter();

    for (const msg of messages) {
      const jid = msg.key?.remoteJid;
      const msgId = msg.key?.id;
      if (!jid || !msgId) continue;

      // Ignore groups, status broadcasts, and newsletters for private X1
      if (
        jid.endsWith('@g.us') ||
        jid === 'status@broadcast' ||
        jid.endsWith('@newsletter')
      ) {
        continue;
      }

      if (msg.key.fromMe) {
        this.x1.handleFromMeCheck(jid, msgId);
        continue;
      }

      if (this.socket) {
        try {
          await this.socket.readMessages([msg.key]);
        } catch {
          // Ignore read receipt failures
        }
      }

      let audioBuffer: Buffer | undefined;
      let audioMime: string | undefined;
      if (msg.message?.audioMessage && this.socket) {
        try {
          audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
          audioMime = msg.message.audioMessage.mimetype || 'audio/ogg';
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.db.addLog(
            'warn',
            'baileys',
            `Nao foi possivel baixar audio de ${jid}`,
            errMsg
          );
        }
      }

      const text = extractTextFromBaileysMessage(msg);
      await this.x1.handleInboundQueued(
        {
          jid,
          messageId: msgId,
          fromMe: false,
          text,
          audioBuffer,
          audioMime,
          debounceMsOverride
        },
        adapter
      );
    }
  }

  private async initSocket(): Promise<void> {
    fs.mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    this.socket = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', (event) => {
      void this.handleMessagesUpsert(event.messages, event.type).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.db.addLog('error', 'baileys', 'Erro ao processar mensagem X1.', msg);
      });
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
          this.status = 'qr';
          this.lastError = null;
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (connection === 'open') {
        this.status = 'connected';
        this.qrDataUrl = null;
        this.lastError = null;
        this.connectedPhone =
          sock.user?.id?.split(':')[0] ?? sock.user?.id ?? null;
        this.db.addLog(
          'info',
          'baileys',
          `WhatsApp conectado com sucesso (${this.connectedPhone || 'sessao ativa'}).`
        );
      }

      if (connection === 'close') {
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        this.socket = null;
        this.connectedPhone = null;

        if (this.isShuttingDown) {
          this.status = 'disconnected';
          return;
        }

        if (loggedOut) {
          this.status = 'disconnected';
          this.qrDataUrl = null;
          this.lastError =
            'Sessao desconectada no celular. Gere um novo QR Code.';
          this.db.addLog('warn', 'baileys', this.lastError);
          fs.rmSync(this.authDir, { recursive: true, force: true });
        } else {
          this.status = 'connecting';
          this.lastError = `Conexao caiu (codigo ${statusCode ?? 'desconhecido'}). Reconectando...`;
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            if (!this.isShuttingDown) {
              void this.connect();
            }
          }, 4000);
        }
      }
    });
  }

  async logout(): Promise<void> {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        await this.socket.logout();
      } catch {
        // Ignore logout socket race
      }
      try {
        this.socket.end(undefined);
      } catch {
        // Ignore end error
      }
      this.socket = null;
    }
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.status = 'disconnected';
    this.qrDataUrl = null;
    this.connectedPhone = null;
    this.lastError = null;
    this.db.addLog('info', 'baileys', 'Sessao do WhatsApp encerrada manualmente.');
  }

  async listGroups(): Promise<GroupInfo[]> {
    if (!this.socket || this.status !== 'connected') {
      throw new Error(
        'WhatsApp ainda nao esta conectado. Escaneie o QR Code primeiro.'
      );
    }
    const groupsMap = await this.socket.groupFetchAllParticipating();
    return Object.values(groupsMap)
      .map((g) => ({
        id: g.id,
        subject: g.subject || g.id,
        size: g.size ?? g.participants?.length ?? 0
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR'));
  }

  async dispatchNextOffer(
    options: { ignoreScheduleWindow?: boolean } = {}
  ): Promise<DispatchOfferResult> {
    const settings = this.db.getAllSettings();
    const groupJid = settings.whatsapp_group_jid.trim();

    if (!groupJid) {
      return { sent: false, reason: 'ID do grupo de WhatsApp nao configurado.' };
    }
    if (!this.socket || this.status !== 'connected') {
      return {
        sent: false,
        reason: 'WhatsApp do grupo ainda nao esta conectado.'
      };
    }
    if (!settings.shopee_app_id || !settings.shopee_secret) {
      return {
        sent: false,
        reason: 'AppId e Secret da Shopee nao configurados.'
      };
    }

    const canSend = this.antiBan.checkCanSend('group', groupJid);
    if (!canSend.allowed) {
      return { sent: false, reason: canSend.reason };
    }

    if (!options.ignoreScheduleWindow) {
      const hour = new Date().getHours();
      const startHour = Number.parseInt(
        settings.group_active_start_hour || '8',
        10
      );
      const endHour = Number.parseInt(settings.group_active_end_hour || '22', 10);
      if (hour < startHour || hour > endHour) {
        return {
          sent: false,
          reason: `Fora do horario ativo configurado (${startHour}h as ${endHour}h).`
        };
      }
    }

    const keywords = settings.shopee_keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const chosenKeyword =
      keywords.length > 0
        ? keywords[Math.floor(Math.random() * keywords.length)]!
        : 'oferta relampago';

    const creds: ShopeeCredentials = {
      appId: settings.shopee_app_id,
      secret: settings.shopee_secret,
      graphqlUrl: settings.shopee_graphql_url
    };

    const offers = await this.shopee.fetchProductOffers(creds, {
      keyword: chosenKeyword,
      page: 1,
      limit: 20,
      sortType: 2
    });

    const candidate: ProductOfferNode | undefined = offers.find(
      (offer) =>
        offer.itemId &&
        !this.db.hasDispatchedOffer(String(offer.itemId), groupJid)
    );

    if (!candidate) {
      this.db.addLog(
        'info',
        'achadinhos',
        `Nenhuma oferta inedita encontrada para "${chosenKeyword}".`
      );
      return {
        sent: false,
        reason: `Todas as ofertas recentes para "${chosenKeyword}" ja foram postadas.`
      };
    }

    let shortLink = candidate.offerLink || candidate.productLink;
    try {
      shortLink = await this.shopee.generateShortLink(creds, {
        originUrl: candidate.productLink || candidate.offerLink,
        subIds: ['grupo', sanitizeSubId(String(candidate.itemId))]
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.db.addLog(
        'warn',
        'achadinhos',
        'Falha ao encurtar link na Shopee; usando offerLink padrao.',
        msg
      );
    }

    const rawCaption = await this.ai.generateAchadinhoCopy(
      {
        provider: settings.ai_provider,
        baseUrl: settings.ai_base_url,
        apiKey: settings.ai_api_key,
        model: settings.ai_model,
        geminiBaseUrl: this.config.geminiBaseUrl,
        openaiBaseUrl: this.config.openaiBaseUrl
      },
      candidate,
      shortLink
    );
    const caption = this.antiBan.applyMicroVariation(rawCaption);

    await this.antiBan.enqueueSend('group', groupJid, caption, async () => {
      const sock = this.socket;
      if (!sock || this.status !== 'connected') {
        throw new Error('WhatsApp desconectado durante o envio.');
      }

      const minDelay = this.config.baileysDelayMinMs;
      const maxDelay = Math.max(minDelay, this.config.baileysDelayMaxMs);
      const delayMs =
        maxDelay > 0
          ? minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1))
          : 0;

      await sock.sendPresenceUpdate('available');
      await sock.sendPresenceUpdate('composing', groupJid);
      await sleep(delayMs);

      let sentMsg: WAMessage | undefined;
      if (candidate.imageUrl) {
        try {
          sentMsg = await sock.sendMessage(groupJid, {
            image: { url: candidate.imageUrl },
            caption
          });
        } catch {
          sentMsg = await sock.sendMessage(groupJid, { text: caption });
        }
      } else {
        sentMsg = await sock.sendMessage(groupJid, { text: caption });
      }
      if (sentMsg?.key?.id) {
        this.db.recordBotSentId(sentMsg.key.id);
      }

      await sock.sendPresenceUpdate('paused', groupJid);
    });

    this.db.recordDispatchedOffer({
      item_id: String(candidate.itemId),
      group_jid: groupJid,
      product_name: candidate.productName,
      short_link: shortLink,
      price: candidate.price || candidate.priceMin || ''
    });

    this.db.addLog(
      'info',
      'achadinhos',
      `Oferta enviada no grupo: ${candidate.productName.slice(0, 60)}`
    );

    return {
      sent: true,
      itemId: String(candidate.itemId),
      productName: candidate.productName,
      shortLink,
      groupJid
    };
  }

  shutdown(): void {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch {
        // Ignore shutdown errors
      }
      this.socket = null;
    }
    this.status = 'disconnected';
  }
}
