import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export interface EnvSeedSettings {
  meta_pixel_id: string;
  meta_capi_token: string;
  meta_test_event_code: string;
  shopee_app_id: string;
  shopee_secret: string;
  shopee_graphql_url: string;
  meta_whatsapp_token: string;
  meta_phone_number_id: string;
  meta_webhook_verify_token: string;
  ai_provider: string;
  ai_api_key: string;
  ai_model: string;
  whatsapp_group_jid: string;
  shopee_keywords: string;
  public_base_url: string;
}

export interface AppConfig {
  port: number;
  adminPassword: string;
  sessionSecret: string;
  dataDir: string;
  publicBaseUrl: string;
  metaGraphBaseUrl: string;
  geminiBaseUrl: string;
  openaiBaseUrl: string;
  baileysDelayMinMs: number;
  baileysDelayMaxMs: number;
  seedSettings: EnvSeedSettings;
}

function parseIntOrDefault(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadEnvConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const port = overrides.port ?? parseIntOrDefault(process.env.PORT, 3000);
  const publicBaseUrl =
    overrides.publicBaseUrl ??
    (process.env.PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`);

  const seedSettings: EnvSeedSettings = {
    meta_pixel_id: process.env.META_PIXEL_ID?.trim() || '',
    meta_capi_token: process.env.META_CAPI_TOKEN?.trim() || '',
    meta_test_event_code: process.env.META_TEST_EVENT_CODE?.trim() || '',
    shopee_app_id: process.env.SHOPEE_APP_ID?.trim() || '',
    shopee_secret: process.env.SHOPEE_SECRET?.trim() || '',
    shopee_graphql_url:
      process.env.SHOPEE_GRAPHQL_URL?.trim() ||
      'https://open-api.affiliate.shopee.com.br/graphql',
    meta_whatsapp_token: process.env.META_WHATSAPP_TOKEN?.trim() || '',
    meta_phone_number_id: process.env.META_PHONE_NUMBER_ID?.trim() || '',
    meta_webhook_verify_token:
      process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() || 'shopee-hub-verify',
    ai_provider: process.env.AI_PROVIDER?.trim() || 'gemini',
    ai_api_key: process.env.AI_API_KEY?.trim() || '',
    ai_model: process.env.AI_MODEL?.trim() || 'gemini-2.5-flash',
    whatsapp_group_jid: process.env.WHATSAPP_GROUP_JID?.trim() || '',
    shopee_keywords:
      process.env.SHOPEE_KEYWORDS?.trim() ||
      'oferta relampago,casa inteligente,cozinha',
    public_base_url: publicBaseUrl
  };

  return {
    port,
    adminPassword:
      overrides.adminPassword ??
      (process.env.ADMIN_PASSWORD?.trim() || 'troque-esta-senha'),
    sessionSecret:
      overrides.sessionSecret ?? (process.env.SESSION_SECRET?.trim() || ''),
    dataDir:
      overrides.dataDir ??
      path.resolve(process.env.DATA_DIR?.trim() || './data'),
    publicBaseUrl,
    metaGraphBaseUrl:
      overrides.metaGraphBaseUrl ??
      (process.env.META_GRAPH_BASE_URL?.trim() ||
        'https://graph.facebook.com/v21.0'),
    geminiBaseUrl:
      overrides.geminiBaseUrl ??
      (process.env.GEMINI_BASE_URL?.trim() ||
        'https://generativelanguage.googleapis.com/v1beta'),
    openaiBaseUrl:
      overrides.openaiBaseUrl ??
      (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1'),
    baileysDelayMinMs:
      overrides.baileysDelayMinMs ??
      parseIntOrDefault(process.env.BAILEYS_DELAY_MIN_MS, 2500),
    baileysDelayMaxMs:
      overrides.baileysDelayMaxMs ??
      parseIntOrDefault(process.env.BAILEYS_DELAY_MAX_MS, 6000),
    seedSettings
  };
}
