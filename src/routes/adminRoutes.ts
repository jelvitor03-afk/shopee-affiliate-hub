import crypto from 'node:crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { AppConfig } from '../config/env.js';
import {
  HubDatabase,
  normalizeX1Buttons,
  SettingKey
} from '../db/database.js';
import { CronManager } from '../scheduler/cronManager.js';
import {
  AntiBanPreset,
  AntiBanService
} from '../services/antiBanService.js';
import { BaileysGroupService } from '../services/baileysGroupService.js';
import { CampaignDashboardService } from '../services/campaignDashboardService.js';
import { MetaDatePreset } from '../services/metaAdsService.js';
import { MetaCapiService } from '../services/metaCapiService.js';
import { TrackerService } from '../services/trackerService.js';
import { VoiceService } from '../services/voiceService.js';

const SESSION_COOKIE = 'shopee_hub_session';
const SESSION_TTL_SEC = 7 * 24 * 3600;

const EDITABLE_SETTING_KEYS: readonly SettingKey[] = [
  'meta_pixel_id',
  'meta_capi_token',
  'meta_test_event_code',
  'capi_include_unpaid',
  'meta_ad_account_id',
  'meta_marketing_token',
  'campaigns_demo_mode',
  'shopee_app_id',
  'shopee_secret',
  'shopee_graphql_url',
  'public_base_url',
  'whatsapp_group_jid',
  'whatsapp_group_name',
  'group_dispatch_enabled',
  'group_interval_minutes',
  'group_active_start_hour',
  'group_active_end_hour',
  'shopee_keywords',
  'meta_whatsapp_token',
  'meta_phone_number_id',
  'meta_webhook_verify_token',
  'x1_enabled',
  'x1_channel',
  'ai_provider',
  'ai_base_url',
  'ai_api_key',
  'ai_model',
  'ai_temperature',
  'ai_max_tokens',
  'human_takeover_minutes',
  'x1_listen_audio',
  'x1_audio_reply_mode',
  'x1_audio_max_chars',
  'stt_provider',
  'stt_base_url',
  'stt_api_key',
  'stt_model',
  'tts_provider',
  'tts_base_url',
  'tts_api_key',
  'tts_voice_id',
  'tts_reference_wav',
  'antiban_preset',
  'antiban_debounce_sec',
  'antiban_hourly_limit',
  'antiban_daily_limit',
  'antiban_cooldown_every',
  'antiban_cooldown_minutes',
  'antiban_inbound_only_24h',
  'jev_enabled',
  'jev_threshold',
  'jev_fallback_message',
  'x1_system_prompt',
  'x1_buttons_json'
];

function constantTimeEquals(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function signSessionToken(secret: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = `${issuedAt}.${nonce}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionToken(token: string | undefined, secret: string): boolean {
  if (!token || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [issuedAtRaw, nonce, sig] = parts;
  if (!issuedAtRaw || !nonce || !sig) return false;

  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAt)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now - issuedAt > SESSION_TTL_SEC || issuedAt > now + 60) return false;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${issuedAtRaw}.${nonce}`, 'utf8')
    .digest('hex');

  return constantTimeEquals(sig, expectedSig);
}

