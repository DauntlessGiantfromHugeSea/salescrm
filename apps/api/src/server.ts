import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { prisma, disconnectDb } from './lib/db.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { dealRoutes } from './routes/deals.js';
import { draftRoutes } from './routes/drafts.js';
import { projectRoutes } from './routes/projects.js';
import { meetingRoutes } from './routes/meetings.js';
import { bookingRoutes } from './routes/booking.js';
import { reviewRoutes } from './routes/reviews.js';
import { adminRoutes } from './routes/admin.js';
import { exportRoutes } from './routes/export.js';
import { contactRoutes } from './routes/contacts.js';

export async function buildServer() {
  const app = Fastify({
    logger,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });

  // Das Dashboard wird vom selben Ursprung ausgeliefert; CORS ist nur für die
  // lokale Entwicklung nötig, wo Vite auf einem anderen Port läuft.
  await app.register(cors, {
    origin: config.isProduction ? config.PUBLIC_BASE_URL : true,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Die öffentliche Buchungsroute bekommt in ihrem Modul eine eigene, engere Grenze.
    allowList: () => false,
  });

  app.get('/api/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', time: new Date().toISOString() };
  });

  /**
   * Sagt der Anmeldeseite, ob eine Anmeldung ohne Microsoft angeboten werden
   * soll. Ohne Anmeldung erreichbar, verrät aber nichts über den Datenbestand.
   */
  app.get('/api/health/demo', async () => ({
    demoMode: config.DEMO_MODE,
    hasMicrosoft: config.hasMicrosoft,
    hasAi: config.hasAi,
  }));

  await app.register(authRoutes);
  await app.register(dashboardRoutes);
  await app.register(dealRoutes);
  await app.register(draftRoutes);
  await app.register(projectRoutes);
  await app.register(contactRoutes);
  await app.register(meetingRoutes);
  await app.register(bookingRoutes);
  await app.register(reviewRoutes);
  await app.register(exportRoutes);
  await app.register(adminRoutes);

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'Unbehandelter Fehler');
    }
    // Interne Fehlertexte gehen nicht an den Client.
    void reply.status(status).send({
      error: status >= 500 ? 'internal_error' : error.code ?? 'request_failed',
      message: status >= 500 ? 'Interner Fehler' : error.message,
    });
  });

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Server wird beendet');
    await app.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  if (config.DEMO_MODE) {
    logger.warn(
      `DEMO-MODUS: Anmeldung ohne Microsoft unter ${config.PUBLIC_BASE_URL}/api/auth/demo-login. ` +
        'Nicht für den Produktivbetrieb.',
    );
  }
  logger.info(
    {
      port: config.PORT,
      baseUrl: config.PUBLIC_BASE_URL,
      microsoft: config.hasMicrosoft,
      ki: config.hasAi,
    },
    'API bereit',
  );
}

// Nur starten, wenn die Datei direkt ausgeführt wird – nicht beim Import in Tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    logger.fatal({ err }, 'Start fehlgeschlagen');
    process.exit(1);
  });
}
