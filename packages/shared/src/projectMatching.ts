import { PROJECT_LINK_MIN_SCORE, type LinkMethod } from './projects.js';

/**
 * Zuordnung einer Mail zu einem Bauprojekt.
 *
 * Das ist bewusst eine reine Funktion ohne Datenbankzugriff: sie ist damit
 * testbar und die Zuordnungsregeln stehen an einer Stelle statt verteilt im
 * Sync-Code. Der Aufrufer lädt die Kandidaten, diese Funktion entscheidet.
 */

export interface ProjectCandidate {
  id: string;
  number: string;
  name: string;
  aliases: string[];
  /** Mailadressen aller im Projekt hinterlegten Beteiligten, kleingeschrieben. */
  participantEmails: string[];
  /** Firmendomains der Beteiligten. Schwächeres Signal als die Adresse selbst. */
  participantDomains: string[];
  /** Ist das Projekt noch aktiv? Abgeschlossene Projekte ziehen weniger an. */
  isActive: boolean;
}

export interface MailMatchInput {
  subject: string;
  bodyPreview: string;
  /** Alle beteiligten Mailadressen der Nachricht (From, To, Cc), kleingeschrieben. */
  participantEmails: string[];
  /** Projekt-ID, die bereits an einer früheren Mail desselben Verlaufs hängt. */
  conversationProjectId?: string | null;
  /** Projekt-ID des zugeordneten Deals, falls vorhanden. */
  dealProjectId?: string | null;
}

export interface ProjectMatch {
  projectId: string;
  score: number;
  method: LinkMethod;
  /** Menschenlesbare Begründung – wird im Dashboard neben der Zuordnung angezeigt. */
  reason: string;
}

export interface MatchResult {
  /** Beste Zuordnung, wenn sie sicher genug ist. */
  match: ProjectMatch | null;
  /** Alle bewerteten Kandidaten, absteigend sortiert. */
  ranked: ProjectMatch[];
  /** true, wenn mehrere Projekte gleich gut passen – dann entscheidet ein Mensch. */
  ambiguous: boolean;
}

/**
 * Baut einen Suchausdruck für eine Projektnummer.
 * Erlaubt die üblichen Schreibweisen: "2026-041", "2026/041", "2026 041",
 * optional mit Präfix wie "BV" oder "Projekt".
 */
export function projectNumberPattern(number: string): RegExp {
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexible = escaped.replace(/[-/\s]/g, '[-/\\s]?');
  return new RegExp(`(?<![0-9a-z])${flexible}(?![0-9a-z])`, 'i');
}

/** Normalisiert einen Betreff: Re:/AW:/WG:/Fwd:-Präfixe stören den Vergleich. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|aw|wg|fw|fwd|antw)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim();
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

/**
 * Bewertet jeden Kandidaten und liefert die beste Zuordnung.
 *
 * Punktesystem – die Reihenfolge spiegelt wider, wie verlässlich ein Signal
 * in der Praxis ist:
 *   100  Projektnummer oder Alias steht im Betreff
 *    90  frühere Mail desselben Verlaufs hängt schon am Projekt
 *    85  der zugeordnete Deal gehört zum Projekt
 *  40-75 Beteiligte der Mail sind als Projektbeteiligte hinterlegt
 *    25  nur die Firmendomain passt
 */
export function matchMailToProject(
  mail: MailMatchInput,
  candidates: ProjectCandidate[],
): MatchResult {
  const subject = normalizeSubject(mail.subject);
  const haystack = `${subject}\n${mail.bodyPreview}`;
  const mailAddresses = new Set(mail.participantEmails.map((e) => e.toLowerCase()));
  const mailDomains = new Set(
    [...mailAddresses].map(domainOf).filter((d): d is string => Boolean(d)),
  );

  const ranked: ProjectMatch[] = [];

  for (const project of candidates) {
    let score = 0;
    let method: LinkMethod = 'PARTICIPANTS';
    let reason = '';

    // Projektnummer im Betreff ist das stärkste Signal: eindeutig und vom
    // Absender bewusst gesetzt.
    if (projectNumberPattern(project.number).test(haystack)) {
      score = 100;
      method = 'PROJECT_NUMBER';
      reason = `Projektnummer ${project.number} im Betreff`;
    } else {
      const alias = project.aliases.find((a) => a.length >= 4 && containsPhrase(haystack, a));
      if (alias) {
        score = 92;
        method = 'PROJECT_NUMBER';
        reason = `Projektkennung „${alias}" im Betreff`;
      }
    }

    if (mail.conversationProjectId === project.id && score < 90) {
      score = 90;
      method = 'CONVERSATION';
      reason = 'Frühere Mail desselben Verlaufs gehört zu diesem Projekt';
    }

    if (mail.dealProjectId === project.id && score < 85) {
      score = 85;
      method = 'DEAL';
      reason = 'Der zugeordnete Deal gehört zu diesem Projekt';
    }

    if (score === 0) {
      const matchingParticipants = project.participantEmails.filter((e) => mailAddresses.has(e));
      if (matchingParticipants.length >= 2) {
        // Zwei bekannte Projektbeteiligte in einer Mail sind ein starkes Indiz –
        // typisch für den Verteiler eines Bauvorhabens.
        score = 75;
        reason = `${matchingParticipants.length} Projektbeteiligte in dieser Mail`;
      } else if (matchingParticipants.length === 1) {
        score = 45;
        reason = 'Ein Projektbeteiligter in dieser Mail';
      } else if (project.participantDomains.some((d) => mailDomains.has(d))) {
        score = 25;
        reason = 'Firmendomain eines Projektbeteiligten';
      }
      method = 'PARTICIPANTS';
    }

    // Abgeschlossene Projekte sollen laufende nicht überstimmen.
    if (!project.isActive && score < 90) score = Math.round(score * 0.6);

    if (score > 0) ranked.push({ projectId: project.id, score, method, reason });
  }

  ranked.sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < PROJECT_LINK_MIN_SCORE) {
    return { match: null, ranked, ambiguous: false };
  }

  // Liegen zwei Kandidaten dicht beieinander, ist die Zuordnung nicht sicher
  // genug für eine automatische Entscheidung.
  const runnerUp = ranked[1];
  const ambiguous = Boolean(runnerUp && best.score - runnerUp.score < 15);
  if (ambiguous) return { match: null, ranked, ambiguous: true };

  return { match: best, ranked, ambiguous: false };
}

/** Prüft, ob eine Phrase als eigenständiges Wort im Text vorkommt. */
function containsPhrase(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\d])${escaped}(?![\\p{L}\\d])`, 'iu').test(haystack);
}
