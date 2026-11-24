import { AppConfig } from '../config/env.js';
import { CampaignSubidLink, HubDatabase } from '../db/database.js';
import {
  MetaAdsService,
  MetaCampaignInsightRow,
  MetaDatePreset
} from './metaAdsService.js';
import {
  sanitizeSubId,
  ShopeeAffiliateClient,
  ShopeeCredentials
} from './shopeeAffiliateClient.js';

export interface RoiCampaignRow {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  dailyBudget: number;
  spend: number;
  sales: number;
  totalOrderValue: number;
  commission: number;
  profit: number;
  roas: number;
  clicks: number;
  linkClicks: number;
  cpc: number;
  ctr: number;
}

export interface RoiDashboardSummary {
  investment: number;
  totalCommission: number;
  profit: number;
  roas: number;
  totalOrders: number;
  adClicks: number;
  linkClicks: number;
  avgCpc: number;
}

export interface RoiDashboardResponse {
  isDemo: boolean;
  datePreset: MetaDatePreset;
  summary: RoiDashboardSummary;
  campaigns: RoiCampaignRow[];
  subidLinks: CampaignSubidLink[];
}

interface ShopeeCampaignStats {
  sales: number;
  totalOrderValue: number;
  commission: number;
}

const DEMO_CAMPAIGNS: Array<
  MetaCampaignInsightRow & { sales: number; totalOrderValue: number; commission: number }
> = [
  {
    id: 'demo_camp_1',
    name: 'Gerenciador Organizador CP3',
    status: 'ACTIVE',
    dailyBudget: 35,
    spend: 18.67,
    sales: 21,
    totalOrderValue: 1542.24,
    commission: 92.53,
    clicks: 412,
    linkClicks: 368,
    cpc: 0.05,
    ctr: 4.98,
    impressions: 8273
  },
  {
    id: 'demo_camp_2',
    name: 'Gerenciador Calca Skinny2 CP3',
    status: 'ACTIVE',
    dailyBudget: 23.46,
    spend: 19.51,
    sales: 19,
    totalOrderValue: 1179.43,
    commission: 77.89,
    clicks: 389,
    linkClicks: 344,
    cpc: 0.06,
    ctr: 5.45,
    impressions: 7137
  },
  {
    id: 'demo_camp_3',
    name: 'Gerenciador Conjuntos Lindos',
    status: 'ACTIVE',
    dailyBudget: 20,
    spend: 18.91,
    sales: 9,
    totalOrderValue: 916.7,
    commission: 61.11,
    clicks: 310,
    linkClicks: 280,
    cpc: 0.07,
    ctr: 5.2,
    impressions: 5961
  },
  {
    id: 'demo_camp_4',
    name: 'Gerenciador Luminaria Parede',
    status: 'ACTIVE',
    dailyBudget: 150,
    spend: 145.65,
    sales: 64,
    totalOrderValue: 2459,
    commission: 220.47,
    clicks: 1680,
    linkClicks: 1520,
    cpc: 0.1,
    ctr: 4.87,
    impressions: 34496
  },
  {
    id: 'demo_camp_5',
    name: 'Gerenciador Mini Impressora CP',
    status: 'PAUSED',
    dailyBudget: 20,
    spend: 19.58,
    sales: 4,
    totalOrderValue: 439.48,
    commission: 12.2,
    clicks: 245,
    linkClicks: 198,
    cpc: 0.1,
    ctr: 1.64,
    impressions: 14939
  }
];

function computeWindowEpochRange(datePreset: MetaDatePreset): {
  startSec: number;
  endSec: number;
} {
  const now = new Date();
  const endSec = Math.floor(now.getTime() / 1000);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  const todayStartSec = Math.floor(startOfToday.getTime() / 1000);

  if (datePreset === 'today') {
    return { startSec: todayStartSec, endSec };
  }
  if (datePreset === 'yesterday') {
    return { startSec: todayStartSec - 86400, endSec: todayStartSec - 1 };
  }
  if (datePreset === 'last_7d') {
    return { startSec: todayStartSec - 7 * 86400, endSec };
  }
  return { startSec: todayStartSec - 30 * 86400, endSec };
}

