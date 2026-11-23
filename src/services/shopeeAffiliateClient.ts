import crypto from 'node:crypto';

export interface ShopeeCredentials {
  appId: string;
  secret: string;
  graphqlUrl: string;
}

export interface ProductOfferNode {
  itemId: string;
  productName: string;
  priceMin: string;
  priceMax: string;
  price: string;
  imageUrl: string;
  productLink: string;
  offerLink: string;
  commissionRate: string;
  commission: string;
  sales: number;
}

export interface ConversionOrderItem {
  itemId: string;
  itemName: string;
  itemPrice: string;
  qty: number;
  itemTotalCommission: string;
}

export interface ConversionOrder {
  orderId: string;
  orderStatus: string;
  items: ConversionOrderItem[];
}

export interface ConversionReportNode {
  conversionId: string;
  purchaseTime: number;
  clickTime: number;
  totalCommission: string;
  utmContent: string;
  orders: ConversionOrder[];
}

export interface ConversionReportPage {
  nodes: ConversionReportNode[];
  pageInfo: {
    limit: number;
    hasNextPage: boolean;
    scrollId: string | null;
  };
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: unknown }>;
}

/**
 * Shopee Affiliate Open API rejects non-alphanumeric characters in subIds on some regions.
 */
export function sanitizeSubId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

/**
 * Shopee concatenates subIds using "-" into utmContent (e.g. "clk1a2b3c4d----").
 */
export function extractClickIdFromUtmContent(
  utmContent: string | null | undefined
): string | null {
  if (!utmContent) return null;
  const directMatch = /clk[a-z0-9]{8,30}/i.exec(utmContent);
  if (directMatch) return directMatch[0];
  const parts = utmContent
    .split('-')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts[0] || null;
}

export function computeShopeeSignature(
  appId: string,
  timestampSec: number,
  payloadStr: string,
  secret: string
): string {
  const base = `${appId}${timestampSec}${payloadStr}${secret}`;
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex');
}

export function buildShopeeAuthHeader(
  appId: string,
  secret: string,
  payloadStr: string,
  timestampSec = Math.floor(Date.now() / 1000)
): string {
  const signature = computeShopeeSignature(appId, timestampSec, payloadStr, secret);
  return `SHA256 Credential=${appId},Timestamp=${timestampSec},Signature=${signature}`;
}

export class ShopeeAffiliateClient {
  private escapeGraphQlString(value: string): string {
    return JSON.stringify(value);
  }

  async executeGraphQl<T>(
    credentials: ShopeeCredentials,
    query: string
  ): Promise<T> {
    if (!credentials.appId || !credentials.secret) {
      throw new Error('Shopee Affiliate credentials (appId/secret) are not configured.');
    }
    const endpoint =
      credentials.graphqlUrl || 'https://open-api.affiliate.shopee.com.br/graphql';
    const payloadStr = JSON.stringify({ query });
    const authHeader = buildShopeeAuthHeader(
      credentials.appId,
      credentials.secret,
      payloadStr
    );

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader
      },
      body: payloadStr,
      signal: AbortSignal.timeout(15000)
    });

    const rawText = await response.text();
    let parsed: GraphQlResponse<T>;
    try {
      parsed = JSON.parse(rawText) as GraphQlResponse<T>;
    } catch {
      throw new Error(
        `Shopee GraphQL invalid JSON (HTTP ${response.status}): ${rawText.slice(0, 200)}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Shopee GraphQL HTTP ${response.status}: ${rawText.slice(0, 250)}`
      );
    }

    if (parsed.errors && parsed.errors.length > 0) {
      const msg = parsed.errors.map((e) => e.message || 'Unknown GraphQL error').join('; ');
      throw new Error(`Shopee GraphQL error: ${msg}`);
    }

    if (!parsed.data) {
      throw new Error('Shopee GraphQL response did not include data.');
    }

    return parsed.data;
  }

  async fetchProductOffers(
    credentials: ShopeeCredentials,
    params: {
      keyword?: string;
      page?: number;
      limit?: number;
      sortType?: number;
    } = {}
  ): Promise<ProductOfferNode[]> {
    const keyword = params.keyword?.trim() || '';
    const page = params.page ?? 1;
    const limit = params.limit ?? 15;
    const sortType = params.sortType ?? 2; // 2 = highest sales / relevance

    const args: string[] = [`page: ${page}`, `limit: ${limit}`, `sortType: ${sortType}`];
    if (keyword) {
      args.unshift(`keyword: ${this.escapeGraphQlString(keyword)}`);
    }

    const query = `query {
      productOfferV2(${args.join(', ')}) {
        nodes {
          itemId
          productName
          priceMin
          priceMax
          price
          imageUrl
          productLink
          offerLink
          commissionRate
          commission
          sales
        }
      }
    }`;

    const data = await this.executeGraphQl<{
      productOfferV2?: { nodes?: ProductOfferNode[] };
    }>(credentials, query);

    return data.productOfferV2?.nodes ?? [];
  }

  async generateShortLink(
    credentials: ShopeeCredentials,
    params: {
      originUrl: string;
      subIds?: string[];
    }
  ): Promise<string> {
    const cleanSubIds = (params.subIds ?? [])
      .map(sanitizeSubId)
      .filter(Boolean)
      .slice(0, 5);

    const subIdsPart =
      cleanSubIds.length > 0
        ? `, subIds: [${cleanSubIds.map((s) => this.escapeGraphQlString(s)).join(', ')}]`
        : '';

    const mutation = `mutation {
      generateShortLink(input: { originUrl: ${this.escapeGraphQlString(params.originUrl)}${subIdsPart} }) {
        shortLink
      }
    }`;

    const data = await this.executeGraphQl<{
      generateShortLink?: { shortLink?: string };
    }>(credentials, mutation);

    const shortLink = data.generateShortLink?.shortLink;
    if (!shortLink) {
      throw new Error('Shopee generateShortLink returned an empty shortLink.');
    }
    return shortLink;
  }

  async fetchConversionReport(
    credentials: ShopeeCredentials,
    params: {
      purchaseTimeStart: number;
      purchaseTimeEnd: number;
      limit?: number;
      scrollId?: string | null;
    }
  ): Promise<ConversionReportPage> {
    const limit = params.limit ?? 50;
    const args: string[] = [
      `purchaseTimeStart: ${Math.floor(params.purchaseTimeStart)}`,
      `purchaseTimeEnd: ${Math.floor(params.purchaseTimeEnd)}`,
      `limit: ${limit}`
    ];
    if (params.scrollId) {
      args.push(`scrollId: ${this.escapeGraphQlString(params.scrollId)}`);
    }

    const query = `query {
      conversionReport(${args.join(', ')}) {
        nodes {
          conversionId
          purchaseTime
          clickTime
          totalCommission
          utmContent
          orders {
            orderId
            orderStatus
            items {
              itemId
              itemName
              itemPrice
              qty
              itemTotalCommission
            }
          }
        }
        pageInfo {
          limit
          hasNextPage
          scrollId
        }
      }
    }`;

    const data = await this.executeGraphQl<{
      conversionReport?: {
        nodes?: ConversionReportNode[];
        pageInfo?: { limit?: number; hasNextPage?: boolean; scrollId?: string | null };
      };
    }>(credentials, query);

    const report = data.conversionReport;
    return {
      nodes: report?.nodes ?? [],
      pageInfo: {
        limit: report?.pageInfo?.limit ?? limit,
        hasNextPage: Boolean(report?.pageInfo?.hasNextPage),
        scrollId: report?.pageInfo?.scrollId ?? null
      }
    };
  }
}
