import { Worker } from 'bullmq';
import { logger } from './lib/logger.js';
import { disconnectDb } from './lib/db.js';
import { QUEUE_NAME, closeQueue, connection, enqueue } from './jobs/queue.js';
import { createWorker } from './jobs/worker.js';
import { fanOutDailyScan, fanOutNightlySync, registerSchedules } from './jobs/scheduler.js';

/**
 * Worker-Prozess. Läuft getrennt vom Webserver (eigener Container),
 * damit lange Importe und die API sich nicht gegenseitig behindern.
 */
async function main(): Promise<void> {
  await registerSchedules();

  const jobWorker = createWorker();

  // Die Zeitplan-Jobs verteilen nur; die eigentliche Arbeit erledigen die
  // aufgefächerten Einzeljobs im Haupt-Worker.
  const scheduleWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      switch (job.name) {
        case 'nightly-sync':
          return fanOutNightlySync();
        case 'daily-scan':
          return fanOutDailyScan();
        case 'transcript-fetch':
          return enqueue('transcript.fetch', {});
        default:
          return null;
      }
    },
    { connection, concurrency: 1 },
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker wird beendet');
    // Laufende Jobs zu Ende bringen, statt sie mitten im Import abzuschneiden.
    await Promise.all([jobWorker.close(), scheduleWorker.close()]);
    await closeQueue();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('Worker bereit');
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker-Start fehlgeschlagen');
  process.exit(1);
});
