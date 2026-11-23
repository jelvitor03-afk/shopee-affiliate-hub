import cron, { ScheduledTask } from 'node-cron';
import { HubDatabase } from '../db/database.js';
import { BaileysGroupService } from '../services/baileysGroupService.js';
import { TrackerService } from '../services/trackerService.js';

export class CronManager {
  private trackerTask: ScheduledTask | null = null;
  private groupTask: ScheduledTask | null = null;

  constructor(
    private readonly db: HubDatabase,
    private readonly tracker: TrackerService,
    private readonly baileys: BaileysGroupService
  ) {}

  start(): void {
    this.stop();

    // Sync Shopee conversionReport -> Meta CAPI every 15 minutes
    this.trackerTask = cron.schedule('*/15 * * * *', () => {
      void this.tracker.syncConversionsNow().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.db.addLog('error', 'cron', 'Falha no job automatico de conversoes.', msg);
      });
    });

    const settings = this.db.getAllSettings();
    if (settings.group_dispatch_enabled === 'true') {
      const intervalMin = Math.min(
        720,
        Math.max(5, Number.parseInt(settings.group_interval_minutes || '60', 10) || 60)
      );
      const expression =
        intervalMin >= 60
          ? `0 */${Math.max(1, Math.round(intervalMin / 60))} * * *`
          : `*/${intervalMin} * * * *`;

      this.groupTask = cron.schedule(expression, () => {
        void this.baileys.dispatchNextOffer().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.db.addLog(
            'error',
            'cron',
            'Falha no disparo automatico de achadinhos.',
            msg
          );
        });
      });
    }
  }

  reload(): void {
    this.start();
  }

  stop(): void {
    if (this.trackerTask) {
      this.trackerTask.stop();
      this.trackerTask = null;
    }
    if (this.groupTask) {
      this.groupTask.stop();
      this.groupTask = null;
    }
  }
}
