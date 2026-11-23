import crypto from 'node:crypto';
import { AppConfig } from '../config/env.js';
import { HubDatabase } from '../db/database.js';
import { MetaCapiService } from './metaCapiService.js';
import {
  extractClickIdFromUtmContent,
  sanitizeSubId,
  ShopeeAffiliateClient,
  ShopeeCredentials
} from './shopeeAffiliateClient.js';

export interface RedirectInput {
  slug: string;
  fbclid?: string;
  fbp?: string;
  fbc?: string;
  clientIp?: string;
  userAgent?: string;
  utmSource?: string;
  utmCampaign?: string;
}

export interface RedirectOutcome {
  clickId: string;
  redirectUrl: string;
  fbc: string | null;
}

export interface SyncConversionsSummary {
  checkedOrders: number;
  matchedClicks: number;
  sentToMeta: number;
  skippedDuplicate: number;
  skippedStatus: number;
  errors: number;
}

function appendFallbackSubId(destinationUrl: string, clickId: string): string {
  try {
    const parsed = new URL(destinationUrl);
    if (!parsed.searchParams.has('sub_id')) {
      parsed.searchParams.set('sub_id', clickId);
    }
    return parsed.toString();
  } catch {
    const sep = destinationUrl.includes('?') ? '&' : '?';
    return `${destinationUrl}${sep}sub_id=${encodeURIComponent(clickId)}`;
  }
}

export class TrackerService {
  constructor(
    private readonly db: HubDatabase,
    private readonly config: AppConfig,
    private readonly shopee: ShopeeAffiliateClient,
    private readonly metaCapi: MetaCapiService
  ) {}

  private getShopeeCredentials(): ShopeeCredentials {
    const settings = this.db.getAllSettings();
    return {
      appId: settings.shopee_app_id,
      secret: settings.shopee_secret,
      graphqlUrl: settings.shopee_graphql_url
    };
  }

  async handleGoRedirect(input: RedirectInput): Promise<RedirectOutcome | null> {
    const campaign = this.db.getCampaignLink(input.slug);
    if (!campaign) return null;

    const clickId = `clk${crypto.randomBytes(8).toString('hex')}`;
    const cleanFbclid = input.fbclid?.trim() || null;
    const cleanFbp = input.fbp?.trim() || null;
    const resolvedFbc =
      input.fbc?.trim() ||
      (cleanFbclid ? `fb.1.${Date.now()}.${cleanFbclid}` : null);

    let redirectUrl = appendFallbackSubId(campaign.destination_url, clickId);
    const creds = this.getShopeeCredentials();

    if (creds.appId && creds.secret) {
      try {
        const cleanSlug = sanitizeSubId(campaign.slug);
        const shortUrl = await this.shopee.generateShortLink(creds, {
          originUrl: campaign.destination_url,
          subIds: [clickId, cleanSlug].filter(Boolean)
        });
        redirectUrl = shortUrl;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.db.addLog(
          'warn',
          'tracker',
          `Falha ao gerar shortLink na Shopee para /go/${campaign.slug}; usando fallback direto.`,
          message
        );
      }
    }

    this.db.recordAdClick({
      click_id: clickId,
      slug: campaign.slug,
      fbclid: cleanFbclid,
      fbp: cleanFbp,
      fbc: resolvedFbc,
      client_ip: input.clientIp ?? null,
      user_agent: input.userAgent ?? null,
      utm_source: input.utmSource ?? null,
      utm_campaign: input.utmCampaign ?? null,
      short_url: redirectUrl
    });

    return {
      clickId,
      redirectUrl,
      fbc: resolvedFbc
    };
  }

