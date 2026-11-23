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
import { BaileysGroupService } from './services/baileysGroupService.js';
import { MetaCapiService } from './services/metaCapiService.js';
import { ShopeeAffiliateClient } from './services/shopeeAffiliateClient.js';
import { TrackerService } from './services/trackerService.js';
import { WhatsAppCloudService } from './services/whatsappCloudService.js';

export interface HubAppContext {
  app: Express;
  config: AppConfig;
  db: HubDatabase;
  tracker: TrackerService;
  baileys: BaileysGroupService;
  whatsappCloud: WhatsAppCloudService;
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
  const ai = new AiService();
  const tracker = new TrackerService(db, config, shopee, metaCapi);
  const baileys = new BaileysGroupService(db, config, shopee, ai);
  const whatsappCloud = new WhatsAppCloudService(db, config, ai);
  const crons = new CronManager(db, tracker, baileys);

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
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
      crons
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
    crons,
    close
  };
}
