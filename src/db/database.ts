import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppConfig } from '../config/env.js';

export type SettingKey =
  | 'meta_pixel_id'
  | 'meta_capi_token'
  | 'meta_test_event_code'
  | 'capi_include_unpaid'
  | 'meta_ad_account_id'
  | 'meta_marketing_token'
  | 'campaigns_demo_mode'
  | 'shopee_app_id'
  | 'shopee_secret'
  | 'shopee_graphql_url'
  | 'public_base_url'
  | 'whatsapp_group_jid'
  | 'whatsapp_group_name'
  | 'group_dispatch_enabled'
  | 'group_interval_minutes'
  | 'group_active_start_hour'
  | 'group_active_end_hour'
  | 'shopee_keywords'
  | 'meta_whatsapp_token'
  | 'meta_phone_number_id'
  | 'meta_webhook_verify_token'
  | 'x1_enabled'
  | 'x1_channel'
  | 'ai_provider'
  | 'ai_base_url'
  | 'ai_api_key'
  | 'ai_model'
  | 'ai_temperature'
  | 'ai_max_tokens'
  | 'human_takeover_minutes'
  | 'x1_listen_audio'
  | 'x1_audio_reply_mode'
  | 'x1_audio_max_chars'
  | 'stt_provider'
  | 'stt_base_url'
  | 'stt_api_key'
  | 'stt_model'
  | 'tts_provider'
  | 'tts_base_url'
  | 'tts_api_key'
  | 'tts_voice_id'
  | 'tts_reference_wav'
  | 'antiban_preset'
  | 'antiban_debounce_sec'
  | 'antiban_hourly_limit'
  | 'antiban_daily_limit'
  | 'antiban_cooldown_every'
  | 'antiban_cooldown_minutes'
  | 'antiban_inbound_only_24h'
  | 'jev_enabled'
  | 'jev_threshold'
  | 'jev_fallback_message'
  | 'x1_system_prompt'
  | 'x1_buttons_json'
  | 'session_secret';

export type HubSettings = Record<SettingKey, string>;

export interface X1ButtonConfig {
  id: string;
  title: string;
  replyText: string;
  linkUrl: string;
}

export interface CampaignLink {
  slug: string;
  title: string;
  destination_url: string;
  default_value: number;
  created_at: number;
}

export interface CampaignSubidLink {
  sub_id: string;
  campaign_id: string;
  campaign_name: string;
  product_url: string;
  short_link: string;
  created_at: number;
}

export interface DemoCampaignOverride {
  campaign_id: string;
  status: 'ACTIVE' | 'PAUSED';
  daily_budget: number;
  updated_at: number;
}

export interface CatalogItemRecord {
  id: number;
  title: string;
  keywords: string;
  price_label: string;
  affiliate_url: string;
  specs_faq: string;
  objections: string;
  active: number;
  created_at: number;
}

export interface ContactStateRecord {
  jid: string;
  last_inbound_at: number | null;
  paused_until: number | null;
  pause_reason: string | null;
  needs_human: number;
  updated_at: number;
}

export interface BlacklistRecord {
  jid: string;
  reason: string;
  created_at: number;
}

export interface AdClickRecord {
  click_id: string;
  slug: string;
  fbclid: string | null;
  fbp: string | null;
  fbc: string | null;
  client_ip: string | null;
  user_agent: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  short_url: string | null;
  created_at: number;
}

export interface ConversionSentRecord {
  order_id: string;
  conversion_id: string | null;
  click_id: string | null;
  order_status: string;
  order_value: number;
  currency: string;
  capi_status: string;
  capi_response: string | null;
  created_at: number;
}

export interface DispatchedOfferRecord {
  item_id: string;
  group_jid: string;
  product_name: string;
  short_link: string;
  price: string;
  sent_at: number;
}

export interface SystemLogRecord {
  id: number;
  level: string;
  module: string;
  message: string;
  details: string | null;
  created_at: number;
}

export interface DashboardStats {
  totalClicks: number;
  clicks24h: number;
  totalConversionsSent: number;
  totalTrackedRevenue: number;
  totalDispatchedOffers: number;
  totalX1Messages: number;
}

