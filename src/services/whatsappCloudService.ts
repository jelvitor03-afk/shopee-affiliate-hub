import { AppConfig } from '../config/env.js';
import {
  HubDatabase,
  normalizeX1Buttons,
  X1ButtonConfig
} from '../db/database.js';
import { AiService } from './aiService.js';

interface WhatsAppWebhookMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
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
    private readonly ai: AiService
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

  private async postCloudMessage(
    phoneNumberId: string,
    accessToken: string,
    payload: Record<string, unknown>
  ): Promise<void> {
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
    const textBody = [btn.replyText, btn.linkUrl].filter(Boolean).join('\n\n').trim();

    if (hasHttpsUrl) {
      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: {
            text: (btn.replyText || 'Clique no botao abaixo para abrir a oferta oficial:').slice(
              0,
              1024
            )
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

      if (!settings.meta_whatsapp_token || !settings.meta_phone_number_id) {
        this.db.addLog(
          'warn',
          'x1',
          `Mensagem recebida de ${from}, mas token ou Phone Number ID da Meta ainda nao configurados.`
        );
        continue;
      }

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
            await this.postCloudMessage(
              settings.meta_phone_number_id,
              settings.meta_whatsapp_token,
              payload
            );
            this.db.appendX1Message(
              from,
              'assistant',
              `${matchedButton.replyText} ${matchedButton.linkUrl}`.trim()
            );
            summary.repliesSent++;
          }
          continue;
        }

        const userText = msg.text?.body?.trim() || '';
        if (!userText) continue;

        const history = this.db.getRecentX1History(from, 8);
        this.db.appendX1Message(from, 'user', userText);

        const aiReply = await this.ai.generateX1Reply(
          {
            provider: settings.ai_provider,
            apiKey: settings.ai_api_key,
            model: settings.ai_model,
            geminiBaseUrl: this.config.geminiBaseUrl,
            openaiBaseUrl: this.config.openaiBaseUrl
          },
          {
            systemPrompt: settings.x1_system_prompt,
            history,
            userMessage: userText
          }
        );

        const payload = this.buildInteractiveButtonsPayload(
          from,
          aiReply,
          buttons
        );
        await this.postCloudMessage(
          settings.meta_phone_number_id,
          settings.meta_whatsapp_token,
          payload
        );

        this.db.appendX1Message(from, 'assistant', aiReply);
        summary.repliesSent++;
        this.db.addLog(
          'info',
          'x1',
          `Resposta interativa enviada para ${from}.`
        );
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
