import { prisma } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { graphDelta } from './client.js';
import type { GraphContact } from './types.js';
import { normalizePhone } from '../domain/parsing.js';
import { isEligibleContact, upsertContact } from '../domain/upsert.js';

/**
 * Importiert das Outlook-Adressbuch.
 *
 * Adressbuchkontakte sind manuell gepflegt und damit deutlich verlässlicher
 * als aus Signaturen geratene Daten – sie bekommen deshalb ein höheres
 * Vertrauensniveau und dürfen bestehende Platzhalterwerte überschreiben.
 */
export async function syncContacts(userId: string): Promise<{ imported: number; updated: number }> {
  const resource = 'contacts';
  const state = await prisma.syncState.findUnique({
    where: { userId_resource: { userId, resource } },
  });

  const startUrl =
    state?.deltaLink ??
    '/me/contacts/delta?$select=id,displayName,givenName,surname,jobTitle,companyName,emailAddresses,businessPhones,mobilePhone';

  const { items, deltaLink } = await graphDelta<GraphContact>(userId, startUrl, { maxItems: 5000 });

  let imported = 0;
  let updated = 0;

  for (const item of items) {
    if (item['@removed']) continue;
    const email = item.emailAddresses?.[0]?.address?.toLowerCase().trim();
    if (!email || !isEligibleContact(email)) continue;

    const phone = item.mobilePhone ?? item.businessPhones?.[0] ?? null;
    const before = await prisma.contact.findUnique({ where: { email }, select: { id: true } });

    const contact = await upsertContact({
      email,
      displayName: item.displayName ?? null,
      firstName: item.givenName ?? null,
      lastName: item.surname ?? null,
      phone: phone ? normalizePhone(phone) : null,
      position: item.jobTitle ?? null,
      companyName: item.companyName ?? null,
      ownerId: userId,
      source: 'OUTLOOK',
    });
    if (!contact) continue;

    // Adressbuchdaten sind gepflegt: Vertrauensniveau anheben und fehlende
    // Felder auffüllen, ohne bereits vorhandene Werte zu verwerfen.
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        trustLevel: 'MEDIUM',
        ...(item.givenName && !contact.firstName ? { firstName: item.givenName } : {}),
        ...(item.surname && !contact.lastName ? { lastName: item.surname } : {}),
        ...(item.jobTitle && !contact.position ? { position: item.jobTitle } : {}),
        ...(phone && !contact.phone ? { phone: normalizePhone(phone) } : {}),
      },
    });

    if (before) updated++;
    else imported++;
  }

  await prisma.syncState.upsert({
    where: { userId_resource: { userId, resource } },
    create: { userId, resource, deltaLink, lastRunAt: new Date(), itemsSynced: items.length, backfillDone: true },
    update: { deltaLink, lastRunAt: new Date(), lastError: null, itemsSynced: { increment: items.length } },
  });

  logger.info({ userId, imported, updated }, 'Outlook-Kontakte synchronisiert');
  return { imported, updated };
}
