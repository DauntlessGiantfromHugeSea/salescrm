/** Bauprojekt-Domäne. Ein Projekt klammert Beteiligte, Mails, Termine und Deals. */

export const PROJECT_STAGES = [
  'LEAD',
  'ACQUISITION',
  'QUOTED',
  'AWARDED',
  'PLANNING',
  'EXECUTION',
  'COMPLETED',
  'ON_HOLD',
  'CANCELLED',
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const PROJECT_STAGE_LABELS: Record<ProjectStage, string> = {
  LEAD: 'Anfrage',
  ACQUISITION: 'Akquise',
  QUOTED: 'Angebot abgegeben',
  AWARDED: 'Beauftragt',
  PLANNING: 'Planung',
  EXECUTION: 'Ausführung',
  COMPLETED: 'Abgeschlossen',
  ON_HOLD: 'Pausiert',
  CANCELLED: 'Abgebrochen',
};

/** Stufen, in denen ein Projekt noch aktiv bearbeitet wird. */
export const ACTIVE_PROJECT_STAGES: readonly ProjectStage[] = [
  'LEAD',
  'ACQUISITION',
  'QUOTED',
  'AWARDED',
  'PLANNING',
  'EXECUTION',
];

/** Rollen externer Beteiligter. Deckt die übliche Besetzung eines Bauvorhabens ab. */
export const PROJECT_CONTACT_ROLES = [
  'CLIENT',
  'ARCHITECT',
  'STRUCTURAL_ENGINEER',
  'SITE_MANAGER',
  'PROJECT_MANAGER',
  'GENERAL_CONTRACTOR',
  'SUBCONTRACTOR',
  'SURVEYOR',
  'AUTHORITY',
  'SUPPLIER',
  'OTHER',
] as const;
export type ProjectContactRole = (typeof PROJECT_CONTACT_ROLES)[number];

export const PROJECT_CONTACT_ROLE_LABELS: Record<ProjectContactRole, string> = {
  CLIENT: 'Bauherr / Auftraggeber',
  ARCHITECT: 'Architekt',
  STRUCTURAL_ENGINEER: 'Statiker / Tragwerksplaner',
  SITE_MANAGER: 'Bauleitung',
  PROJECT_MANAGER: 'Projektsteuerung',
  GENERAL_CONTRACTOR: 'Generalunternehmer',
  SUBCONTRACTOR: 'Nachunternehmer',
  SURVEYOR: 'Vermessung / Gutachter',
  AUTHORITY: 'Behörde',
  SUPPLIER: 'Lieferant',
  OTHER: 'Sonstige',
};

/** Reihenfolge in der Beteiligtenliste – die wichtigsten Rollen zuerst. */
export const PROJECT_CONTACT_ROLE_ORDER: Record<ProjectContactRole, number> = {
  CLIENT: 0,
  ARCHITECT: 1,
  STRUCTURAL_ENGINEER: 2,
  PROJECT_MANAGER: 3,
  SITE_MANAGER: 4,
  GENERAL_CONTRACTOR: 5,
  SUBCONTRACTOR: 6,
  SURVEYOR: 7,
  AUTHORITY: 8,
  SUPPLIER: 9,
  OTHER: 10,
};

export const PROJECT_MEMBER_ROLES = ['LEAD', 'ENGINEER', 'SALES', 'SUPPORT', 'OBSERVER'] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

export const PROJECT_MEMBER_ROLE_LABELS: Record<ProjectMemberRole, string> = {
  LEAD: 'Projektleitung',
  ENGINEER: 'Fachbearbeitung',
  SALES: 'Vertrieb',
  SUPPORT: 'Unterstützung',
  OBSERVER: 'Nur Lesezugriff',
};

/** Wie eine Mail einem Projekt zugeordnet wurde. */
export const LINK_METHODS = [
  'PROJECT_NUMBER',
  'CONVERSATION',
  'PARTICIPANTS',
  'DEAL',
  'MANUAL',
  'AI_SUGGESTION',
] as const;
export type LinkMethod = (typeof LINK_METHODS)[number];

export const LINK_METHOD_LABELS: Record<LinkMethod, string> = {
  PROJECT_NUMBER: 'Projektnummer im Betreff',
  CONVERSATION: 'Gleicher Mailverlauf',
  PARTICIPANTS: 'Beteiligte des Projekts',
  DEAL: 'Über den Deal',
  MANUAL: 'Manuell zugeordnet',
  AI_SUGGESTION: 'KI-Vorschlag',
};

/**
 * Vertrauensschwelle, ab der eine automatische Zuordnung geschrieben wird.
 * Darunter wird die Mail als Prüfaufgabe in Bucket D gelegt, statt geraten.
 */
export const PROJECT_LINK_MIN_SCORE = 60;
