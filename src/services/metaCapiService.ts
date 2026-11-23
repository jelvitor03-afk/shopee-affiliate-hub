import crypto from 'node:crypto';

export interface MetaCapiCredentials {
  pixelId: string;
  capiToken: string;
  testEventCode?: string;
  graphBaseUrl: string;
}

export interface MetaPurchaseInput {
  orderId: string;
  eventTimeSec: number;
  value: number;
  currency?: string;
  eventSourceUrl?: string;
  fbc?: string | null;
  fbp?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  itemIds?: string[];
}

export interface MetaCapiResult {
  ok: boolean;
  status: number;
  eventsReceived: number;
  fbtraceId?: string;
  raw: string;
}

function sha256Lower(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value.trim().toLowerCase(), 'utf8')
    .digest('hex');
}

export class MetaCapiService {
  async sendPurchaseEvent(
    creds: MetaCapiCredentials,
    input: MetaPurchaseInput
  ): Promise<MetaCapiResult> {
    if (!creds.pixelId || !creds.capiToken) {
      throw new Error('Meta Pixel ID and CAPI Token are required.');
    }

    const userData: Record<string, unknown> = {
      country: [sha256Lower('br')]
    };
    if (input.fbc) userData.fbc = input.fbc;
    if (input.fbp) userData.fbp = input.fbp;
    if (input.clientIp) userData.client_ip_address = input.clientIp;
    if (input.userAgent) userData.client_user_agent = input.userAgent;

    const customData: Record<string, unknown> = {
      currency: input.currency || 'BRL',
      value: Number(input.value.toFixed(2)),
      order_id: input.orderId
    };
    if (input.itemIds && input.itemIds.length > 0) {
      customData.content_ids = input.itemIds;
      customData.content_type = 'product';
    }

    const eventPayload: Record<string, unknown> = {
      event_name: 'Purchase',
      event_time: Math.floor(input.eventTimeSec),
      event_id: input.orderId,
      action_source: 'website',
      user_data: userData,
      custom_data: customData
    };
    if (input.eventSourceUrl) {
      eventPayload.event_source_url = input.eventSourceUrl;
    }

    const body: Record<string, unknown> = {
      data: [eventPayload]
    };
    if (creds.testEventCode?.trim()) {
      body.test_event_code = creds.testEventCode.trim();
    }

    const base = creds.graphBaseUrl.replace(/\/+$/, '');
    const url = `${base}/${encodeURIComponent(creds.pixelId)}/events?access_token=${encodeURIComponent(creds.capiToken)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });

    const rawText = await response.text();
    let parsed: { events_received?: number; fbtrace_id?: string; error?: { message?: string } } = {};
    try {
      parsed = JSON.parse(rawText) as typeof parsed;
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      const errorMsg = parsed.error?.message || rawText.slice(0, 250);
      throw new Error(`Meta CAPI HTTP ${response.status}: ${errorMsg}`);
    }

    return {
      ok: true,
      status: response.status,
      eventsReceived: parsed.events_received ?? 1,
      fbtraceId: parsed.fbtrace_id,
      raw: rawText
    };
  }
}