export function calculateCampaignMetrics(input: {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  dailyBudget: number;
  spend: number;
  sales: number;
  totalOrderValue: number;
  commission: number;
  clicks: number;
  linkClicks: number;
  impressions?: number;
  cpc?: number;
  ctr?: number;
}): RoiCampaignRow {
  const spend = Number.isFinite(input.spend) ? input.spend : 0;
  const commission = Number.isFinite(input.commission) ? input.commission : 0;
  const profit = Number((commission - spend).toFixed(2));
  const roas = spend > 0 ? Number((commission / spend).toFixed(2)) : 0;
  const cpc =
    input.cpc && input.cpc > 0
      ? Number(input.cpc.toFixed(2))
      : input.linkClicks > 0
      ? Number((spend / input.linkClicks).toFixed(2))
      : 0;
  const ctr =
    input.ctr && input.ctr > 0
      ? Number(input.ctr.toFixed(2))
      : input.impressions && input.impressions > 0
      ? Number(((input.clicks / input.impressions) * 100).toFixed(2))
      : 0;

  return {
    id: input.id,
    name: input.name,
    status: input.status,
    dailyBudget: Number(input.dailyBudget.toFixed(2)),
    spend: Number(spend.toFixed(2)),
    sales: input.sales,
    totalOrderValue: Number(input.totalOrderValue.toFixed(2)),
    commission: Number(commission.toFixed(2)),
    profit,
    roas,
    clicks: input.clicks,
    linkClicks: input.linkClicks,
    cpc,
    ctr
  };
}

export class CampaignDashboardService {
  constructor(
    private readonly db: HubDatabase,
    private readonly config: AppConfig,
    private readonly metaAds: MetaAdsService,
    private readonly shopee: ShopeeAffiliateClient
  ) {}

  async createCampaignTrackedLink(input: {
    campaignId: string;
    campaignName: string;
    productUrl: string;
  }): Promise<CampaignSubidLink> {
    const cleanSubId = sanitizeSubId(input.campaignId);
    if (!cleanSubId) {
      throw new Error('ID ou tag da campanha precisa ter letras ou numeros.');
    }

    const settings = this.db.getAllSettings();
    let shortLink = input.productUrl.trim();

    if (settings.shopee_app_id && settings.shopee_secret) {
      const creds: ShopeeCredentials = {
        appId: settings.shopee_app_id,
        secret: settings.shopee_secret,
        graphqlUrl: settings.shopee_graphql_url
      };
      shortLink = await this.shopee.generateShortLink(creds, {
        originUrl: input.productUrl.trim(),
        subIds: [cleanSubId]
      });
    } else {
      const sep = shortLink.includes('?') ? '&' : '?';
      shortLink = `${shortLink}${sep}sub_id1=${encodeURIComponent(cleanSubId)}`;
    }

    const saved = this.db.upsertCampaignSubidLink({
      subId: cleanSubId,
      campaignId: input.campaignId.trim(),
      campaignName: input.campaignName.trim() || input.campaignId.trim(),
      productUrl: input.productUrl.trim(),
      shortLink
    });

    this.db.addLog(
      'info',
      'campaigns',
      `Link Shopee criado para campanha ${saved.campaign_name} (sub_id: ${saved.sub_id}).`
    );
    return saved;
  }

