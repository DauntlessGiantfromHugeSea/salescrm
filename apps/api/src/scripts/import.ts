/**
 * Steuert den historischen Erstimport von der Kommandozeile.
 *
 * Der Import ist laut Spezifikation ein eigenes Teilprojekt mit eigener
 * Abnahme – deshalb ein Skript, das man beobachten und stufenweise ausführen
 * kann, statt ihn stillschweigend im Nachtlauf mitzuziehen.
 *
 *   npm run import -w @salescrm/api -- --list
 *   npm run import -w @salescrm/api -- --mailbox info@example.de
 *   npm run import -w @salescrm/api -- --all
 */
import { prisma, disconnectDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { syncMailbox } from '../graph/mailSync.js';
import { activeMailboxes } from '../graph/mailboxRegistry.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const mailboxes = await prisma.mailbox.findMany({
      include: { ownerUser: { select: { displayName: true } } },
      orderBy: { address: 'asc' },
    });
    for (const m of mailboxes) {
      const state = m.syncEnabled ? (m.initialImportDone ? 'aktiv' : 'Erstimport läuft') : 'deaktiviert';
      console.log(
        `${m.address.padEnd(40)} ${m.authMode.padEnd(10)} ${state.padEnd(18)} ` +
          `${m.messagesSynced} Mails  Zuständig: ${m.ownerUser?.displayName ?? '– nicht gesetzt –'}`,
      );
    }
    return;
  }

  const mailboxArg = args.indexOf('--mailbox');
  const targets =
    mailboxArg >= 0 && args[mailboxArg + 1]
      ? await prisma.mailbox.findMany({ where: { address: args[mailboxArg + 1]!.toLowerCase() } })
      : args.includes('--all')
        ? await activeMailboxes()
        : [];

  if (targets.length === 0) {
    console.error('Nichts zu tun. Verwendung: --list | --mailbox <adresse> | --all');
    process.exitCode = 1;
    return;
  }

  for (const mailbox of targets) {
    if (!mailbox.ownerUserId) {
      logger.warn({ address: mailbox.address }, 'Übersprungen: kein zuständiger Kollege eingetragen');
      continue;
    }

    // Bis der Ordner vollständig durch ist, immer weiter – ein Aufruf holt
    // nur einen Block, damit der Speicher nicht vollläuft.
    for (let round = 1; round <= 200; round++) {
      const results = await syncMailbox(mailbox, { maxMessagesPerFolder: 2000 });
      const processed = results.reduce((sum, r) => sum + r.messagesProcessed, 0);
      const more = results.some((r) => r.reachedLimit);
      logger.info({ address: mailbox.address, round, processed, more }, 'Importblock abgeschlossen');
      if (!more || processed === 0) break;
    }
  }
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Import fehlgeschlagen');
    process.exit(1);
  })
  .finally(() => void disconnectDb());
