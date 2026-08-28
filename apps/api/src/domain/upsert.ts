import type { Company, Contact, Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { config } from '../config.js';
import {
  companyNameFromDomain,
  emailDomain,
  isAutomatedSender,
  isGenericDomain,
  normalizeCompanyName,
  splitDisplayName,
} from './parsing.js';

/**
 * Idempotentes Anlegen von Firmen und Kontakten.
 *
 * Der Schlüssel ist die Mailadresse (Contact.email ist unique) bzw. die
 * Maildomain (Company.emailDomain). Dadurch kann derselbe Import beliebig oft
 * laufen, ohne Dubletten zu erzeugen – die Anforderung aus Kapitel 16.
 */

export interface ContactUpsertInput {
  email: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  position?: string | null;
  companyName?: string | null;
  website?: string | null;
  ownerId: string;
  source?: 'OUTLOOK' | 'MANUAL' | 'BOOKING' | 'IMPORT' | 'LINKEDIN';
}

export function isInternalAddress(email: string): boolean {
  const domain = emailDomain(email);
  return domain ? config.internalEmailDomains.includes(domain) : false;
}

/**
 * Prüft, ob eine Adresse überhaupt als Geschäftskontakt taugt.
 * Automatische Absender und die eigenen Kolleg:innen werden übersprungen.
 */
export function isEligibleContact(email: string): boolean {
  if (!email.includes('@')) return false;
  if (isAutomatedSender(email)) return false;
  if (isInternalAddress(email)) return false;
  return true;
}

export async function upsertCompany(input: {
  name: string | null;
  domain: string | null;
  website?: string | null;
  ownerId: string;
  source?: ContactUpsertInput['source'];
}): Promise<Company | null> {
  const { domain, ownerId } = input;
  const usableDomain = domain && !isGenericDomain(domain) ? domain : null;
  const name = input.name ?? (usableDomain ? companyNameFromDomain(usableDomain) : null);
  if (!name) return null;

  const nameNormalized = normalizeCompanyName(name);
  if (!nameNormalized) return null;

  // Domain schlägt Name: sie ist das verlässlichere Signal.
  const existing = usableDomain
    ? await prisma.company.findFirst({ where: { emailDomain: usableDomain, mergedIntoId: null } })
    : await prisma.company.findFirst({ where: { nameNormalized, mergedIntoId: null } });

  if (existing) {
    const patch: Prisma.CompanyUpdateInput = {};
    if (!existing.website && input.website) patch.website = input.website;
    if (!existing.emailDomain && usableDomain) patch.emailDomain = usableDomain;
    // Ein aus der Signatur gelesener Name ist besser als ein aus der Domain geratener.
    if (input.name && existing.name !== input.name && existing.trustLevel === 'UNVERIFIED') {
      patch.name = input.name;
      patch.nameNormalized = nameNormalized;
      patch.trustLevel = 'LOW';
    }
    if (Object.keys(patch).length === 0) return existing;
    return prisma.company.update({ where: { id: existing.id }, data: patch });
  }

  return prisma.company.create({
    data: {
      name,
      nameNormalized,
      emailDomain: usableDomain,
      website: input.website ?? null,
      ownerId,
      source: input.source ?? 'OUTLOOK',
      trustLevel: input.name ? 'LOW' : 'UNVERIFIED',
    },
  });
}

export async function upsertContact(input: ContactUpsertInput): Promise<Contact | null> {
  const email = input.email.toLowerCase().trim();
  if (!isEligibleContact(email)) return null;

  const domain = emailDomain(email);
  const names =
    input.firstName || input.lastName
      ? { firstName: input.firstName ?? null, lastName: input.lastName ?? null }
      : splitDisplayName(input.displayName ?? '');

  const existing = await prisma.contact.findUnique({ where: { email } });

  const company = await upsertCompany({
    name: input.companyName ?? null,
    domain,
    website: input.website ?? null,
    ownerId: input.ownerId,
    source: input.source,
  });

  if (existing) {
    // Vorhandene Werte werden nur ergänzt, nie überschrieben – die
    // Nicht-automatisch-ändern-Regel aus Kapitel 4.3.
    const patch: Prisma.ContactUpdateInput = {};
    if (!existing.firstName && names.firstName) patch.firstName = names.firstName;
    if (!existing.lastName && names.lastName) patch.lastName = names.lastName;
    if (!existing.displayName && input.displayName) patch.displayName = input.displayName;
    if (!existing.phone && input.phone) patch.phone = input.phone;
    if (!existing.position && input.position) patch.position = input.position;
    if (!existing.companyId && company) patch.company = { connect: { id: company.id } };
    if (Object.keys(patch).length === 0) return existing;
    return prisma.contact.update({ where: { id: existing.id }, data: patch });
  }

  return prisma.contact.create({
    data: {
      email,
      firstName: names.firstName,
      lastName: names.lastName,
      displayName: input.displayName ?? null,
      phone: input.phone ?? null,
      position: input.position ?? null,
      companyId: company?.id ?? null,
      ownerId: input.ownerId,
      source: input.source ?? 'OUTLOOK',
      trustLevel: 'UNVERIFIED',
    },
  });
}

export function contactDisplayName(contact: {
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string;
}): string {
  const full = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  return full || contact.displayName || contact.email;
}