export function createAdminRoutes(deps: {
  db: HubDatabase;
  config: AppConfig;
  tracker: TrackerService;
  metaCapi: MetaCapiService;
  baileys: BaileysGroupService;
  crons: CronManager;
  campaignDashboard: CampaignDashboardService;
  voice: VoiceService;
  antiBan: AntiBanService;
}): Router {
  const {
    db,
    config,
    tracker,
    metaCapi,
    baileys,
    crons,
    campaignDashboard,
    voice,
    antiBan
  } = deps;
  const router = Router();

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const token = cookies[SESSION_COOKIE];
    const secret = db.getSetting('session_secret');
    if (!verifySessionToken(token, secret)) {
      res.status(401).json({ error: 'Sessao expirada ou nao autenticada.' });
      return;
    }
    next();
  };

  router.get('/session', (req, res) => {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const secret = db.getSetting('session_secret');
    const authenticated = verifySessionToken(cookies[SESSION_COOKIE], secret);
    res.json({
      authenticated,
      usingDefaultPassword: config.adminPassword === 'troque-esta-senha'
    });
  });

  router.post('/login', (req, res) => {
    const password = String((req.body as { password?: string })?.password || '');
    if (!constantTimeEquals(password, config.adminPassword)) {
      res.status(401).json({ error: 'Senha incorreta.' });
      return;
    }

    const secret = db.getSetting('session_secret');
    const token = signSessionToken(secret);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SEC * 1000
    });
    res.json({ ok: true });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.use(requireAuth);

  router.get('/overview', (_req, res) => {
    const settings = db.getAllSettings();
    const stats = db.getDashboardStats();
    const whatsappState = baileys.getSnapshot();
    const buttons = normalizeX1Buttons(settings.x1_buttons_json);

    res.json({
      stats,
      whatsappState,
      antiBanStatus: antiBan.getStatus(),
      readiness: {
        metaAdsConfigured: Boolean(
          settings.meta_ad_account_id && settings.meta_marketing_token
        ),
        metaConfigured: Boolean(settings.meta_pixel_id && settings.meta_capi_token),
        shopeeConfigured: Boolean(settings.shopee_app_id && settings.shopee_secret),
        groupConfigured: Boolean(
          whatsappState.status === 'connected' && settings.whatsapp_group_jid
        ),
        x1Configured:
          settings.x1_channel === 'baileys'
            ? whatsappState.status === 'connected'
            : Boolean(settings.meta_whatsapp_token && settings.meta_phone_number_id),
        aiConfigured:
          settings.ai_provider === 'openai_compat'
            ? Boolean(settings.ai_base_url && settings.ai_model)
            : Boolean(settings.ai_api_key)
      },
      webhookPath: '/webhook/whatsapp',
      publicBaseUrl: settings.public_base_url || config.publicBaseUrl,
      buttonCount: buttons.length
    });
  });

  router.get('/settings', (_req, res) => {
    const all = db.getAllSettings();
    const { session_secret: _hidden, ...safeSettings } = all;
    res.json({
      settings: safeSettings,
      buttons: normalizeX1Buttons(all.x1_buttons_json)
    });
  });

  router.put('/settings', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<Record<SettingKey, string>> = {};

    for (const key of EDITABLE_SETTING_KEYS) {
      if (body[key] !== undefined) {
        patch[key] =
          typeof body[key] === 'string' ? body[key] : JSON.stringify(body[key]);
      }
    }

    const updated = db.updateSettings(patch);
    crons.reload();
    db.addLog('info', 'admin', 'Configuracoes atualizadas pelo painel.');
    const { session_secret: _hidden, ...safeSettings } = updated;
    res.json({
      ok: true,
      settings: safeSettings,
      buttons: normalizeX1Buttons(updated.x1_buttons_json)
    });
  });

  // --- ROI Campaigns (Afiliado Dash without Pixel) ---
  router.get('/roi-campaigns', async (req, res) => {
    const rawPreset = String(req.query.datePreset || 'today');
    const validPresets: MetaDatePreset[] = [
      'today',
      'yesterday',
      'last_7d',
      'maximum'
    ];
    const datePreset: MetaDatePreset = validPresets.includes(
      rawPreset as MetaDatePreset
    )
      ? (rawPreset as MetaDatePreset)
      : 'today';

    const forceDemo =
      req.query.demo === 'true'
        ? true
        : req.query.demo === 'false'
        ? false
        : undefined;

    try {
      const data = await campaignDashboard.getRoiDashboard(datePreset, forceDemo);
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.addLog('error', 'campaigns', 'Erro ao carregar Campanhas ROI.', msg);
      res.status(400).json({ error: msg });
    }
  });

  router.post('/roi-campaigns/:id/status', async (req, res) => {
    const status = String(
      (req.body as { status?: string })?.status || ''
    ).toUpperCase();
    if (status !== 'ACTIVE' && status !== 'PAUSED') {
      res.status(400).json({ error: 'Status deve ser ACTIVE ou PAUSED.' });
      return;
    }
    try {
      const result = await campaignDashboard.toggleCampaignStatus(
        req.params.id,
        status
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post('/roi-campaigns/:id/budget', async (req, res) => {
    const rawBudget = Number.parseFloat(
      String((req.body as { dailyBudget?: number | string })?.dailyBudget || '')
    );
    if (!Number.isFinite(rawBudget) || rawBudget < 1) {
      res.status(400).json({ error: 'Orcamento diario minimo e R$ 1,00.' });
      return;
    }
    try {
      const result = await campaignDashboard.updateCampaignBudget(
        req.params.id,
        rawBudget
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post('/roi-campaigns/link', async (req, res) => {
    const body = (req.body ?? {}) as {
      campaignId?: string;
      campaignName?: string;
      productUrl?: string;
    };
    if (!body.campaignId || !body.productUrl) {
      res.status(400).json({
        error: 'Informe o ID/Tag da campanha e a URL do produto na Shopee.'
      });
      return;
    }
    try {
      const link = await campaignDashboard.createCampaignTrackedLink({
        campaignId: body.campaignId,
        campaignName: body.campaignName || body.campaignId,
        productUrl: body.productUrl
      });
      res.json({ ok: true, link });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // --- Voice Upload & Live Test ---
  router.post('/voice/upload', (req, res) => {
    const body = (req.body ?? {}) as { filename?: string; base64?: string };
    if (!body.base64) {
      res.status(400).json({ error: 'Arquivo de audio base64 ausente.' });
      return;
    }
    try {
      const saved = voice.saveReferenceWav(
        body.base64,
        body.filename || 'voz_modelo.wav'
      );
      res.json({ ok: true, ...saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post('/voice/test', async (req, res) => {
    const text =
      String((req.body as { text?: string })?.text || '').trim() ||
      'Oi! Esse produto esta com promocao hoje na Shopee, quer que eu te mande o link agora?';
    try {
      const settings = db.getAllSettings();
      const oggBuffer = await voice.synthesizeToOggOpus(text, settings);
      res.json({
        ok: true,
        mimeType: 'audio/ogg',
        bytes: oggBuffer.length,
        audioDataUrl: `data:audio/ogg;base64,${oggBuffer.toString('base64')}`
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.addLog('error', 'voice', 'Falha no teste de voz.', msg);
      res.status(400).json({ error: msg });
    }
  });

  // --- RAG + Jev Catalog ---
  router.get('/catalog', (_req, res) => {
    res.json({ items: db.listCatalogItems(false) });
  });

  router.post('/catalog', (req, res) => {
    const body = (req.body ?? {}) as {
      title?: string;
      keywords?: string;
      priceLabel?: string;
      affiliateUrl?: string;
      specsFaq?: string;
      objections?: string;
    };
    if (!body.title || !body.affiliateUrl) {
      res.status(400).json({
        error: 'Informe o nome do produto e o link oficial de afiliado.'
      });
      return;
    }
    const item = db.createCatalogItem({
      title: body.title,
      keywords: body.keywords || body.title,
      priceLabel: body.priceLabel || 'Oferta hoje',
      affiliateUrl: body.affiliateUrl,
      specsFaq: body.specsFaq || '',
      objections: body.objections || ''
    });
    db.addLog('info', 'jev', `Produto adicionado ao catalogo Jev: ${item.title}`);
    res.json({ ok: true, item });
  });

  router.delete('/catalog/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const deleted = Number.isFinite(id) ? db.deleteCatalogItem(id) : false;
    res.json({ ok: deleted });
  });

  // --- Anti-Ban, Human Takeover & Blacklist ---
  router.get('/antiban/status', (_req, res) => {
    res.json({
      status: antiBan.getStatus(),
      pausedContacts: db.listPausedOrFlaggedContacts(),
      blacklist: db.listBlacklist()
    });
  });

  router.post('/antiban/preset', (req, res) => {
    const preset = String((req.body as { preset?: string })?.preset || '');
    if (
      preset !== 'conservative' &&
      preset !== 'moderate' &&
      preset !== 'veteran'
    ) {
      res.status(400).json({ error: 'Preset invalido.' });
      return;
    }
    const values = antiBan.getPresetValues(preset as AntiBanPreset);
    const updated = db.updateSettings(values);
    const { session_secret: _hidden, ...safe } = updated;
    db.addLog('info', 'antiban', `Preset Anti-Ban aplicado: ${preset}`);
    res.json({ ok: true, settings: safe, status: antiBan.getStatus() });
  });

  router.post('/antiban/reset-breaker', (_req, res) => {
    antiBan.resetCircuitBreaker();
    res.json({ ok: true, status: antiBan.getStatus() });
  });

  router.get('/blacklist', (_req, res) => {
    res.json({ blacklist: db.listBlacklist() });
  });

  router.post('/blacklist', (req, res) => {
    const body = (req.body ?? {}) as { jid?: string; reason?: string };
    if (!body.jid) {
      res.status(400).json({ error: 'Informe o numero/JID para bloquear.' });
      return;
    }
    db.addToBlacklist(body.jid.trim(), body.reason?.trim() || 'Manual');
    res.json({ ok: true, blacklist: db.listBlacklist() });
  });

  router.delete('/blacklist/:jid', (req, res) => {
    const ok = db.removeFromBlacklist(decodeURIComponent(req.params.jid));
    res.json({ ok, blacklist: db.listBlacklist() });
  });

  router.get('/contacts/paused', (_req, res) => {
    res.json({ pausedContacts: db.listPausedOrFlaggedContacts() });
  });

  router.post('/contacts/:jid/resume', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    db.resumeContact(jid);
    db.addLog('info', 'x1', `IA retomada manualmente para ${jid}`);
    res.json({ ok: true, pausedContacts: db.listPausedOrFlaggedContacts() });
  });

  // --- Legacy /go/:slug & CAPI Tracker ---
  router.get('/campaigns', (_req, res) => {
    res.json({
      campaigns: db.listCampaignLinks(),
      recentClicks: db.listRecentClicks(30),
      recentConversions: db.listRecentConversions(40)
    });
  });

  router.post('/campaigns', (req, res) => {
    const body = (req.body ?? {}) as {
      slug?: string;
      title?: string;
      destinationUrl?: string;
      defaultValue?: number | string;
    };

    if (!body.slug || !body.destinationUrl) {
      res.status(400).json({
        error: 'Informe o apelido (slug) e a URL de destino da Shopee.'
      });
      return;
    }

    try {
      const parsedValue = Number.parseFloat(String(body.defaultValue ?? '0'));
      const campaign = db.upsertCampaignLink({
        slug: body.slug,
        title: body.title || body.slug,
        destinationUrl: body.destinationUrl,
        defaultValue: Number.isFinite(parsedValue) ? parsedValue : 0
      });
      db.addLog(
        'info',
        'tracker',
        `Link de anuncio criado/atualizado: /go/${campaign.slug}`
      );
      res.json({ ok: true, campaign });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.delete('/campaigns/:slug', (req, res) => {
    const deleted = db.deleteCampaignLink(req.params.slug);
    res.json({ ok: deleted });
  });

  router.post('/sync-conversions', async (_req, res) => {
    try {
      const summary = await tracker.syncConversionsNow();
      res.json({ ok: true, summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.addLog('error', 'tracker', 'Erro ao sincronizar conversoes.', msg);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/test-capi', async (req, res) => {
    const settings = db.getAllSettings();
    const overrideTestCode =
      typeof (req.body as { testEventCode?: string })?.testEventCode === 'string'
        ? (req.body as { testEventCode?: string }).testEventCode
        : undefined;

    if (!settings.meta_pixel_id || !settings.meta_capi_token) {
      res.status(400).json({
        error: 'Preencha e salve o Pixel ID e o Token da API de Conversoes primeiro.'
      });
      return;
    }

    try {
      const testOrderId = `TEST_${Date.now()}`;
      const result = await metaCapi.sendPurchaseEvent(
        {
          pixelId: settings.meta_pixel_id,
          capiToken: settings.meta_capi_token,
          testEventCode: overrideTestCode ?? settings.meta_test_event_code,
          graphBaseUrl: config.metaGraphBaseUrl
        },
        {
          orderId: testOrderId,
          eventTimeSec: Math.floor(Date.now() / 1000),
          value: 49.9,
          currency: 'BRL',
          eventSourceUrl: settings.public_base_url || config.publicBaseUrl
        }
      );

      db.addLog(
        'info',
        'tracker',
        `Evento de teste Purchase enviado para Meta CAPI (${testOrderId}).`
      );
      res.json({ ok: true, testOrderId, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.addLog('error', 'tracker', 'Falha no teste da Meta CAPI.', msg);
      res.status(400).json({ error: msg });
    }
  });

  // --- WhatsApp Baileys Group & Session ---
  router.get('/whatsapp/status', (_req, res) => {
    res.json({
      state: baileys.getSnapshot(),
      dispatchedOffers: db.listDispatchedOffers(25)
    });
  });

  router.post('/whatsapp/connect', async (_req, res) => {
    try {
      const state = await baileys.connect();
      res.json({ ok: true, state });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/whatsapp/logout', async (_req, res) => {
    await baileys.logout();
    res.json({ ok: true, state: baileys.getSnapshot() });
  });

  router.get('/whatsapp/groups', async (_req, res) => {
    try {
      const groups = await baileys.listGroups();
      res.json({ ok: true, groups });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post('/whatsapp/dispatch-now', async (_req, res) => {
    try {
      const outcome = await baileys.dispatchNextOffer({
        ignoreScheduleWindow: true
      });
      res.json({ ok: outcome.sent, outcome });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/logs', (_req, res) => {
    res.json({ logs: db.listLogs(100) });
  });

  return router;
}