const DEFAULT_X1_BUTTONS: X1ButtonConfig[] = [
  {
    id: 'btn_1',
    title: 'Ver Oferta Hoje',
    replyText: 'Aqui esta o link oficial da oferta em destaque hoje na Shopee:',
    linkUrl: 'https://shopee.com.br'
  },
  {
    id: 'btn_2',
    title: 'Entrar no Grupo',
    replyText: 'Entre no nosso grupo VIP de achadinhos diarios com desconto:',
    linkUrl: 'https://chat.whatsapp.com'
  },
  {
    id: 'btn_3',
    title: 'Mais Promocoes',
    replyText: 'Confira a selecao completa de produtos com frete gratis:',
    linkUrl: 'https://shopee.com.br'
  }
];

const DEFAULT_X1_PROMPT =
  'Voce e a assistente virtual de vendas da loja. Responda sempre em portugues do Brasil de forma natural, simpatica, direta e persuasiva (no maximo 3 frases). Use apenas os dados reais do catalogo quando fornecidos e convide o cliente a clicar no link oficial.';

export function normalizeX1Buttons(rawJson: string): X1ButtonConfig[] {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_X1_BUTTONS;
    const valid = parsed
      .slice(0, 3)
      .map((item, idx) => {
        const obj = (item && typeof item === 'object' ? item : {}) as Record<
          string,
          unknown
        >;
        const title = String(obj.title ?? `Opcao ${idx + 1}`).trim().slice(0, 20);
        return {
          id:
            String(obj.id ?? `btn_${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, '') ||
            `btn_${idx + 1}`,
          title: title || `Opcao ${idx + 1}`,
          replyText: String(obj.replyText ?? '').trim().slice(0, 800),
          linkUrl: String(obj.linkUrl ?? '').trim().slice(0, 1000)
        };
      })
      .filter((btn) => btn.title.length > 0);
    return valid.length > 0 ? valid : DEFAULT_X1_BUTTONS;
  } catch {
    return DEFAULT_X1_BUTTONS;
  }
}

export class HubDatabase {
  private readonly db: DatabaseSync;

  constructor(config: AppConfig) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const dbPath = path.join(config.dataDir, 'hub.sqlite');
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
    this.seedDefaults(config);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaign_links (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        destination_url TEXT NOT NULL,
        default_value REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaign_subid_links (
        sub_id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT NOT NULL,
        product_url TEXT NOT NULL,
        short_link TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS demo_campaign_overrides (
        campaign_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        daily_budget REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        keywords TEXT NOT NULL,
        price_label TEXT NOT NULL,
        affiliate_url TEXT NOT NULL,
        specs_faq TEXT NOT NULL,
        objections TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_states (
        jid TEXT PRIMARY KEY,
        last_inbound_at INTEGER,
        paused_until INTEGER,
        pause_reason TEXT,
        needs_human INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blacklist (
        jid TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bot_sent_ids (
        message_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS send_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        jid TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_send_ledger_time
        ON send_ledger (sent_at DESC);

      CREATE TABLE IF NOT EXISTS ad_clicks (
        click_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        fbclid TEXT,
        fbp TEXT,
        fbc TEXT,
        client_ip TEXT,
        user_agent TEXT,
        utm_source TEXT,
        utm_campaign TEXT,
        short_url TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversions_sent (
        order_id TEXT PRIMARY KEY,
        conversion_id TEXT,
        click_id TEXT,
        order_status TEXT NOT NULL,
        order_value REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'BRL',
        capi_status TEXT NOT NULL,
        capi_response TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dispatched_offers (
        item_id TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        product_name TEXT NOT NULL,
        short_link TEXT NOT NULL,
        price TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        PRIMARY KEY (item_id, group_jid)
      );

      CREATE TABLE IF NOT EXISTS x1_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_x1_messages_wa_id
        ON x1_messages (wa_id, id DESC);

      CREATE TABLE IF NOT EXISTS processed_webhook_ids (
        message_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        module TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  private seedDefaults(config: AppConfig): void {
    const now = Math.floor(Date.now() / 1000);
    const sessionSecret =
      config.sessionSecret || crypto.randomBytes(32).toString('hex');

    const defaults: Record<SettingKey, string> = {
      meta_pixel_id: config.seedSettings.meta_pixel_id,
      meta_capi_token: config.seedSettings.meta_capi_token,
      meta_test_event_code: config.seedSettings.meta_test_event_code,
      capi_include_unpaid: 'false',
      meta_ad_account_id: config.seedSettings.meta_ad_account_id,
      meta_marketing_token: config.seedSettings.meta_marketing_token,
      campaigns_demo_mode: 'true',
      shopee_app_id: config.seedSettings.shopee_app_id,
      shopee_secret: config.seedSettings.shopee_secret,
      shopee_graphql_url: config.seedSettings.shopee_graphql_url,
      public_base_url: config.seedSettings.public_base_url,
      whatsapp_group_jid: config.seedSettings.whatsapp_group_jid,
      whatsapp_group_name: '',
      group_dispatch_enabled: 'false',
      group_interval_minutes: '60',
      group_active_start_hour: '8',
      group_active_end_hour: '22',
      shopee_keywords: config.seedSettings.shopee_keywords,
      meta_whatsapp_token: config.seedSettings.meta_whatsapp_token,
      meta_phone_number_id: config.seedSettings.meta_phone_number_id,
      meta_webhook_verify_token: config.seedSettings.meta_webhook_verify_token,
      x1_enabled: 'true',
      x1_channel: 'baileys',
      ai_provider: config.seedSettings.ai_provider,
      ai_base_url: config.seedSettings.ai_base_url,
      ai_api_key: config.seedSettings.ai_api_key,
      ai_model: config.seedSettings.ai_model,
      ai_temperature: '0.6',
      ai_max_tokens: '300',
      human_takeover_minutes: '30',
      x1_listen_audio: 'true',
      x1_audio_reply_mode: 'mirror',
      x1_audio_max_chars: '280',
      stt_provider: 'voicebox_local',
      stt_base_url: 'http://127.0.0.1:17493',
      stt_api_key: '',
      stt_model: 'whisper-large-v3-turbo',
      tts_provider: 'edge_local',
      tts_base_url: 'http://127.0.0.1:17493',
      tts_api_key: '',
      tts_voice_id: 'pt-BR-FranciscaNeural',
      tts_reference_wav: '',
      antiban_preset: 'conservative',
      antiban_debounce_sec: '10',
      antiban_hourly_limit: '15',
      antiban_daily_limit: '40',
      antiban_cooldown_every: '12',
      antiban_cooldown_minutes: '4',
      antiban_inbound_only_24h: 'true',
      jev_enabled: 'true',
      jev_threshold: '0.65',
      jev_fallback_message:
        'Deixa eu confirmar esse detalhe rapidinho aqui pra voce e ja te retorno!',
      x1_system_prompt: DEFAULT_X1_PROMPT,
      x1_buttons_json: JSON.stringify(DEFAULT_X1_BUTTONS),
      session_secret: sessionSecret
    };

    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
    );
    for (const [key, value] of Object.entries(defaults)) {
      stmt.run(key, value, now);
    }
  }

  getAllSettings(): HubSettings {
    const rows = this.db
      .prepare('SELECT key, value FROM settings')
      .all() as Array<{ key: string; value: string }>;
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    return map as HubSettings;
  }

  getSetting(key: SettingKey): string {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? '';
  }

  updateSettings(patch: Partial<Record<SettingKey, string>>): HubSettings {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || key === 'session_secret') continue;
      let normalized = String(value).trim();
      if (key === 'x1_buttons_json') {
        normalized = JSON.stringify(normalizeX1Buttons(normalized));
      }
      stmt.run(key, normalized, now);
    }
    return this.getAllSettings();
  }

  upsertCampaignLink(input: {
    slug: string;
    title: string;
    destinationUrl: string;
    defaultValue?: number;
  }): CampaignLink {
    const cleanSlug = input.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '');
    if (!cleanSlug) {
      throw new Error('Slug da campanha invalido. Use apenas letras e numeros.');
    }
    const now = Math.floor(Date.now() / 1000);
    const defaultValue = Number.isFinite(input.defaultValue)
      ? Number(input.defaultValue)
      : 0;
    this.db
      .prepare(
        `INSERT INTO campaign_links (slug, title, destination_url, default_value, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           title = excluded.title,
           destination_url = excluded.destination_url,
           default_value = excluded.default_value`
      )
      .run(
        cleanSlug,
        input.title.trim() || cleanSlug,
        input.destinationUrl.trim(),
        defaultValue,
        now
      );

    return this.getCampaignLink(cleanSlug)!;
  }

  getCampaignLink(slug: string): CampaignLink | null {
    const row = this.db
      .prepare(
        'SELECT slug, title, destination_url, default_value, created_at FROM campaign_links WHERE slug = ?'
      )
      .get(slug) as unknown as CampaignLink | undefined;
    return row ?? null;
  }

  listCampaignLinks(): CampaignLink[] {
    return this.db
      .prepare(
        'SELECT slug, title, destination_url, default_value, created_at FROM campaign_links ORDER BY created_at DESC'
      )
      .all() as unknown as CampaignLink[];
  }

  deleteCampaignLink(slug: string): boolean {
    const res = this.db
      .prepare('DELETE FROM campaign_links WHERE slug = ?')
      .run(slug);
    return res.changes > 0;
  }

  // Campaign sub_id attribution (no-Pixel Afiliado Dash)
  upsertCampaignSubidLink(input: {
    subId: string;
    campaignId: string;
    campaignName: string;
    productUrl: string;
    shortLink: string;
  }): CampaignSubidLink {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO campaign_subid_links (sub_id, campaign_id, campaign_name, product_url, short_link, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sub_id) DO UPDATE SET
           campaign_id = excluded.campaign_id,
           campaign_name = excluded.campaign_name,
           product_url = excluded.product_url,
           short_link = excluded.short_link`
      )
      .run(
        input.subId,
        input.campaignId,
        input.campaignName,
        input.productUrl,
        input.shortLink,
        now
      );
    return this.db
      .prepare('SELECT * FROM campaign_subid_links WHERE sub_id = ?')
      .get(input.subId) as unknown as CampaignSubidLink;
  }

  listCampaignSubidLinks(): CampaignSubidLink[] {
    return this.db
      .prepare('SELECT * FROM campaign_subid_links ORDER BY created_at DESC')
      .all() as unknown as CampaignSubidLink[];
  }

  upsertDemoCampaignOverride(
    campaignId: string,
    status: 'ACTIVE' | 'PAUSED',
    dailyBudget: number
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO demo_campaign_overrides (campaign_id, status, daily_budget, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(campaign_id) DO UPDATE SET
           status = excluded.status,
           daily_budget = excluded.daily_budget,
           updated_at = excluded.updated_at`
      )
      .run(campaignId, status, dailyBudget, now);
  }

  listDemoCampaignOverrides(): DemoCampaignOverride[] {
    return this.db
      .prepare('SELECT * FROM demo_campaign_overrides')
      .all() as unknown as DemoCampaignOverride[];
  }

  // RAG + Jev Catalog
  createCatalogItem(input: {
    title: string;
    keywords: string;
    priceLabel: string;
    affiliateUrl: string;
    specsFaq: string;
    objections: string;
  }): CatalogItemRecord {
    const now = Math.floor(Date.now() / 1000);
    const res = this.db
      .prepare(
        `INSERT INTO catalog_items (title, keywords, price_label, affiliate_url, specs_faq, objections, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        input.title.trim(),
        input.keywords.trim(),
        input.priceLabel.trim(),
        input.affiliateUrl.trim(),
        input.specsFaq.trim(),
        input.objections.trim(),
        now
      );
    return this.db
      .prepare('SELECT * FROM catalog_items WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as unknown as CatalogItemRecord;
  }

  listCatalogItems(onlyActive = false): CatalogItemRecord[] {
    const sql = onlyActive
      ? 'SELECT * FROM catalog_items WHERE active = 1 ORDER BY id DESC'
      : 'SELECT * FROM catalog_items ORDER BY id DESC';
    return this.db.prepare(sql).all() as unknown as CatalogItemRecord[];
  }

  deleteCatalogItem(id: number): boolean {
    const res = this.db
      .prepare('DELETE FROM catalog_items WHERE id = ?')
      .run(id);
    return res.changes > 0;
  }

  // Contact states (Human Takeover, 24h inbound guard, Jev checkpoint)
  getContactState(jid: string): ContactStateRecord | null {
    const row = this.db
      .prepare('SELECT * FROM contact_states WHERE jid = ?')
      .get(jid) as unknown as ContactStateRecord | undefined;
    return row ?? null;
  }

  touchInboundContact(jid: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO contact_states (jid, last_inbound_at, paused_until, pause_reason, needs_human, updated_at)
         VALUES (?, ?, NULL, NULL, 0, ?)
         ON CONFLICT(jid) DO UPDATE SET
           last_inbound_at = excluded.last_inbound_at,
           updated_at = excluded.updated_at`
      )
      .run(jid, now, now);
  }

  pauseContact(
    jid: string,
    minutes: number,
    reason: string,
    needsHuman = false
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const pausedUntil = now + Math.max(1, minutes) * 60;
    this.db
      .prepare(
        `INSERT INTO contact_states (jid, last_inbound_at, paused_until, pause_reason, needs_human, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           paused_until = excluded.paused_until,
           pause_reason = excluded.pause_reason,
           needs_human = excluded.needs_human,
           updated_at = excluded.updated_at`
      )
      .run(jid, pausedUntil, reason, needsHuman ? 1 : 0, now);
  }

  resumeContact(jid: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE contact_states
         SET paused_until = NULL, pause_reason = NULL, needs_human = 0, updated_at = ?
         WHERE jid = ?`
      )
      .run(now, jid);
  }

  listPausedOrFlaggedContacts(): ContactStateRecord[] {
    const now = Math.floor(Date.now() / 1000);
    return this.db
      .prepare(
        `SELECT * FROM contact_states
         WHERE needs_human = 1 OR (paused_until IS NOT NULL AND paused_until > ?)
         ORDER BY updated_at DESC`
      )
      .all(now) as unknown as ContactStateRecord[];
  }

  // Blacklist (opt-out)
  addToBlacklist(jid: string, reason: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO blacklist (jid, reason, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET reason = excluded.reason`
      )
      .run(jid, reason, now);
  }

  removeFromBlacklist(jid: string): boolean {
    const res = this.db.prepare('DELETE FROM blacklist WHERE jid = ?').run(jid);
    return res.changes > 0;
  }

  isBlacklisted(jid: string): boolean {
    const row = this.db
      .prepare('SELECT jid FROM blacklist WHERE jid = ?')
      .get(jid) as { jid: string } | undefined;
    return Boolean(row);
  }

  listBlacklist(): BlacklistRecord[] {
    return this.db
      .prepare('SELECT * FROM blacklist ORDER BY created_at DESC')
      .all() as unknown as BlacklistRecord[];
  }

  // Bot sent message IDs (for Human Takeover fromMe distinction)
  recordBotSentId(messageId: string): void {
    if (!messageId) return;
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO bot_sent_ids (message_id, created_at) VALUES (?, ?)'
      )
      .run(messageId, now);
    this.db
      .prepare(
        'DELETE FROM bot_sent_ids WHERE message_id NOT IN (SELECT message_id FROM bot_sent_ids ORDER BY created_at DESC LIMIT 1000)'
      )
      .run();
  }

  isBotSentId(messageId: string): boolean {
    if (!messageId) return false;
    const row = this.db
      .prepare('SELECT message_id FROM bot_sent_ids WHERE message_id = ?')
      .get(messageId) as { message_id: string } | undefined;
    return Boolean(row);
  }

  // Anti-ban send ledger
  recordOutboundSend(channel: string, jid: string, contentHash: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        'INSERT INTO send_ledger (channel, jid, content_hash, sent_at) VALUES (?, ?, ?, ?)'
      )
      .run(channel, jid, contentHash, now);
  }

  getSendCounts(): { lastHour: number; lastDay: number; lastHash: string | null } {
    const now = Math.floor(Date.now() / 1000);
    const hRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM send_ledger WHERE sent_at >= ?')
      .get(now - 3600) as { cnt: number };
    const dRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM send_ledger WHERE sent_at >= ?')
      .get(now - 86400) as { cnt: number };
    const lastRow = this.db
      .prepare('SELECT content_hash FROM send_ledger ORDER BY id DESC LIMIT 1')
      .get() as { content_hash: string } | undefined;
    return {
      lastHour: hRow.cnt,
      lastDay: dRow.cnt,
      lastHash: lastRow?.content_hash ?? null
    };
  }

  recordAdClick(input: Omit<AdClickRecord, 'created_at'>): AdClickRecord {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO ad_clicks (
          click_id, slug, fbclid, fbp, fbc, client_ip, user_agent, utm_source, utm_campaign, short_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.click_id,
        input.slug,
        input.fbclid,
        input.fbp,
        input.fbc,
        input.client_ip,
        input.user_agent,
        input.utm_source,
        input.utm_campaign,
        input.short_url,
        now
      );
    return { ...input, created_at: now };
  }

  getAdClick(clickId: string): AdClickRecord | null {
    const row = this.db
      .prepare('SELECT * FROM ad_clicks WHERE click_id = ?')
      .get(clickId) as unknown as AdClickRecord | undefined;
    return row ?? null;
  }

  listRecentClicks(limit = 30): AdClickRecord[] {
    return this.db
      .prepare('SELECT * FROM ad_clicks ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as AdClickRecord[];
  }

  isConversionSent(orderId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT order_id FROM conversions_sent WHERE order_id = ? AND capi_status = 'SENT'"
      )
      .get(orderId) as { order_id: string } | undefined;
    return Boolean(row);
  }

  upsertConversionRecord(input: Omit<ConversionSentRecord, 'created_at'>): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO conversions_sent (
          order_id, conversion_id, click_id, order_status, order_value, currency, capi_status, capi_response, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET
          order_status = excluded.order_status,
          order_value = excluded.order_value,
          capi_status = excluded.capi_status,
          capi_response = excluded.capi_response,
          created_at = excluded.created_at`
      )
      .run(
        input.order_id,
        input.conversion_id,
        input.click_id,
        input.order_status,
        input.order_value,
        input.currency,
        input.capi_status,
        input.capi_response,
        now
      );
  }

  listRecentConversions(limit = 40): ConversionSentRecord[] {
    return this.db
      .prepare('SELECT * FROM conversions_sent ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as ConversionSentRecord[];
  }

  hasDispatchedOffer(itemId: string, groupJid: string): boolean {
    const row = this.db
      .prepare(
        'SELECT item_id FROM dispatched_offers WHERE item_id = ? AND group_jid = ?'
      )
      .get(itemId, groupJid) as { item_id: string } | undefined;
    return Boolean(row);
  }

  recordDispatchedOffer(input: Omit<DispatchedOfferRecord, 'sent_at'>): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dispatched_offers (item_id, group_jid, product_name, short_link, price, sent_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.item_id,
        input.group_jid,
        input.product_name,
        input.short_link,
        input.price,
        now
      );
  }

  listDispatchedOffers(limit = 30): DispatchedOfferRecord[] {
    return this.db
      .prepare('SELECT * FROM dispatched_offers ORDER BY sent_at DESC LIMIT ?')
      .all(limit) as unknown as DispatchedOfferRecord[];
  }

  appendX1Message(
    waId: string,
    role: 'user' | 'assistant',
    content: string
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        'INSERT INTO x1_messages (wa_id, role, content, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(waId, role, content, now);
  }

  getRecentX1History(
    waId: string,
    limit = 8
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const rows = this.db
      .prepare(
        'SELECT role, content FROM x1_messages WHERE wa_id = ? ORDER BY id DESC LIMIT ?'
      )
      .all(waId, limit) as Array<{ role: 'user' | 'assistant'; content: string }>;
    return rows.reverse();
  }

  markWebhookProcessedIfNew(messageId: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const res = this.db
      .prepare(
        'INSERT OR IGNORE INTO processed_webhook_ids (message_id, created_at) VALUES (?, ?)'
      )
      .run(messageId, now);
    return res.changes > 0;
  }

  addLog(
    level: 'info' | 'warn' | 'error',
    moduleName: string,
    message: string,
    details?: string
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        'INSERT INTO system_logs (level, module, message, details, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(level, moduleName, message, details ?? null, now);

    this.db
      .prepare(
        'DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT 300)'
      )
      .run();
  }

  listLogs(limit = 80): SystemLogRecord[] {
    return this.db
      .prepare('SELECT * FROM system_logs ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as SystemLogRecord[];
  }

  getDashboardStats(): DashboardStats {
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    const clicksRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM ad_clicks')
      .get() as { cnt: number };
    const clicks24Row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM ad_clicks WHERE created_at >= ?')
      .get(dayAgo) as { cnt: number };
    const convRow = this.db
      .prepare(
        "SELECT COUNT(*) AS cnt, COALESCE(SUM(order_value), 0) AS rev FROM conversions_sent WHERE capi_status = 'SENT'"
      )
      .get() as { cnt: number; rev: number };
    const offersRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM dispatched_offers')
      .get() as { cnt: number };
    const x1Row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM x1_messages WHERE role = 'assistant'")
      .get() as { cnt: number };

    return {
      totalClicks: clicksRow.cnt,
      clicks24h: clicks24Row.cnt,
      totalConversionsSent: convRow.cnt,
      totalTrackedRevenue: Number((convRow.rev || 0).toFixed(2)),
      totalDispatchedOffers: offersRow.cnt,
      totalX1Messages: x1Row.cnt
    };
  }

  close(): void {
    this.db.close();
  }
}
