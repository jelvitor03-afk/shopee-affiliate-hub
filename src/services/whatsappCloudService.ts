import crypto from 'node:crypto';
import { AppConfig } from '../config/env.js';
import {
  HubDatabase,
  normalizeX1Buttons,
  X1ButtonConfig
} from '../db/database.js';
import { AntiBanService } from './antiBanService.js';
import { VoiceService } from './voiceService.js';
import { X1ChannelAdapter, X1Orchestrator } from './x1Orchestrator.js';

interface WhatsAppWebhookMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
}

interface WhatsAppWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppWebhookMessage[];
      };
    }>;
  }>;
}

export interface WebhookProcessSummary {
  processed: number;
  ignoredDuplicate: number;
  repliesSent: number;
  errors: number;
}

export class WhatsAppCloudService {
  constructor(
    private readonly db: HubDatabase,
    private readonly config: AppConfig,
    private readonly voice: VoiceService,
    private readonly antiBan: AntiBanService,
    private readonly x1: X1Orchestrator
  ) {}

  verifyWebhook(
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined
  ): string | null {
    const verifyToken = this.db.getSetting('meta_webhook_verify_token');
    if (mode === 'subscribe' && token && token === verifyToken && challenge) {
      return challenge;
    }
    return null;
  }

  verifyWebhookSignature(
    rawBody: Buffer | undefined,
    signatureHeader: string | undefined
  ): boolean {
    const appSecret = this.db.getSetting('meta_app_secret').trim();
    if (!appSecret) {
      return true;
    }
    if (!rawBody || !signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }
    const providedHex = signatureHeader.slice('sha256='.length).trim().toLowerCase();
    const expectedHex = crypto
      .createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');
    if (providedHex.length !== expectedHex.length) {
      return false;
    }
    return crypto.timingSafeEqual(
      Buffer.from(providedHex, 'utf8'),
      Buffer.from(expectedHex, 'utf8')
    );
  }

