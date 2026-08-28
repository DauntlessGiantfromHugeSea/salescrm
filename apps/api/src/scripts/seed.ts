/**
 * Legt die Grunddaten an, die das System zum Starten braucht.
 * Idempotent: mehrfaches Ausführen ändert nichts.
 */
import { config } from '../config.js';
import { prisma, disconnectDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';

async function main(): Promise<void> {
  const adminEmail = config.BOOTSTRAP_ADMIN_EMAIL;
  if (adminEmail) {
    const admin = await prisma.user.upsert({
      where: { email: adminEmail.toLowerCase() },
      create: {
        email: adminEmail.toLowerCase(),
        displayName: adminEmail.split('@')[0] ?? adminEmail,
        role: 'ADMIN',
      },
      update: { role: 'ADMIN', active: true },
      select: { id: true, email: true },
    });
    logger.info({ email: admin.email }, 'Administrator angelegt');
  } else {
    logger.warn('BOOTSTRAP_ADMIN_EMAIL ist nicht gesetzt – der erste Anmeldende wird Administrator');
  }

  const counts = {
    users: await prisma.user.count(),
    mailboxes: await prisma.mailbox.count(),
    projects: await prisma.project.count(),
    deals: await prisma.deal.count(),
    contacts: await prisma.contact.count(),
  };
  logger.info(counts, 'Datenbestand');
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Seed fehlgeschlagen');
    process.exit(1);
  })
  .finally(() => void disconnectDb());
