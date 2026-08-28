/**
 * Textextraktion aus Mails. Bewusst regelbasiert und konservativ:
 * ein falsch erkannter Firmenname kostet später Aufräumarbeit, ein nicht
 * erkannter kostet nur einen manuellen Klick.
 */

const HTML_TAG = /<[^>]+>/g;
const WHITESPACE = /[ \t ]+/g;

/** Wandelt einen HTML-Mailbody in lesbaren Klartext um. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(HTML_TAG, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(WHITESPACE, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Schneidet zitierte Vorgänger-Mails ab. Ohne das landet bei langen Threads
 * die halbe Historie in jedem einzelnen Aktivitätseintrag.
 */
export function stripQuotedReply(text: string): string {
  const markers = [
    /^-{2,}\s*Ursprüngliche Nachricht\s*-{2,}$/im,
    /^-{2,}\s*Original Message\s*-{2,}$/im,
    /^Von:\s.+$/im,
    /^From:\s.+$/im,
    /^Am .+ schrieb .+:$/im,
    /^On .+ wrote:$/im,
    /^_{10,}$/m,
  ];
  let cut = text.length;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && match.index < cut) cut = match.index;
  }
  return text.slice(0, cut).trim();
}

const SIGNATURE_MARKERS = [
  /^--\s*$/m,
  /^Mit freundlichen Grüßen/im,
  /^Freundliche Grüße/im,
  /^Viele Grüße/im,
  /^Beste Grüße/im,
  /^Kind regards/im,
  /^Best regards/im,
];

/** Trennt den Nachrichtentext von der Signatur. */
export function splitSignature(text: string): { body: string; signature: string | null } {
  for (const marker of SIGNATURE_MARKERS) {
    const match = marker.exec(text);
    if (match) {
      return {
        body: text.slice(0, match.index).trim(),
        signature: text.slice(match.index).trim() || null,
      };
    }
  }
  return { body: text, signature: null };
}

export interface SignatureData {
  phone: string | null;
  position: string | null;
  website: string | null;
  companyName: string | null;
}

const PHONE = /(?:Tel\.?|Telefon|Phone|Mobil|Mobile|T|M)[:\s]*(\+?[\d\s()./-]{7,25})/i;
const WEBSITE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]{1,61}\.[a-z]{2,}(?:\/[^\s]*)?)/i;
const LEGAL_FORMS =
  /\b(GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|OHG|UG(?:\s*\(haftungsbeschränkt\))?|e\.?V\.?|mbH|SE|Ltd\.?|LLC|Inc\.?|B\.?V\.?|S\.?A\.?|GbR|PartG(?:mbB)?)\b/i;

const POSITION_HINTS =
  /(Geschäftsführ|Inhaber|Vorstand|Prokurist|Leiter|Leitung|Head of|Director|Manager|Ingenieur|Projektleit|Vertrieb|Sales|Einkauf|Bauleit|Architekt|Planer|CEO|CTO|CFO|COO)/i;

/**
 * Liest die Felder aus einer Signatur, die für Kontakt- und Firmenanlage zählen.
 * Alles Erkannte wird als Vorschlag behandelt und mit niedrigem Vertrauensniveau
 * gespeichert – niemals als gesicherte Wahrheit.
 */
export function parseSignature(signature: string): SignatureData {
  const lines = signature
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const phoneMatch = PHONE.exec(signature);
  const phone = phoneMatch?.[1] ? normalizePhone(phoneMatch[1]) : null;

  const websiteLine = lines.find((l) => WEBSITE.test(l) && !l.includes('@'));
  const websiteMatch = websiteLine ? WEBSITE.exec(websiteLine) : null;
  const website = websiteMatch?.[1] ? normalizeWebsite(websiteMatch[1]) : null;

  const companyLine = lines.find((l) => LEGAL_FORMS.test(l));
  const companyName = companyLine ? cleanCompanyLine(companyLine) : null;

  const positionLine = lines.find((l) => POSITION_HINTS.test(l) && l.length < 80 && !LEGAL_FORMS.test(l));

  return {
    phone,
    position: positionLine ?? null,
    website,
    companyName,
  };
}

function cleanCompanyLine(line: string): string {
  return line
    .replace(/^[|•\-*\s]+/, '')
    .replace(/\s*\|\s*.*$/, '')
    .trim()
    .slice(0, 200);
}

export function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, '').slice(0, 25);
}

export function normalizeWebsite(raw: string): string {
  const trimmed = raw.trim().replace(/[.,;)]+$/, '');
  return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
}

/**
 * Normalisiert einen Firmennamen für den Dublettenabgleich:
 * Rechtsform, Sonderzeichen und Groß-/Kleinschreibung fallen weg,
 * damit "Müller Bau GmbH" und "mueller bau gmbh" zusammenfinden.
 */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(LEGAL_FORMS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Freemail- und Providerdomains taugen nicht als Firmenkennung. */
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'web.de', 'gmx.de', 'gmx.net', 'gmx.at', 't-online.de',
  'outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'live.com', 'live.de',
  'yahoo.com', 'yahoo.de', 'icloud.com', 'me.com', 'aol.com', 'freenet.de',
  'posteo.de', 'mailbox.org', 'protonmail.com', 'proton.me', 'arcor.de', 'online.de',
]);

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  return email.slice(at + 1).toLowerCase() || null;
}

export function isGenericDomain(domain: string): boolean {
  return GENERIC_DOMAINS.has(domain.toLowerCase());
}

/** Automatische Absender, die niemals als Kontakt angelegt werden sollen. */
const NOREPLY = /^(no-?reply|do-?not-?reply|noreply|postmaster|mailer-daemon|bounce|notification|newsletter|info@newsletter|automat|system|admin|abuse|support@.*(atlassian|jira|slack|zoom)\.)/i;

export function isAutomatedSender(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return NOREPLY.test(local) || NOREPLY.test(email);
}

/** Leitet aus einer Domain einen brauchbaren Firmennamen ab, wenn nichts anderes vorliegt. */
export function companyNameFromDomain(domain: string): string {
  const base = domain.split('.')[0] ?? domain;
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function splitDisplayName(displayName: string): { firstName: string | null; lastName: string | null } {
  const cleaned = displayName.replace(/["']/g, '').replace(/\(.*?\)/g, '').trim();
  // "Nachname, Vorname" ist in Outlook-Adressbüchern verbreitet.
  if (cleaned.includes(',')) {
    const [last, first] = cleaned.split(',').map((s) => s.trim());
    return { firstName: first || null, lastName: last || null };
  }
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: null, lastName: parts[0] ?? null };
  const titles = new Set(['dr.', 'prof.', 'dipl.-ing.', 'ing.', 'mag.', 'dr', 'prof']);
  const withoutTitles = parts.filter((p) => !titles.has(p.toLowerCase()));
  const relevant = withoutTitles.length >= 2 ? withoutTitles : parts;
  return {
    firstName: relevant.slice(0, -1).join(' ') || null,
    lastName: relevant[relevant.length - 1] ?? null,
  };
}

/** Kürzt Text auf eine Länge, die für Vorschau und KI-Kontext ausreicht. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
