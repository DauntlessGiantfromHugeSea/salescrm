/**
 * Delegierte Graph-Berechtigungen. Bewusst minimal gehalten:
 * jede zusätzliche Berechtigung muss in der Azure-App-Registrierung
 * nachgezogen und im Betriebshandbuch begründet werden (siehe docs/AZURE_SETUP.md).
 */
export const GRAPH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  /** Postfach lesen – Grundlage für Import und Antworterkennung. */
  'Mail.Read',
  /** Versand aus der echten Mailbox nach Freigabe im Dashboard. */
  'Mail.Send',
  /** Outlook-Adressbuch importieren. */
  'Contacts.Read',
  /** Kalender lesen und Termine anlegen. */
  'Calendars.ReadWrite',
  /** Teams-Onlinebesprechungen anlegen. */
  'OnlineMeetings.ReadWrite',
  /** Transkripte nach dem Termin abrufen. */
  'OnlineMeetingTranscript.Read.All',
  /** Planner als Steuerungsquelle. */
  'Tasks.ReadWrite',
  'Group.Read.All',
  'User.Read',
] as const;

/** Scopes, die für den Login zwingend nötig sind. Fehlen sie, ist das Konto unbrauchbar. */
export const REQUIRED_SCOPES = ['Mail.Read', 'Mail.Send', 'Calendars.ReadWrite'] as const;

/**
 * Optionale Scopes. Fehlen sie (weil der Tenant sie nicht freigibt), degradiert
 * das System kontrolliert: die betroffene Funktion wird im Dashboard deaktiviert,
 * statt beim Aufruf zu scheitern.
 */
export const OPTIONAL_SCOPES: Record<string, string> = {
  'OnlineMeetingTranscript.Read.All': 'Transkript-Auswertung nach Terminen',
  'Tasks.ReadWrite': 'Planner-Synchronisation',
  'Group.Read.All': 'Planner-Pläne auflisten',
};
