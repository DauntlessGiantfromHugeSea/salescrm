import type { Prisma } from '@prisma/client';
import { classifyBucket, type DealSummary } from '@salescrm/shared';
import { prisma } from '../lib/db.js';
import { config } from '../config.js';
import type { AuthenticatedUser } from '../auth/session.js';
import { contactDisplayName } from '../domain/upsert.js';

/**
 * Sichtbarkeitsregel des Mehrbenutzerbetriebs (Kapitel 5).
 *
 * Ein Kollege sieht: seine eigenen Deals plus alles, was zu einem Projekt
 * gehört, in dem er Teammitglied ist. Damit funktioniert gemeinsame Arbeit an
 * einem Bauvorhaben, ohne dass jeder alles sieht. Ein Administrator sieht alles.
 */
export async function dealVisibilityFilter(user: AuthenticatedUser): Promise<Prisma.DealWhereInput> {
  if (user.role === 'ADMIN') return {};

  const memberships = await prisma.projectMember.findMany({
    where: { userId: user.id },
    select: { projectId: true },
  });
  const projectIds = memberships.map((m) => m.projectId);

  return {
    OR: [
      { ownerId: user.id },
      ...(projectIds.length > 0 ? [{ projectId: { in: projectIds } }] : []),
    ],
  };
}

export async function projectVisibilityFilter(user: AuthenticatedUser): Promise<Prisma.ProjectWhereInput> {
  if (user.role === 'ADMIN') return {};
  return {
    OR: [{ leadUserId: user.id }, { members: { some: { userId: user.id } } }],
  };
}

/** Prüft, ob ein Benutzer ein bestimmtes Projekt bearbeiten darf. */
export async function canEditProject(user: AuthenticatedUser, projectId: string): Promise<boolean> {
  if (user.role === 'ADMIN') return true;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      leadUserId: true,
      members: { where: { userId: user.id }, select: { canEdit: true } },
    },
  });
  if (!project) return false;
  if (project.leadUserId === user.id) return true;
  return project.members[0]?.canEdit ?? false;
}

/** Die Felder, die für eine Deal-Kachel geladen werden müssen. */
export const dealSummarySelect = {
  id: true,
  title: true,
  stage: true,
  serviceArea: true,
  relevance: true,
  nextAction: true,
  dueDate: true,
  followUpDate: true,
  lastContactAt: true,
  lastInboundAt: true,
  lastOutboundAt: true,
  ownerId: true,
  companyId: true,
  contactId: true,
  projectId: true,
  openReasons: true,
  owner: { select: { displayName: true } },
  company: { select: { name: true } },
  contact: { select: { firstName: true, lastName: true, displayName: true, email: true } },
  project: { select: { number: true, name: true } },
  drafts: {
    where: { status: { in: ['DRAFT', 'EDITED', 'APPROVED'] as const } },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.DealSelect;

export type DealSummaryRow = Prisma.DealGetPayload<{ select: typeof dealSummarySelect }>;

export interface DealSummaryDto extends DealSummary {
  projectId: string | null;
  projectNumber: string | null;
  projectName: string | null;
}

export function toDealSummary(deal: DealSummaryRow): DealSummaryDto {
  return {
    id: deal.id,
    title: deal.title,
    stage: deal.stage,
    serviceArea: deal.serviceArea,
    relevance: deal.relevance,
    nextAction: deal.nextAction,
    dueDate: deal.dueDate?.toISOString() ?? null,
    followUpDate: deal.followUpDate?.toISOString() ?? null,
    lastContactAt: deal.lastContactAt?.toISOString() ?? null,
    ownerId: deal.ownerId,
    ownerName: deal.owner.displayName,
    companyId: deal.companyId,
    companyName: deal.company?.name ?? null,
    contactId: deal.contactId,
    contactName: deal.contact ? contactDisplayName(deal.contact) : null,
    contactEmail: deal.contact?.email ?? null,
    hasDraft: deal.drafts.length > 0,
    openReasons: deal.openReasons,
    projectId: deal.projectId,
    projectNumber: deal.project?.number ?? null,
    projectName: deal.project?.name ?? null,
  };
}

/**
 * Ordnet einen Deal einem der drei Deal-Buckets zu.
 * Bucket D enthält Prüfaufgaben statt Deals und kommt hier nicht vor.
 */
export type DealBucket = 'A_FOLLOW_UP' | 'B_REACTIVATION' | 'C_COLD_OUTREACH';

export function bucketOf(deal: DealSummaryRow, now = new Date()): DealBucket {
  return classifyBucket(
    { lastOutboundAt: deal.lastOutboundAt, lastInboundAt: deal.lastInboundAt },
    config.ruleConfig,
    now,
  );
}
