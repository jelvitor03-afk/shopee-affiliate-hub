import { Router } from 'express';
import { TrackerService } from '../services/trackerService.js';
import { WhatsAppCloudService } from '../services/whatsappCloudService.js';

export function createPublicRoutes(
  tracker: TrackerService,
  whatsappCloud: WhatsAppCloudService
): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'shopee-affiliate-hub',
      timestamp: new Date().toISOString()
    });
  });

  router.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  router.get('/', (_req, res) => {
    res.redirect(302, '/admin');
  });

  router.get('/go/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    const fbclid =
      typeof req.query.fbclid === 'string' ? req.query.fbclid : undefined;
    const utmSource =
      typeof req.query.utm_source === 'string'
        ? req.query.utm_source
        : undefined;
    const utmCampaign =
      typeof req.query.utm_campaign === 'string'
        ? req.query.utm_campaign
        : undefined;

    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp =
      typeof forwardedFor === 'string'
        ? forwardedFor.split(',')[0]?.trim()
        : req.ip;

    try {
      const outcome = await tracker.handleGoRedirect({
        slug,
        fbclid,
        fbp: cookies._fbp,
        fbc: cookies._fbc,
        clientIp,
        userAgent: req.headers['user-agent'],
        utmSource,
        utmCampaign
      });

      if (!outcome) {
        res
          .status(404)
          .type('html')
          .send(
            '<!doctype html><html lang="pt-BR"><body style="font-family:sans-serif;background:#090D14;color:#F8FAFC;padding:40px"><h1>Link nao encontrado</h1><p>Esta campanha ainda nao foi cadastrada no painel administrativo.</p></body></html>'
          );
        return;
      }

      res.redirect(302, outcome.redirectUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/webhook/whatsapp', (req, res) => {
    const mode =
      typeof req.query['hub.mode'] === 'string'
        ? req.query['hub.mode']
        : undefined;
    const token =
      typeof req.query['hub.verify_token'] === 'string'
        ? req.query['hub.verify_token']
        : undefined;
    const challenge =
      typeof req.query['hub.challenge'] === 'string'
        ? req.query['hub.challenge']
        : undefined;

    const verified = whatsappCloud.verifyWebhook(mode, token, challenge);
    if (!verified) {
      res.status(403).send('Forbidden');
      return;
    }
    res.status(200).send(verified);
  });

  router.post('/webhook/whatsapp', async (req, res) => {
    try {
      const summary = await whatsappCloud.handleWebhookPayload(req.body ?? {});
      res.status(200).json({ ok: true, summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  return router;
}