  private async fetchShopeeStatsBySubId(
    creds: ShopeeCredentials,
    datePreset: MetaDatePreset
  ): Promise<Map<string, ShopeeCampaignStats>> {
    const map = new Map<string, ShopeeCampaignStats>();
    const { startSec, endSec } = computeWindowEpochRange(datePreset);
    let scrollId: string | null = null;

    for (let page = 0; page < 5; page++) {
      const report = await this.shopee.fetchConversionReport(creds, {
        purchaseTimeStart: startSec,
        purchaseTimeEnd: endSec,
        limit: 50,
        scrollId
      });

      for (const node of report.nodes) {
        const subParts = (node.utmContent || '')
          .split('-')
          .map((p) => sanitizeSubId(p.toLowerCase()))
          .filter(Boolean);
        const key = subParts[0];
        if (!key) continue;

        const existing = map.get(key) ?? {
          sales: 0,
          totalOrderValue: 0,
          commission: 0
        };

        for (const order of node.orders ?? []) {
          const st = (order.orderStatus || '').toUpperCase();
          if (st === 'CANCELLED' || st === 'INVALID') continue;

          existing.sales += 1;
          for (const item of order.items ?? []) {
            const p = Number.parseFloat(item.itemPrice || '0');
            const q = item.qty || 1;
            const c = Number.parseFloat(item.itemTotalCommission || '0');
            if (Number.isFinite(p)) existing.totalOrderValue += p * q;
            if (Number.isFinite(c)) existing.commission += c;
          }
          if (!order.items?.length) {
            const totalC = Number.parseFloat(node.totalCommission || '0');
            if (Number.isFinite(totalC)) existing.commission += totalC;
          }
        }
        map.set(key, existing);
      }

      if (!report.pageInfo.hasNextPage || !report.pageInfo.scrollId) break;
      scrollId = report.pageInfo.scrollId;
    }

    return map;
  }

  async getRoiDashboard(
    datePreset: MetaDatePreset = 'today',
    forceDemo?: boolean
  ): Promise<RoiDashboardResponse> {
    const settings = this.db.getAllSettings();
    const hasMeta = Boolean(
      settings.meta_ad_account_id && settings.meta_marketing_token
    );
    const useDemo =
      forceDemo ?? (settings.campaigns_demo_mode === 'true' || !hasMeta);

    const subidLinks = this.db.listCampaignSubidLinks();

    if (useDemo) {
      const overrides = new Map(
        this.db
          .listDemoCampaignOverrides()
          .map((o) => [o.campaign_id, o])
      );
      const scale =
        datePreset === 'last_7d' ? 4.5 : datePreset === 'yesterday' ? 0.85 : 1;

      const campaigns = DEMO_CAMPAIGNS.map((d) => {
        const ov = overrides.get(d.id);
        return calculateCampaignMetrics({
          ...d,
          status: ov?.status ?? d.status,
          dailyBudget: ov?.daily_budget ?? d.dailyBudget,
          spend: d.spend * scale,
          sales: Math.round(d.sales * scale),
          totalOrderValue: d.totalOrderValue * scale,
          commission: d.commission * scale,
          clicks: Math.round(d.clicks * scale),
          linkClicks: Math.round(d.linkClicks * scale)
        });
      });

      return {
        isDemo: true,
        datePreset,
        summary: this.computeSummary(campaigns),
        campaigns,
        subidLinks
      };
    }

    const metaRows = await this.metaAds.fetchCampaignInsights(
      {
        adAccountId: settings.meta_ad_account_id,
        marketingToken: settings.meta_marketing_token,
        graphBaseUrl: this.config.metaGraphBaseUrl
      },
      datePreset
    );

    let shopeeMap = new Map<string, ShopeeCampaignStats>();
    if (settings.shopee_app_id && settings.shopee_secret) {
      shopeeMap = await this.fetchShopeeStatsBySubId(
        {
          appId: settings.shopee_app_id,
          secret: settings.shopee_secret,
          graphqlUrl: settings.shopee_graphql_url
        },
        datePreset
      );
    }

    // Build lookup from campaignId -> associated sub_ids
    const subIdsByCampaign = new Map<string, string[]>();
    for (const link of subidLinks) {
      const list = subIdsByCampaign.get(link.campaign_id) ?? [];
      list.push(sanitizeSubId(link.sub_id.toLowerCase()));
      subIdsByCampaign.set(link.campaign_id, list);
    }

    const campaigns = metaRows.map((m) => {
      const candidates = new Set<string>([
        sanitizeSubId(m.id.toLowerCase()),
        sanitizeSubId(m.name.toLowerCase()),
        ...(subIdsByCampaign.get(m.id) ?? [])
      ]);

      let sales = 0;
      let totalOrderValue = 0;
      let commission = 0;
      for (const key of candidates) {
        const st = shopeeMap.get(key);
        if (st) {
          sales += st.sales;
          totalOrderValue += st.totalOrderValue;
          commission += st.commission;
        }
      }

      return calculateCampaignMetrics({
        ...m,
        sales,
        totalOrderValue,
        commission
      });
    });

    return {
      isDemo: false,
      datePreset,
      summary: this.computeSummary(campaigns),
      campaigns,
      subidLinks
    };
  }

