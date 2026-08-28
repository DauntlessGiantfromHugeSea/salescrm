import { z } from 'zod';

/**
 * Zentrale, validierte Konfiguration. Der Prozess startet gar nicht erst,
 * wenn eine Pflichtvariable fehlt – lieber ein klarer Fehler beim Deploy
 * als ein halb funktionierendes System im Betrieb.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),

  /**
   * Demo-Modus: das System läuft ohne Microsoft-Mandanten und ohne KI-Schlüssel.
   *
   * Gedacht zum Ansehen und Ausprobieren, bevor die IT den Mandanten einrichtet.
   * Es gibt dann einen lokalen Login ohne Microsoft, und Graph-Aufrufe scheitern
   * mit einer verständlichen Meldung, statt den Prozess abzubrechen.
   *
   * Die Auswertung weiter unten verweigert den Start, wenn das zusammen mit
   * NODE_ENV=production gesetzt wird – ein Demo-Login in einem erreichbaren
   * System wäre eine offene Tür.
   */
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  /** Öffentliche Basis-URL des Dashboards, z. B. https://akquise.example.de */
  PUBLIC_BASE_URL: z.string().url(),

  /* --- Microsoft Entra ID / Graph --- */
  /* Im Demo-Modus leer; im Normalbetrieb erzwingt die Prüfung unten die Angabe. */
  MS_TENANT_ID: z.string().default(''),
  MS_CLIENT_ID: z.string().default(''),
  MS_CLIENT_SECRET: z.string().default(''),
  /** Muss exakt der in Entra ID hinterlegten Redirect-URI entsprechen. */
  MS_REDIRECT_URI: z.string().default(''),
  /**
   * Firmenweiter Postfachzugriff über die Anwendungsidentität.
   * Erfordert Admin-Zustimmung für Mail.Read und eine ApplicationAccessPolicy,
   * die den Zugriff auf die freigegebenen Postfächer begrenzt.
   */
  MS_APP_ONLY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Sicherheitsgruppe, auf die die ApplicationAccessPolicy zeigt (nur zur Doku im Dashboard). */
  MS_MAILBOX_GROUP: z.string().default(''),

  /* --- Sicherheit --- */
  /** 32-Byte-Schlüssel als Hex (64 Zeichen) für die Token-Verschlüsselung. */
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY muss 64 Hex-Zeichen sein'),
  SESSION_SECRET: z.string().min(32),
  /**
   * Mailadresse, mit der man sich im Demo-Modus ohne Microsoft anmeldet.
   * Außerhalb des Demo-Modus wirkungslos.
   */
  DEMO_USER_EMAIL: z.string().default('demo@example.de'),
  /** Kommagetrennte Mailadressen, die sich anmelden dürfen. Leer = ganzer Tenant. */
  ALLOWED_LOGIN_EMAILS: z.string().default(''),
  /** Mailadresse, die beim ersten Login automatisch ADMIN wird. */
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),

  /* --- KI --- */
  /* Im Demo-Modus optional: ohne Schlüssel gibt es Beispielentwürfe statt echter. */
  ANTHROPIC_API_KEY: z.string().default(''),
  /** Statisches Routing (Kapitel 13): großes Modell für Texte, kleines für Klassifikation. */
  AI_MODEL_DRAFTING: z.string().default('claude-sonnet-5'),
  AI_MODEL_CLASSIFY: z.string().default('claude-haiku-4-5-20251001'),

  /* --- Regelwerk (Kapitel 8) --- */
  RULE_FOLLOW_UP_DAYS: z.coerce.number().int().min(1).default(14),
  RULE_REACTIVATION_DAYS: z.coerce.number().int().min(1).default(180),
  RULE_MIN_EMAILS_FOR_CONTACT: z.coerce.number().int().min(1).default(3),

  /* --- Import --- */
  /** Wie weit der Erstimport zurückgeht (Stufe A der Spezifikation: 24 Monate). */
  IMPORT_MONTHS_BACK: z.coerce.number().int().min(1).default(24),
  /** Ordner, die synchronisiert werden. */
  IMPORT_MAIL_FOLDERS: z.string().default('inbox,sentitems'),
  /** Eigene Maildomains – Absender daraus werden nicht als Leads angelegt. */
  INTERNAL_EMAIL_DOMAINS: z.string().default(''),

  /* --- Zeitsteuerung --- */
  /** Cron des nächtlichen Sync (UTC). */
  CRON_NIGHTLY_SYNC: z.string().default('0 3 * * *'),
  /** Cron der täglichen Priorisierung (UTC). */
  CRON_DAILY_SCAN: z.string().default('30 4 * * 1-5'),
  /** Cron des Transkript-Nachlaufs. */
  CRON_TRANSCRIPT_FETCH: z.string().default('0 * * * *'),

  /** Erzeugt der Tageslauf automatisch Entwürfe für Bucket A? */
  AUTO_GENERATE_FOLLOWUP_DRAFTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Obergrenze automatisch erzeugter Entwürfe pro Lauf und Benutzer (Kostenbremse). */
  MAX_AUTO_DRAFTS_PER_RUN: z.coerce.number().int().min(0).default(15),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Ungültige Umgebungskonfiguration:\n${issues}`);
}

const raw = parsed.data;

/**
 * Nachgelagerte Prüfungen, die sich nicht je Feld ausdrücken lassen.
 * Sie laufen bewusst als harte Abbrüche: eine halb konfigurierte Anmeldung
 * fällt sonst erst auf, wenn sich jemand anmelden will.
 */
const problems: string[] = [];

if (raw.DEMO_MODE && raw.NODE_ENV === 'production') {
  problems.push(
    'DEMO_MODE=true zusammen mit NODE_ENV=production ist nicht zulässig. ' +
      'Der Demo-Login umgeht die Microsoft-Anmeldung vollständig und darf in einem ' +
      'erreichbaren System nicht aktiv sein.',
  );
}

if (!raw.DEMO_MODE) {
  const missing = (
    [
      ['MS_TENANT_ID', raw.MS_TENANT_ID],
      ['MS_CLIENT_ID', raw.MS_CLIENT_ID],
      ['MS_CLIENT_SECRET', raw.MS_CLIENT_SECRET],
      ['MS_REDIRECT_URI', raw.MS_REDIRECT_URI],
      ['ANTHROPIC_API_KEY', raw.ANTHROPIC_API_KEY],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    problems.push(
      `Diese Angaben fehlen: ${missing.join(', ')}. ` +
        'Zum Ausprobieren ohne Microsoft-Mandanten DEMO_MODE=true setzen (siehe docs/TESTEN.md).',
    );
  }
}

if (problems.length > 0) {
  throw new Error(`Ungültige Umgebungskonfiguration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  /** Steht eine echte Microsoft-Anbindung zur Verfügung? */
  hasMicrosoft: Boolean(raw.MS_CLIENT_ID && raw.MS_CLIENT_SECRET && raw.MS_TENANT_ID),
  /** Steht ein KI-Schlüssel zur Verfügung? */
  hasAi: Boolean(raw.ANTHROPIC_API_KEY),
  allowedLoginEmails: splitList(raw.ALLOWED_LOGIN_EMAILS),
  internalEmailDomains: splitList(raw.INTERNAL_EMAIL_DOMAINS),
  importMailFolders: splitList(raw.IMPORT_MAIL_FOLDERS),
  ruleConfig: {
    followUpAfterDays: raw.RULE_FOLLOW_UP_DAYS,
    reactivationAfterDays: raw.RULE_REACTIVATION_DAYS,
    minEmailsForContact: raw.RULE_MIN_EMAILS_FOR_CONTACT,
  },
} as const;

export type Config = typeof config;
