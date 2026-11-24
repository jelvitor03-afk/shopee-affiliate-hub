export type MetaDatePreset = 'today' | 'yesterday' | 'last_7d' | 'maximum';

export interface MetaAdsCredentials {
  adAccountId: string;
  marketingToken: string;
  graphBaseUrl: string;
}

export interface MetaCampaignInsightRow {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  dailyBudget: number;
  spend: number;
  clicks: number;
  linkClicks: number;
  cpc: number;
  ctr: number;
  impressions: number;
}

export function normalizeAdAccountId(raw: string): string {
  const clean = raw.trim();
  if (!clean) return '';
  return clean.startsWith('act_') ? clean : `act_${clean}`;
}

export class MetaAdsService {
  async fetchCampaignInsights(
    creds: MetaAdsCredentials,
    datePreset: MetaDatePreset = 'today'
  ): Promise<MetaCampaignInsightRow[]> {
    const accountId = normalizeAdAccountId(creds.adAccountId);
    if (!accountId || !creds.marketingToken) {
      throw new Error('Meta Ad Account ID e Marketing Token sao obrigatorios.');
    }

    const base = creds.graphBaseUrl.replace(/\/+$/, '');
    const fields = `id,name,status,daily_budget,insights.date_preset(${datePreset}){spend,clicks,inline_link_clicks,cpc,ctr,impressions}`;
    const url = `${base}/${encodeURIComponent(accountId)}/campaigns?fields=${encodeURIComponent(
      fields
    )}&limit=100&access_token=${encodeURIComponent(creds.marketingToken)}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Meta Marketing API HTTP ${res.status}: ${raw.slice(0, 260)}`);
    }

    const parsed = JSON.parse(raw) as {
      data?: Array<{
        id: string;
        name: string;
        status?: string;
        daily_budget?: string;
        insights?: {
          data?: Array<{
            spend?: string;
            clicks?: string;
            inline_link_clicks?: string;
            cpc?: string;
            ctr?: string;
            impressions?: string;
          }>;
        };
      }>;
    };

    return (parsed.data ?? []).map((row) => {
      const insight = row.insights?.data?.[0];
      const budgetCents = Number.parseFloat(row.daily_budget || '0');
      const spend = Number.parseFloat(insight?.spend || '0');
      const clicks = Number.parseInt(insight?.clicks || '0', 10);
      const linkClicks = Number.parseInt(
        insight?.inline_link_clicks || insight?.clicks || '0',
        10
      );
      const impressions = Number.parseInt(insight?.impressions || '0', 10);
      const cpcRaw = Number.parseFloat(insight?.cpc || '0');
      const ctrRaw = Number.parseFloat(insight?.ctr || '0');

      const cpc =
        Number.isFinite(cpcRaw) && cpcRaw > 0
          ? cpcRaw
          : linkClicks > 0
          ? spend / linkClicks
          : 0;
      const ctr =
        Number.isFinite(ctrRaw) && ctrRaw > 0
          ? ctrRaw
          : impressions > 0
          ? (clicks / impressions) * 100
          : 0;

      return {
        id: row.id,
        name: row.name,
        status: row.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
        dailyBudget: Number.isFinite(budgetCents)
          ? Number((budgetCents / 100).toFixed(2))
          : 0,
        spend: Number.isFinite(spend) ? Number(spend.toFixed(2)) : 0,
        clicks: Number.isFinite(clicks) ? clicks : 0,
        linkClicks: Number.isFinite(linkClicks) ? linkClicks : 0,
        cpc: Number(cpc.toFixed(2)),
        ctr: Number(ctr.toFixed(2)),
        impressions: Number.isFinite(impressions) ? impressions : 0
      };
    });
  }

  async setCampaignStatus(
    creds: MetaAdsCredentials,
    campaignId: string,
    status: 'ACTIVE' | 'PAUSED'
  ): Promise<void> {
    if (!creds.marketingToken) {
      throw new Error('Meta Marketing Token nao configurado.');
    }
    const base = creds.graphBaseUrl.replace(/\/+$/, '');
    const url = `${base}/${encodeURIComponent(campaignId)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        access_token: creds.marketingToken
      }),
      signal: AbortSignal.timeout(15000)
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Erro ao atualizar status na Meta (${res.status}): ${raw.slice(0, 220)}`);
    }
  }

  async setCampaignDailyBudget(
    creds: MetaAdsCredentials,
    campaignId: string,
    budgetBrl: number
  ): Promise<void> {
    if (!creds.marketingToken) {
      throw new Error('Meta Marketing Token nao configurado.');
    }
    if (!Number.isFinite(budgetBrl) || budgetBrl < 1) {
      throw new Error('Orcamento diario invalido (minimo R$ 1,00).');
    }
    const base = creds.graphBaseUrl.replace(/\/+$/, '');
    const url = `${base}/${encodeURIComponent(campaignId)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        daily_budget: Math.round(budgetBrl * 100),
        access_token: creds.marketingToken
      }),
      signal: AbortSignal.timeout(15000)
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Erro ao atualizar orcamento na Meta (${res.status}): ${raw.slice(0, 220)}`);
    }
  }
}