  private async postCloudMessage(
    phoneNumberId: string,
    accessToken: string,
    payload: Record<string, unknown>
  ): Promise<string | undefined> {
    const base = this.config.metaGraphBaseUrl.replace(/\/+$/, '');
    const url = `${base}/${encodeURIComponent(phoneNumberId)}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`WhatsApp Cloud API HTTP ${res.status}: ${raw.slice(0, 260)}`);
    }
    try {
      const parsed = JSON.parse(raw) as { messages?: Array<{ id?: string }> };
      return parsed.messages?.[0]?.id;
    } catch {
      return undefined;
    }
  }

  private async downloadMediaBuffer(
    mediaId: string,
    accessToken: string
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const base = this.config.metaGraphBaseUrl.replace(/\/+$/, '');
    const metaRes = await fetch(`${base}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000)
    });
    if (!metaRes.ok) {
      throw new Error(`Meta media lookup HTTP ${metaRes.status}`);
    }
    const metaJson = (await metaRes.json()) as {
      url?: string;
      mime_type?: string;
    };
    if (!metaJson.url) {
      throw new Error('Meta media URL ausente.');
    }
    const binRes = await fetch(metaJson.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20000)
    });
    if (!binRes.ok) {
      throw new Error(`Meta media download HTTP ${binRes.status}`);
    }
    return {
      buffer: Buffer.from(await binRes.arrayBuffer()),
      mimeType: metaJson.mime_type || 'audio/ogg'
    };
  }

  private async uploadOggMedia(
    phoneNumberId: string,
    accessToken: string,
    oggBuffer: Buffer
  ): Promise<string> {
    const base = this.config.metaGraphBaseUrl.replace(/\/+$/, '');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'audio/ogg');
    form.append(
      'file',
      new Blob([new Uint8Array(oggBuffer)], { type: 'audio/ogg' }),
      'voice_reply.ogg'
    );

    const res = await fetch(`${base}/${encodeURIComponent(phoneNumberId)}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
      signal: AbortSignal.timeout(20000)
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Meta media upload HTTP ${res.status}: ${raw.slice(0, 200)}`);
    }
    const parsed = JSON.parse(raw) as { id?: string };
    if (!parsed.id) throw new Error('Meta media upload nao retornou id.');
    return parsed.id;
  }

  private buildInteractiveButtonsPayload(
    to: string,
    bodyText: string,
    buttons: X1ButtonConfig[]
  ): Record<string, unknown> {
    const safeButtons = buttons.slice(0, 3).map((btn, index) => ({
      type: 'reply',
      reply: {
        id: btn.id || `btn_${index + 1}`,
        title: (btn.title || `Opcao ${index + 1}`).trim().slice(0, 20)
      }
    }));

    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: bodyText.trim().slice(0, 1024)
        },
        action: {
          buttons: safeButtons
        }
      }
    };
  }

  private buildButtonClickPayload(
    to: string,
    btn: X1ButtonConfig
  ): Record<string, unknown> {
    const hasHttpsUrl = /^https?:\/\//i.test(btn.linkUrl.trim());
    const textBody = [btn.replyText, btn.linkUrl]
      .filter(Boolean)
      .join('\n\n')
      .trim();

    if (hasHttpsUrl) {
      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: {
            text: (
              btn.replyText ||
              'Clique no botao abaixo para abrir a oferta oficial:'
            ).slice(0, 1024)
          },
          action: {
            name: 'cta_url',
            parameters: {
              display_text: btn.title.slice(0, 20) || 'Abrir Link',
              url: btn.linkUrl.trim()
            }
          }
        }
      };
    }

    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: true,
        body: textBody.slice(0, 4096) || 'Link indisponivel no momento.'
      }
    };
  }

  async handleWebhookPayload(
    body: WhatsAppWebhookBody
  ): Promise<WebhookProcessSummary> {
    const summary: WebhookProcessSummary = {
      processed: 0,
      ignoredDuplicate: 0,
      repliesSent: 0,
      errors: 0
    };

    const settings = this.db.getAllSettings();
    const buttons = normalizeX1Buttons(settings.x1_buttons_json);

    const messages: WhatsAppWebhookMessage[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {
          messages.push(msg);
        }
      }
    }

    for (const msg of messages) {
      const msgId = msg.id?.trim();
      const from = msg.from?.trim();
      if (!msgId || !from) continue;

      if (!this.db.markWebhookProcessedIfNew(msgId)) {
        summary.ignoredDuplicate++;
        continue;
      }

      summary.processed++;

      if (settings.x1_enabled !== 'true') {
        continue;
      }

      if (!settings.meta_whatsapp_token || !settings.meta_phone_number_id) {
        this.db.addLog(
          'warn',
          'x1',
          `Mensagem recebida de ${from}, mas token ou Phone Number ID da Meta ainda nao configurados.`
        );
        continue;
      }

      if (this.db.isBlacklisted(from)) {
        continue;
      }

      this.db.touchInboundContact(from);

      const phoneNumberId = settings.meta_phone_number_id;
      const waToken = settings.meta_whatsapp_token;

      try {
        if (msg.type === 'interactive') {
          const clickedId =
            msg.interactive?.button_reply?.id ||
            msg.interactive?.list_reply?.id ||
            '';
          const matchedButton =
            buttons.find((b) => b.id === clickedId) ?? buttons[0];

          if (matchedButton) {
            this.db.appendX1Message(
              from,
              'user',
              `[Clique botao: ${matchedButton.title}]`
            );
            const payload = this.buildButtonClickPayload(from, matchedButton);
            await this.postCloudMessage(phoneNumberId, waToken, payload);
            this.db.appendX1Message(
              from,
              'assistant',
              `${matchedButton.replyText} ${matchedButton.linkUrl}`.trim()
            );
            summary.repliesSent++;
          }
          continue;
        }

        let userText = msg.text?.body?.trim() || '';
        let hadAudio = false;

        if (msg.type === 'audio' && msg.audio?.id) {
          if (settings.x1_listen_audio !== 'true') continue;
          hadAudio = true;
          const media = await this.downloadMediaBuffer(msg.audio.id, waToken);
          userText = await this.voice.transcribeAudio(
            media.buffer,
            msg.audio.mime_type || media.mimeType,
            settings
          );
        }

        if (!userText) continue;

        if (this.antiBan.isOptOutMessage(userText)) {
          this.db.addToBlacklist(from, `Opt-out: "${userText.slice(0, 40)}"`);
          await this.postCloudMessage(phoneNumberId, waToken, {
            messaging_product: 'whatsapp',
            to: from,
            type: 'text',
            text: {
              body: 'Tudo bem! Nao vamos mais te enviar mensagens por aqui.'
            }
          });
          summary.repliesSent++;
          continue;
        }

        const cloudAdapter: X1ChannelAdapter = {
          channelName: 'cloud_api',
          sendText: async (to, text, btns) => {
            const payload =
              btns && btns.length > 0
                ? this.buildInteractiveButtonsPayload(to, text, btns)
                : {
                    messaging_product: 'whatsapp',
                    to,
                    type: 'text',
                    text: { preview_url: true, body: text.slice(0, 4096) }
                  };
            return this.postCloudMessage(phoneNumberId, waToken, payload);
          },
          sendAudio: async (to, oggBuffer) => {
            const mediaId = await this.uploadOggMedia(
              phoneNumberId,
              waToken,
              oggBuffer
            );
            return this.postCloudMessage(phoneNumberId, waToken, {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to,
              type: 'audio',
              audio: { id: mediaId }
            });
          }
        };

        await this.x1.processResolvedTurn(from, userText, hadAudio, cloudAdapter);
        summary.repliesSent++;
      } catch (err) {
        summary.errors++;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.db.addLog(
          'error',
          'x1',
          `Erro ao responder lead ${from} no WhatsApp Cloud API.`,
          errMsg
        );
      }
    }

    return summary;
  }
}
