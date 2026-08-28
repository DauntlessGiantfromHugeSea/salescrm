import {
  DEAL_STAGE_LABELS,
  DRAFT_TYPE_LABELS,
  PROJECT_STAGE_LABELS,
  PROJECT_CONTACT_ROLE_LABELS,
  LINK_METHOD_LABELS,
  type DealStage,
  type DraftType,
  type ProjectStage,
  type ProjectContactRole,
  type LinkMethod,
} from '@salescrm/shared';

/** Farbgebung der Pipeline-Stufen: rot = braucht Aufmerksamkeit. */
const STAGE_TONE: Record<DealStage, string> = {
  NEW: 'accent',
  OPEN: 'accent',
  AWAITING_REPLY: '',
  FOLLOW_UP_DUE: 'warning',
  IN_CLARIFICATION: '',
  MEETING_SCHEDULED: 'success',
  PROPOSAL_IN_PROGRESS: 'accent',
  PROPOSAL_SENT: 'accent',
  WON: 'success',
  LOST: '',
  ON_HOLD: '',
  NEEDS_REVIEW: 'danger',
};

export function StageBadge({ stage }: { stage: DealStage }) {
  return <span className={`badge ${STAGE_TONE[stage]}`}>{DEAL_STAGE_LABELS[stage]}</span>;
}

const PROJECT_TONE: Record<ProjectStage, string> = {
  LEAD: 'accent',
  ACQUISITION: 'accent',
  QUOTED: 'warning',
  AWARDED: 'success',
  PLANNING: 'success',
  EXECUTION: 'success',
  COMPLETED: '',
  ON_HOLD: '',
  CANCELLED: '',
};

export function ProjectStageBadge({ stage }: { stage: ProjectStage }) {
  return <span className={`badge ${PROJECT_TONE[stage]}`}>{PROJECT_STAGE_LABELS[stage]}</span>;
}

export function RoleBadge({
  role,
  detail,
  auto,
}: {
  role: ProjectContactRole;
  detail?: string | null;
  auto?: boolean;
}) {
  return (
    <span className={`badge ${role === 'CLIENT' ? 'accent' : ''}`} title={auto ? 'Aus dem Mailverkehr erkannt – Rolle noch nicht bestätigt' : undefined}>
      {detail || PROJECT_CONTACT_ROLE_LABELS[role]}
      {auto && ' ?'}
    </span>
  );
}

export function DraftTypeBadge({ type }: { type: DraftType }) {
  const tone = type === 'COLD_OUTREACH' ? 'warning' : 'accent';
  return <span className={`badge ${tone}`}>{DRAFT_TYPE_LABELS[type]}</span>;
}

export function LinkMethodBadge({ method, score }: { method: LinkMethod | null; score?: number | null }) {
  if (!method) return null;
  // Automatische Zuordnungen unter voller Sicherheit werden abgeschwächt dargestellt,
  // damit erkennbar bleibt, was geprüft gehört.
  const uncertain = method !== 'MANUAL' && (score ?? 100) < 90;
  return (
    <span className={`badge ${uncertain ? 'warning' : ''}`} title={`Zuordnung: ${LINK_METHOD_LABELS[method]}`}>
      {LINK_METHOD_LABELS[method]}
      {uncertain && ` (${score}%)`}
    </span>
  );
}
