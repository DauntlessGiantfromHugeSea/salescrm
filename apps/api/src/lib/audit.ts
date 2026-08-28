import { prisma } from './db.js';
import { logger } from './logger.js';

/**
 * Protokolliert alles mit Außenwirkung: Freigaben, Versand, Termine, Zusammenführungen.
 * Fehler beim Protokollieren dürfen die eigentliche Aktion nie scheitern lassen –
 * aber sie werden geloggt, damit eine kaputte Protokollierung auffällt.
 */
export async function audit(entry: {
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        detail: (entry.detail ?? {}) as object,
        ip: entry.ip ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'Audit-Eintrag konnte nicht geschrieben werden');
  }
}
