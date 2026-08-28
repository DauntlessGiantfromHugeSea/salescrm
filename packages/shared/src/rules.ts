import { CLOSED_STAGES, type DealStage } from './enums.js';

/**
 * Konfigurierbare Schwellen der Regel-Engine (Kapitel 8).
 * Die Vorgabewerte entsprechen der Spezifikation; Betreiber können sie
 * über Umgebungsvariablen anpassen, ohne Code zu ändern.
 */
export interface RuleConfig {
  /** Tage ohne Antwort auf eine ausgehende Mail, bis ein Follow-up fällig wird. */
  followUpAfterDays: number;
  /** Tage, ab denen ein Kontakt ohne jede Kommunikation als reaktivierbar gilt. */
  reactivationAfterDays: number;
  /** Ab wie vielen Mails ein Mailpartner beim Import als echter Kontakt gilt. */
  minEmailsForContact: number;
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  followUpAfterDays: 14,
  reactivationAfterDays: 180,
  minEmailsForContact: 3,
};

/** Die Eingaben, die die Regel-Engine über einen Deal braucht. */
export interface DealRuleInput {
  stage: DealStage;
  nextAction: string | null;
  dueDate: Date | null;
  followUpDate: Date | null;
  lastOutboundAt: Date | null;
  lastInboundAt: Date | null;
  hasConfirmedMeeting: boolean;
  hasOverduePlannerTask: boolean;
}

export interface DealRuleResult {
  isOpen: boolean;
  /** Menschenlesbare Begründungen – werden im Dashboard als Chips angezeigt. */
  reasons: string[];
  /** Vom System vorgeschlagene Stufe. Wird nie automatisch geschrieben, außer für FOLLOW_UP_DUE. */
  suggestedStage: DealStage | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * Entscheidet nach Kapitel 8, ob ein Deal offen ist.
 *
 * Die Nicht-offen-Kriterien haben Vorrang: sobald eines greift, ist der Deal
 * unabhängig von allen anderen Signalen nicht offen. Das verhindert, dass ein
 * bereits beantworteter oder bewusst pausierter Deal erneut in der
 * Tagesübersicht auftaucht.
 */
export function evaluateDeal(
  deal: DealRuleInput,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
  now: Date = new Date(),
): DealRuleResult {
  const notOpen: string[] = [];

  if (CLOSED_STAGES.includes(deal.stage)) {
    notOpen.push(`Status ${deal.stage}`);
  }
  if (deal.hasConfirmedMeeting) {
    notOpen.push('Termin bestätigt');
  }
  if (deal.followUpDate && deal.followUpDate.getTime() > now.getTime()) {
    notOpen.push('Wiedervorlage liegt in der Zukunft');
  }
  if (
    deal.lastInboundAt &&
    deal.lastOutboundAt &&
    deal.lastInboundAt.getTime() > deal.lastOutboundAt.getTime()
  ) {
    notOpen.push('Antwort des Kontakts liegt vor');
  }

  if (notOpen.length > 0) {
    return { isOpen: false, reasons: notOpen, suggestedStage: null };
  }

  const reasons: string[] = [];
  let suggestedStage: DealStage | null = null;

  const unansweredDays =
    deal.lastOutboundAt && !isAnswered(deal) ? daysBetween(deal.lastOutboundAt, now) : null;

  if (unansweredDays !== null && unansweredDays >= config.followUpAfterDays) {
    reasons.push(`Seit ${unansweredDays} Tagen keine Antwort`);
    suggestedStage = 'FOLLOW_UP_DUE';
  }
  if (!deal.nextAction || deal.nextAction.trim() === '') {
    reasons.push('Keine nächste Aktion definiert');
  }
  if (deal.dueDate && deal.dueDate.getTime() < now.getTime()) {
    reasons.push('Fälligkeitsdatum überschritten');
    suggestedStage ??= 'FOLLOW_UP_DUE';
  }
  if (deal.hasOverduePlannerTask) {
    reasons.push('Planner-Aufgabe überfällig');
  }
  if (deal.stage === 'FOLLOW_UP_DUE' || deal.stage === 'NEW') {
    reasons.push(`Status ${deal.stage}`);
  }

  return { isOpen: reasons.length > 0, reasons, suggestedStage };
}

function isAnswered(deal: DealRuleInput): boolean {
  if (!deal.lastInboundAt || !deal.lastOutboundAt) return false;
  return deal.lastInboundAt.getTime() > deal.lastOutboundAt.getTime();
}

/**
 * Ordnet einen offenen Deal einem Bucket der Tagesübersicht zu.
 * Deals ohne jede bisherige Kommunikation sind Kaltakquise, Deals mit sehr
 * altem letztem Kontakt Reaktivierung, alles andere Follow-up.
 */
export function classifyBucket(
  deal: Pick<DealRuleInput, 'lastOutboundAt' | 'lastInboundAt'>,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
  now: Date = new Date(),
): 'A_FOLLOW_UP' | 'B_REACTIVATION' | 'C_COLD_OUTREACH' {
  const lastContact = latestDate(deal.lastOutboundAt, deal.lastInboundAt);
  if (!lastContact) return 'C_COLD_OUTREACH';
  if (daysBetween(lastContact, now) >= config.reactivationAfterDays) return 'B_REACTIVATION';
  return 'A_FOLLOW_UP';
}

export function latestDate(...dates: (Date | null | undefined)[]): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}
