import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { Express } from 'express';
import { AppConfig } from './config/env.js';
import { HubDatabase } from './db/database.js';
import { createAdminRoutes } from './routes/adminRoutes.js';
import { createPublicRoutes } from './routes/publicRoutes.js';
import { CronManager } from './scheduler/cronManager.js';
import { AiService } from './services/aiService.js';
import { AntiBanService } from './services/antiBanService.js';
import { BaileysGroupService } from './services/baileysGroupService.js';
import { CampaignDashboardService } from './services/campaignDashboardService.js';
import { MetaAdsService } from './services/metaAdsService.js';
import { MetaCapiService } from './services/metaCapiService.js';
import { RagJevService } from './services/ragJevService.js';
import { ShopeeAffiliateClient } from './services/shopeeAffiliateClient.js';
import { TrackerService } from './services/trackerService.js';
import { VoiceService } from './services/voiceService.js';
import { WhatsAppCloudService } from './services/whatsappCloudService.js';
import { X1Orchestrator } from './services/x1Orchestrator.js';

export interface HubAppContext {
  app: Express;
  config: AppConfig;
  db: HubDatabase;
  tracker: TrackerService;
  baileys: BaileysGroupService;
  whatsappCloud: WhatsAppCloudService;
  campaignDashboard: CampaignDashboardService;
  voice: VoiceService;
  antiBan: AntiBanService;
  ragJev: RagJevService;
  x1: X1Orchestrator;
  crons: CronManager;
  close: () => void;
}

export function createHubApp(
  config: AppConfig,
  options: { startCrons?: boolean; autoConnectBaileys?: boolean } = {}
): HubAppContext {
  const db = new HubDatabase(config);
  const shopee = new ShopeeAffiliateClient();
  const metaCapi = new MetaCapiService();
  const metaAds = new MetaAdsService();
  const ai = new AiService();
  const voice = new VoiceService(db, config);
  const antiBan = new AntiBanService(db, config);
  const ragJev = new RagJevService(db);
  const x1 = new X1Orchestrator(db, config, ai, voice, antiBan, ragJev);

  const tracker = new TrackerService(db, config, shopee, metaCapi);
  const campaignDashboard = new CampaignDashboardService(
    db,
    config,
    metaAds,
    shopee
  );
  const baileys = new BaileysGroupService(
    db,
    config,
    shopee,
    ai,
    antiBan,
    x1
  );
  const whatsappCloud = new WhatsAppCloudService(
    db,
    config,
    voice,
    antiBan,
    x1
  );
  const crons = new CronManager(db, tracker, baileys);

  const app = express();
  app.set('trust proxy', true);
  app.use(
    express.json({
      limit: '15mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      }
    })
  );
  app.use(cookieParser());

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicAdminDir = path.resolve(__dirname, '../public/admin');
  app.use('/admin', express.static(publicAdminDir));

  app.use('/', createPublicRoutes(tracker, whatsappCloud));
  app.use(
    '/api/admin',
    createAdminRoutes({
      db,
      config,
      tracker,
      metaCapi,
      baileys,
      crons,
      campaignDashboard,
      voice,
      antiBan
    })
  );

  if (options.startCrons ?? true) {
    crons.start();
  }
  if (options.autoConnectBaileys ?? true) {
    baileys.autoStartIfAuthenticated();
  }

  const close = (): void => {
    crons.stop();
    antiBan.shutdown();
    baileys.shutdown();
    db.close();
  };

  return {
    app,
    config,
    db,
    tracker,
    baileys,
    whatsappCloud,
    campaignDashboard,
    voice,
    antiBan,
    ragJev,
    x1,
    crons,
    close
  };
}
