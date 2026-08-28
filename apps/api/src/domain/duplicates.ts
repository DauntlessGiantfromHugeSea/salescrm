import { prisma } from '../lib/db.js';
import { normalizeCompanyName } from './parsing.js';

/**
 * Dublettenerkennung (Kapitel 11).
 *
 * Nichts wird automatisch zusammengeführt oder gelöscht – erkannte Paare
 * landen als Vorschlag in Bucket D, die Entscheidung trifft ein Mensch.
 */

export async function detectDuplicates(userId: string): Promise<number> {
  const [companies, contacts] = await Promise.all([
    detectCompanyDuplicates(userId),
    detectContactDuplicates(userId),
  ]);
  return companies + contacts;
}

/** Firmen mit gleichem normalisiertem Namen oder gleicher Maildomain. */
async function detectCompanyDuplicates(userId: string): Promise<number> {
  const groups = await prisma.company.groupBy({
    by: ['nameNormalized'],
    where: { mergedIntoId: null },
    having: { nameNormalized: { _count: { gt: 1 } } },
    _count: { nameNormalized: true },
    orderBy: { nameNormalized: 'asc' },
    take: 200,
  });

  let created = 0;
  for (const group of groups) {
    const members = await prisma.company.findMany({
      where: { nameNormalized: group.nameNormalized, mergedIntoId: null },
      select: { id: true, name: true, emailDomain: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    const [keep, other] = members;
    if (!keep || !other) continue;

    created += await upsertDuplicateReview({
      type: 'DUPLICATE_COMPANY',
      dedupeKey: `dup-company:${[keep.id, other.id].sort().join(':')}`,
      title: `Mögliche Dublette: ${keep.name}`,
      detail:
        `„${keep.name}" (${keep.emailDomain ?? 'keine Domain'}) und „${other.name}" ` +
        `(${other.emailDomain ?? 'keine Domain'}) haben denselben normalisierten Namen. ` +
        'Bitte prüfen und ggf. zusammenführen.',
      userId,
      companyId: keep.id,
      relatedCompanyId: other.id,
    });
  }
  return created;
}

/**
 * Kontakte mit gleichem Namen in derselben Firma.
 * Gleiche Mailadressen können durch die Unique-Bedingung gar nicht doppelt sein –
 * die typische Dublette entsteht durch Adresswechsel (alte und neue Firmenmail).
 */
async function detectContactDuplicates(userId: string): Promise<number> {
  const contacts = await prisma.contact.findMany({
    where: {
      mergedIntoId: null,
      lastName: { not: null },
      OR: [{ ownerId: userId }, { ownerId: null }],
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      companyId: true,
      company: { select: { name: true } },
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 5000,
  });

  const byKey = new Map<string, typeof contacts>();
  for (const contact of contacts) {
    const key = [
      normalizeCompanyName(contact.firstName ?? ''),
      normalizeCompanyName(contact.lastName ?? ''),
      contact.companyId ?? 'nocompany',
    ].join('|');
    if (!key.replace(/\|/g, '').trim()) continue;
    const group = byKey.get(key);
    if (group) group.push(contact);
    else byKey.set(key, [contact]);
  }

  let created = 0;
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const [keep, other] = group;
    if (!keep || !other) continue;

    created += await upsertDuplicateReview({
      type: 'DUPLICATE_CONTACT',
      dedupeKey: `dup-contact:${[keep.id, other.id].sort().join(':')}`,
      title: `Mögliche Dublette: ${[keep.firstName, keep.lastName].filter(Boolean).join(' ')}`,
      detail:
        `${keep.email} und ${other.email} scheinen dieselbe Person zu sein` +
        (keep.company?.name ? ` (${keep.company.name})` : '') +
        '. Bitte prüfen: Adresswechsel oder zwei verschiedene Personen?',
      userId,
      contactId: keep.id,
      relatedContactId: other.id,
    });
  }
  return created;
}

async function upsertDuplicateReview(item: {
  type: 'DUPLICATE_COMPANY' | 'DUPLICATE_CONTACT';
  dedupeKey: string;
  title: string;
  detail: string;
  userId: string;
  companyId?: string;
  relatedCompanyId?: string;
  contactId?: string;
  relatedContactId?: string;
}): Promise<number> {
  const existing = await prisma.reviewItem.findUnique({
    where: { dedupeKey: item.dedupeKey },
    select: { id: true, status: true },
  });
  // "Sind zwei verschiedene Personen" bleibt beantwortet.
  if (existing) return 0;

  await prisma.reviewItem.create({
    data: {
      type: item.type,
      dedupeKey: item.dedupeKey,
      title: item.title,
      detail: item.detail,
      userId: item.userId,
      companyId: item.companyId ?? null,
      relatedCompanyId: item.relatedCompanyId ?? null,
      contactId: item.contactId ?? null,
      relatedContactId: item.relatedContactId ?? null,
    },
  });
  return 1;
}

/**
 * Führt zwei Kontakte zusammen: alle Verknüpfungen wandern zum Zielkontakt,
 * der Quellkontakt bleibt als Verweis erhalten. Bewusst kein echtes Löschen –
 * so bleibt nachvollziehbar, woher ein Datensatz stammt.
 */
export async function mergeContacts(keepId: string, mergeId: string): Promise<void> {
  if (keepId === mergeId) throw new Error('Ein Kontakt kann nicht mit sich selbst zusammengeführt werden');

  const [keep, merge] = await Promise.all([
    prisma.contact.findUnique({ where: { id: keepId } }),
    prisma.contact.findUnique({ where: { id: mergeId } }),
  ]);
  if (!keep || !merge) throw new Error('Kontakt nicht gefunden');

  await prisma.$transaction([
    prisma.activity.updateMany({ where: { contactId: mergeId }, data: { contactId: keepId } }),
    prisma.deal.updateMany({ where: { contactId: mergeId }, data: { contactId: keepId } }),
    // Projektrollen können kollidieren, wenn beide Kontakte im selben Projekt stehen;
    // die Kollisionen werden anschließend entfernt.
    prisma.projectContact.deleteMany({
      where: {
        contactId: mergeId,
        project: { contacts: { some: { contactId: keepId } } },
      },
    }),
    prisma.projectContact.updateMany({ where: { contactId: mergeId }, data: { contactId: keepId } }),
    prisma.contact.update({
      where: { id: keepId },
      data: {
        firstName: keep.firstName ?? merge.firstName,
        lastName: keep.lastName ?? merge.lastName,
        phone: keep.phone ?? merge.phone,
        position: keep.position ?? merge.position,
        companyId: keep.companyId ?? merge.companyId,
        emailCount: keep.emailCount + merge.emailCount,
        lastInboundAt: maxDate(keep.lastInboundAt, merge.lastInboundAt),
        lastOutboundAt: maxDate(keep.lastOutboundAt, merge.lastOutboundAt),
        trustLevel: 'MEDIUM',
      },
    }),
    prisma.contact.update({ where: { id: mergeId }, data: { mergedIntoId: keepId } }),
  ]);
}

export async function mergeCompanies(keepId: string, mergeId: string): Promise<void> {
  if (keepId === mergeId) throw new Error('Eine Firma kann nicht mit sich selbst zusammengeführt werden');

  const [keep, merge] = await Promise.all([
    prisma.company.findUnique({ where: { id: keepId } }),
    prisma.company.findUnique({ where: { id: mergeId } }),
  ]);
  if (!keep || !merge) throw new Error('Firma nicht gefunden');

  await prisma.$transaction([
    prisma.contact.updateMany({ where: { companyId: mergeId }, data: { companyId: keepId } }),
    prisma.deal.updateMany({ where: { companyId: mergeId }, data: { companyId: keepId } }),
    prisma.project.updateMany({ where: { companyId: mergeId }, data: { companyId: keepId } }),
    prisma.projectContact.updateMany({ where: { companyId: mergeId }, data: { companyId: keepId } }),
    prisma.company.update({
      where: { id: keepId },
      data: {
        website: keep.website ?? merge.website,
        emailDomain: keep.emailDomain ?? merge.emailDomain,
        industry: keep.industry ?? merge.industry,
        size: keep.size ?? merge.size,
        profile: keep.profile ?? merge.profile,
        trustLevel: 'MEDIUM',
      },
    }),
    prisma.company.update({ where: { id: mergeId }, data: { mergedIntoId: keepId } }),
  ]);
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
