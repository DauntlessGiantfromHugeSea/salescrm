/**
 * Domänen-Enums nach Spezifikation v1.2.
 * Diese Werte sind der Vertrag zwischen API, Worker und Dashboard.
 * Änderungen hier erfordern eine Prisma-Migration (siehe apps/api/prisma/schema.prisma).
 */

/** Pipeline-Stufen aus Kapitel 7 der Spezifikation. */
export const DEAL_STAGES = [
  'NEW',
  'OPEN',
  'AWAITING_REPLY',
  'FOLLOW_UP_DUE',
  'IN_CLARIFICATION',
  'MEETING_SCHEDULED',
  'PROPOSAL_IN_PROGRESS',
  'PROPOSAL_SENT',
  'WON',
  'LOST',
  'ON_HOLD',
  'NEEDS_REVIEW',
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/** Deutsche Beschriftungen für das Dashboard. */
export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  NEW: 'Neu',
  OPEN: 'Offen',
  AWAITING_REPLY: 'Wartet auf Antwort',
  FOLLOW_UP_DUE: 'Follow-up fällig',
  IN_CLARIFICATION: 'In Klärung',
  MEETING_SCHEDULED: 'Termin vereinbart',
  PROPOSAL_IN_PROGRESS: 'Angebot in Arbeit',
  PROPOSAL_SENT: 'Angebot versendet',
  WON: 'Gewonnen',
  LOST: 'Verloren',
  ON_HOLD: 'Pausiert',
  NEEDS_REVIEW: 'Unklar / zu prüfen',
};

/**
 * Stufen, in denen ein Deal per Definition nicht offen ist (Kapitel 8).
 * Wird sowohl von der Regel-Engine als auch vom Dashboard-Filter benutzt.
 */
export const CLOSED_STAGES: readonly DealStage[] = ['WON', 'LOST', 'ON_HOLD'];

/** Die drei Entwurfstypen aus Kapitel 10.1. */
export const DRAFT_TYPES = ['FOLLOW_UP', 'REACTIVATION', 'COLD_OUTREACH'] as const;
export type DraftType = (typeof DRAFT_TYPES)[number];

export const DRAFT_TYPE_LABELS: Record<DraftType, string> = {
  FOLLOW_UP: 'Follow-up',
  REACTIVATION: 'Reaktivierung',
  COLD_OUTREACH: 'Kaltakquise',
};

/**
 * Lebenszyklus eines Entwurfs. Ein Entwurf verlässt DRAFT/EDITED nur über eine
 * explizite Freigabe des Benutzers – automatischer Versand existiert nicht.
 */
export const DRAFT_STATUSES = [
  'DRAFT',
  'EDITED',
  'APPROVED',
  'SENDING',
  'SENT',
  'FAILED',
  'DISCARDED',
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Buckets der Tagesübersicht aus Kapitel 9.1. */
export const BUCKETS = ['A_FOLLOW_UP', 'B_REACTIVATION', 'C_COLD_OUTREACH', 'D_CONFLICTS'] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_LABELS: Record<Bucket, string> = {
  A_FOLLOW_UP: 'A – Follow-up',
  B_REACTIVATION: 'B – Reaktivierung',
  C_COLD_OUTREACH: 'C – Kaltakquise',
  D_CONFLICTS: 'D – Konflikte & Prüfungen',
};

/** Benutzerrollen. ADMIN sieht alle Deals, USER nur die eigenen. */
export const USER_ROLES = ['ADMIN', 'USER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Vertrauensniveau importierter Daten – nie automatisch gelöscht, nur markiert. */
export const TRUST_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'UNVERIFIED'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const RELEVANCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type RelevanceLevel = (typeof RELEVANCE_LEVELS)[number];

export const DECISION_MAKER_LEVELS = ['DECISION_MAKER', 'INFLUENCER', 'UNKNOWN'] as const;
export type DecisionMakerLevel = (typeof DECISION_MAKER_LEVELS)[number];

export const ACTIVITY_DIRECTIONS = ['INBOUND', 'OUTBOUND', 'INTERNAL'] as const;
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number];

export const ACTIVITY_CHANNELS = ['EMAIL', 'PHONE', 'MEETING', 'NOTE', 'TASK'] as const;
export type ActivityChannel = (typeof ACTIVITY_CHANNELS)[number];

/** Herkunft eines Datensatzes – wichtig für die Bewertung der Datenqualität. */
export const SOURCES = ['OUTLOOK', 'MANUAL', 'BOOKING', 'IMPORT', 'LINKEDIN'] as const;
export type Source = (typeof SOURCES)[number];

/** Typen der Prüf-/Konfliktliste (Bucket D). */
export const REVIEW_TYPES = [
  'DUPLICATE_CONTACT',
  'DUPLICATE_COMPANY',
  'UNCLEAR_ASSIGNMENT',
  'PLANNER_TASK_ORPHANED',
  'PLANNER_TASK_MISSING',
  'PLANNER_TASK_OVERDUE',
  'MEETING_WITHOUT_DEAL',
  'STALE_DEAL',
] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

export const REVIEW_TYPE_LABELS: Record<ReviewType, string> = {
  DUPLICATE_CONTACT: 'Möglicher Dublette-Kontakt',
  DUPLICATE_COMPANY: 'Mögliche Dublette-Firma',
  UNCLEAR_ASSIGNMENT: 'Unklare Zuordnung',
  PLANNER_TASK_ORPHANED: 'Planner-Aufgabe offen, Deal geschlossen',
  PLANNER_TASK_MISSING: 'Follow-up fällig, keine Planner-Aufgabe',
  PLANNER_TASK_OVERDUE: 'Planner-Aufgabe überfällig',
  MEETING_WITHOUT_DEAL: 'Termin ohne zugeordneten Deal',
  STALE_DEAL: 'Deal ohne nächste Aktion',
};

export const REVIEW_STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const MEETING_STATUSES = ['SCHEDULED', 'HELD', 'CANCELLED', 'NO_SHOW'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