  async toggleCampaignStatus(
    campaignId: string,
    status: 'ACTIVE' | 'PAUSED'
  ): Promise<{ isDemo: boolean }> {
    const settings = this.db.getAllSettings();
    const isDemo =
      settings.campaigns_demo_mode === 'true' ||
      !settings.meta_ad_account_id ||
      !settings.meta_marketing_token;

    if (isDemo || campaignId.startsWith('demo_')) {
      const base = DEMO_CAMPAIGNS.find((d) => d.id === campaignId);
      const currentOv = this.db
        .listDemoCampaignOverrides()
        .find((o) => o.campaign_id === campaignId);
      const budget = currentOv?.daily_budget ?? base?.dailyBudget ?? 20;
      this.db.upsertDemoCampaignOverride(campaignId, status, budget);
      return { isDemo: true };
    }

    await this.metaAds.setCampaignStatus(
      {
        adAccountId: settings.meta_ad_account_id,
        marketingToken: settings.meta_marketing_token,
        graphBaseUrl: this.config.metaGraphBaseUrl
      },
      campaignId,
      status
    );
    this.db.addLog(
      'info',
      'campaigns',
      `Status da campanha ${campaignId} alterado para ${status}.`
    );
    return { isDemo: false };
  }

  async updateCampaignBudget(
    campaignId: string,
    dailyBudgetBrl: number
  ): Promise<{ isDemo: boolean }> {
    const settings = this.db.getAllSettings();
    const isDemo =
      settings.campaigns_demo_mode === 'true' ||
      !settings.meta_ad_account_id ||
      !settings.meta_marketing_token;

    if (isDemo || campaignId.startsWith('demo_')) {
      const base = DEMO_CAMPAIGNS.find((d) => d.id === campaignId);
      const currentOv = this.db
        .listDemoCampaignOverrides()
        .find((o) => o.campaign_id === campaignId);
      const status = currentOv?.status ?? base?.status ?? 'ACTIVE';
      this.db.upsertDemoCampaignOverride(campaignId, status, dailyBudgetBrl);
      return { isDemo: true };
    }

    await this.metaAds.setCampaignDailyBudget(
      {
        adAccountId: settings.meta_ad_account_id,
        marketingToken: settings.meta_marketing_token,
        graphBaseUrl: this.config.metaGraphBaseUrl
      },
      campaignId,
      dailyBudgetBrl
    );
    this.db.addLog(
      'info',
      'campaigns',
      `Orcamento diario da campanha ${campaignId} atualizado para R$ ${dailyBudgetBrl.toFixed(2)}.`
    );
    return { isDemo: false };
  }

  private computeSummary(campaigns: RoiCampaignRow[]): RoiDashboardSummary {
    const investment = campaigns.reduce((s, c) => s + c.spend, 0);
    const totalCommission = campaigns.reduce((s, c) => s + c.commission, 0);
    const profit = totalCommission - investment;
    const roas = investment > 0 ? totalCommission / investment : 0;
    const totalOrders = campaigns.reduce((s, c) => s + c.sales, 0);
    const adClicks = campaigns.reduce((s, c) => s + c.clicks, 0);
    const linkClicks = campaigns.reduce((s, c) => s + c.linkClicks, 0);
    const avgCpc = linkClicks > 0 ? investment / linkClicks : 0;

    return {
      investment: Number(investment.toFixed(2)),
      totalCommission: Number(totalCommission.toFixed(2)),
      profit: Number(profit.toFixed(2)),
      roas: Number(roas.toFixed(2)),
      totalOrders,
      adClicks,
      linkClicks,
      avgCpc: Number(avgCpc.toFixed(2))
    };
  }
}