  async syncConversionsNow(): Promise<SyncConversionsSummary> {
    const summary: SyncConversionsSummary = {
      checkedOrders: 0,
      matchedClicks: 0,
      sentToMeta: 0,
      skippedDuplicate: 0,
      skippedStatus: 0,
      errors: 0
    };

    const settings = this.db.getAllSettings();
    if (!settings.shopee_app_id || !settings.shopee_secret) {
      this.db.addLog(
        'info',
        'tracker',
        'Sincronizacao ignorada: AppId e Secret da Shopee ainda nao preenchidos.'
      );
      return summary;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - 72 * 3600;
    const creds: ShopeeCredentials = {
      appId: settings.shopee_app_id,
      secret: settings.shopee_secret,
      graphqlUrl: settings.shopee_graphql_url
    };

    const includeUnpaid = settings.capi_include_unpaid === 'true';
    const hasMeta = Boolean(settings.meta_pixel_id && settings.meta_capi_token);
    let scrollId: string | null = null;

    for (let page = 0; page < 5; page++) {
      const report = await this.shopee.fetchConversionReport(creds, {
        purchaseTimeStart: startSec,
        purchaseTimeEnd: nowSec,
        limit: 50,
        scrollId
      });

      for (const node of report.nodes) {
        const clickId = extractClickIdFromUtmContent(node.utmContent);
        const adClick = clickId ? this.db.getAdClick(clickId) : null;
        if (adClick) summary.matchedClicks++;

        for (const order of node.orders ?? []) {
          summary.checkedOrders++;
          const statusUpper = (order.orderStatus || '').toUpperCase();
          if (
            statusUpper === 'CANCELLED' ||
            statusUpper === 'INVALID' ||
            (!includeUnpaid && statusUpper === 'UNPAID')
          ) {
            summary.skippedStatus++;
            continue;
          }

          if (this.db.isConversionSent(order.orderId)) {
            summary.skippedDuplicate++;
            continue;
          }

          const items = order.items ?? [];
          let orderValue = items.reduce((acc, item) => {
            const price = Number.parseFloat(item.itemPrice || '0');
            const qty = item.qty || 1;
            return acc + (Number.isFinite(price) ? price * qty : 0);
          }, 0);

          if (orderValue <= 0 && adClick) {
            const camp = this.db.getCampaignLink(adClick.slug);
            if (camp && camp.default_value > 0) orderValue = camp.default_value;
          }
          if (orderValue <= 0) {
            const comm = Number.parseFloat(node.totalCommission || '0');
            orderValue = Number.isFinite(comm) && comm > 0 ? comm : 1;
          }

          if (!hasMeta) {
            this.db.upsertConversionRecord({
              order_id: order.orderId,
              conversion_id: node.conversionId,
              click_id: adClick?.click_id ?? clickId,
              order_status: statusUpper || 'PENDING',
              order_value: Number(orderValue.toFixed(2)),
              currency: 'BRL',
              capi_status: 'PENDING_META_KEYS',
              capi_response: 'Pixel ID ou CAPI Token ausentes'
            });
            continue;
          }

          try {
            const baseUrl =
              settings.public_base_url || this.config.publicBaseUrl;
            const eventSourceUrl = adClick
              ? `${baseUrl.replace(/\/+$/, '')}/go/${adClick.slug}`
              : baseUrl;

            const result = await this.metaCapi.sendPurchaseEvent(
              {
                pixelId: settings.meta_pixel_id,
                capiToken: settings.meta_capi_token,
                testEventCode: settings.meta_test_event_code,
                graphBaseUrl: this.config.metaGraphBaseUrl
              },
              {
                orderId: order.orderId,
                eventTimeSec: node.purchaseTime || nowSec,
                value: orderValue,
                currency: 'BRL',
                eventSourceUrl,
                fbc: adClick?.fbc ?? null,
                fbp: adClick?.fbp ?? null,
                clientIp: adClick?.client_ip ?? null,
                userAgent: adClick?.user_agent ?? null,
                itemIds: items.map((i) => String(i.itemId)).filter(Boolean)
              }
            );

            this.db.upsertConversionRecord({
              order_id: order.orderId,
              conversion_id: node.conversionId,
              click_id: adClick?.click_id ?? clickId,
              order_status: statusUpper || 'PENDING',
              order_value: Number(orderValue.toFixed(2)),
              currency: 'BRL',
              capi_status: 'SENT',
              capi_response: result.fbtraceId || result.raw.slice(0, 180)
            });
            summary.sentToMeta++;
          } catch (err) {
            summary.errors++;
            const msg = err instanceof Error ? err.message : String(err);
            this.db.upsertConversionRecord({
              order_id: order.orderId,
              conversion_id: node.conversionId,
              click_id: adClick?.click_id ?? clickId,
              order_status: statusUpper || 'PENDING',
              order_value: Number(orderValue.toFixed(2)),
              currency: 'BRL',
              capi_status: 'ERROR',
              capi_response: msg.slice(0, 240)
            });
            this.db.addLog(
              'error',
              'tracker',
              `Erro ao enviar Purchase para Meta CAPI (pedido ${order.orderId})`,
              msg
            );
          }
        }
      }

      if (!report.pageInfo.hasNextPage || !report.pageInfo.scrollId) {
        break;
      }
      scrollId = report.pageInfo.scrollId;
    }

    this.db.addLog(
      'info',
      'tracker',
      `Sync Shopee->Meta concluido: ${summary.sentToMeta} enviados, ${summary.skippedDuplicate} duplicados ignorados, ${summary.errors} erros.`
    );
    return summary;
  }
}
