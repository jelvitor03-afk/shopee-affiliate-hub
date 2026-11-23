import crypto from 'node:crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { AppConfig } from '../config/env.js';
import {
  HubDatabase,
  normalizeX1Buttons,
  SettingKey
} from '../db/database.js';
import { CronManager } from '../scheduler/cronManager.js';
import { BaileysGroupService } from '../services/baileysGroupService.js';
import { MetaCapiService } from '../services/metaCapiService.js';
import { TrackerService } from '../services/trackerService.js';

const SESSION_COOKIE = 'shopee_hub_session';
const SESSION_TTL_SEC = 7 * 24 * 3600;

const EDITABLE_SETTING_KEYS: readonly SettingKey[] = [
  'meta_pixel_id',
  'meta_capi_token',
  'meta_test_event_code',
  'capi_include_unpaid',
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
  'ai_provider',
  'ai_api_key',
  'ai_model',
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
}): Router {
  const { db, config, tracker, metaCapi, baileys, crons } = deps;
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
      readiness: {
        metaConfigured: Boolean(settings.meta_pixel_id && settings.meta_capi_token),
        shopeeConfigured: Boolean(settings.shopee_app_id && settings.shopee_secret),
        groupConfigured: Boolean(
          whatsappState.status === 'connected' && settings.whatsapp_group_jid
        ),
        x1Configured: Boolean(
          settings.meta_whatsapp_token && settings.meta_phone_number_id
        ),
        aiConfigured: Boolean(settings.ai_api_key)
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
      db.addLog('info', 'tracker', `Link de anuncio criado/atualizado: /go/${campaign.slug}`);
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
