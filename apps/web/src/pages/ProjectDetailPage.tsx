import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  PROJECT_CONTACT_ROLES,
  PROJECT_CONTACT_ROLE_LABELS,
  PROJECT_MEMBER_ROLES,
  PROJECT_MEMBER_ROLE_LABELS,
  PROJECT_STAGES,
  PROJECT_STAGE_LABELS,
  type LinkMethod,
  type ProjectContactRole,
  type ProjectMemberRole,
  type ProjectStage,
} from '@salescrm/shared';
import { api, ApiError } from '../lib/api';
import { formatDateTime, relativeDays } from '../lib/format';
import { LinkMethodBadge, ProjectStageBadge, RoleBadge, StageBadge } from '../components/Badges';
import { Modal } from '../components/Modal';
import type { SessionUser } from '../App';
import type { DealStage } from '@salescrm/shared';

interface ProjectDetail {
  id: string;
  number: string;
  name: string;
  description: string | null;
  stage: ProjectStage;
  serviceArea: string | null;
  siteAddress: string | null;
  city: string | null;
  postalCode: string | null;
  aliases: string[];
  startsOn: string | null;
  lastActivityAt: string | null;
  canEdit: boolean;
  lead: { id: string; displayName: string; email: string };
  company: { id: string; name: string; website: string | null } | null;
  members: Array<{ id: string; userId: string; name: string; email: string; role: ProjectMemberRole; canEdit: boolean }>;
  contacts: Array<{
    id: string;
    contactId: string;
    name: string;
    email: string;
    phone: string | null;
    position: string | null;
    role: ProjectContactRole;
    roleDetail: string | null;
    isPrimary: boolean;
    note: string | null;
    autoDetected: boolean;
    companyName: string | null;
    lastContactAt: string | null;
  }>;
  deals: Array<{
    id: string;
    title: string;
    stage: DealStage;
    nextAction: string | null;
    contactName: string | null;
    ownerName: string;
    lastContactAt: string | null;
  }>;
  meetings: Array<{
    id: string;
    subject: string;
    startsAt: string;
    status: string;
    joinUrl: string | null;
    summary: string | null;
  }>;
  activities: Array<{
    id: string;
    occurredAt: string;
    direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
    channel: string;
    subject: string | null;
    summary: string | null;
    bodyPreview: string | null;
    attachmentNames: string[];
    hasPdfAttachment: boolean;
    linkMethod: LinkMethod | null;
    linkScore: number | null;
    contactId: string | null;
    contactName: string | null;
    mailbox: string | null;
  }>;
}

type Tab = 'uebersicht' | 'beteiligte' | 'kommunikation' | 'team';

/**
 * Die Projektakte: alles zu einem Bauvorhaben an einer Stelle.
 * Aufgeteilt in Reiter, weil ein laufendes Projekt schnell hunderte Mails hat.
 */
export function ProjectDetailPage({ user }: { user: SessionUser }) {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('uebersicht');
  const [addingContact, setAddingContact] = useState(false);
  const [addingMember, setAddingMember] = useState(false);

  const { data: project, isLoading, error } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${id}`),
    enabled: Boolean(id),
  });

  if (isLoading) {
    return (
      <div className="empty">
        <span className="spinner" /> Projekt wird geladen …
      </div>
    );
  }
  if (error || !project) return <div className="notice error">Das Projekt konnte nicht geladen werden.</div>;

  const unconfirmed = project.contacts.filter((c) => c.autoDetected).length;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="small muted">
            <Link to="/projekte">Projekte</Link> / {project.number}
          </div>
          <h1>
            <span className="mono">{project.number}</span> {project.name}
          </h1>
          <div className="subtitle">
            <ProjectStageBadge stage={project.stage} />
            {project.city && ` · ${[project.postalCode, project.city].filter(Boolean).join(' ')}`}
            {project.company && (
              <>
                {' · Auftraggeber '}
                {project.company.name}
              </>
            )}
            {' · Projektleitung '}
            {project.lead.displayName}
          </div>
        </div>
        {project.canEdit && <StageChanger project={project} />}
      </div>

      {unconfirmed > 0 && (
        <div className="notice warning">
          {unconfirmed} Beteiligte{unconfirmed === 1 ? 'r wurde' : ' wurden'} aus dem Mailverkehr erkannt, aber noch
          keiner Rolle zugeordnet. <button className="link" onClick={() => setTab('beteiligte')}>Jetzt zuordnen</button>
        </div>
      )}

      <div className="card mb">
        <div className="card-header" style={{ gap: 0, padding: 0 }}>
          {(
            [
              ['uebersicht', 'Übersicht'],
              ['beteiligte', `Beteiligte (${project.contacts.length})`],
              ['kommunikation', `Kommunikation (${project.activities.length})`],
              ['team', `Team (${project.members.length})`],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                border: 'none',
                borderRadius: 0,
                borderBottom: tab === key ? '2px solid var(--accent)' : '2px solid transparent',
                color: tab === key ? 'var(--accent)' : 'var(--text-muted)',
                padding: '0.75rem 1.1rem',
                background: 'none',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'uebersicht' && <OverviewTab project={project} />}

      {tab === 'beteiligte' && (
        <ParticipantsTab
          project={project}
          onAdd={() => setAddingContact(true)}
        />
      )}

      {tab === 'kommunikation' && <CommunicationTab project={project} />}

      {tab === 'team' && (
        <TeamTab project={project} currentUser={user} onAdd={() => setAddingMember(true)} />
      )}

      {addingContact && <AddContactModal projectId={project.id} onClose={() => setAddingContact(false)} />}
      {addingMember && (
        <AddMemberModal
          projectId={project.id}
          existing={project.members.map((m) => m.userId)}
          onClose={() => setAddingMember(false)}
        />
      )}
    </>
  );
}

function OverviewTab({ project }: { project: ProjectDetail }) {
  return (
    <div className="split">
      <div>
        <div className="card mb">
          <div className="card-header">
            <h2 style={{ margin: 0 }}>Vorgänge</h2>
            <span className="badge">{project.deals.length}</span>
          </div>
          <div className="card-body tight">
            {project.deals.length === 0 ? (
              <div className="empty">Zu diesem Projekt gibt es noch keine Vorgänge.</div>
            ) : (
              <ul className="list">
                {project.deals.map((deal) => (
                  <li key={deal.id}>
                    <div className="row">
                      <div>
                        <div className="row-title">
                          <Link to={`/vorgaenge/${deal.id}`}>{deal.title}</Link>
                        </div>
                        <div className="row-meta">
                          {deal.contactName ?? 'ohne Kontakt'} · {deal.ownerName} · letzter Kontakt{' '}
                          {relativeDays(deal.lastContactAt)}
                        </div>
                        {deal.nextAction && <div className="row-meta">Nächste Aktion: {deal.nextAction}</div>}
                      </div>
                      <StageBadge stage={deal.stage} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 style={{ margin: 0 }}>Termine</h2>
          </div>
          <div className="card-body tight">
            {project.meetings.length === 0 ? (
              <div className="empty">Keine Termine.</div>
            ) : (
              <ul className="list">
                {project.meetings.map((meeting) => (
                  <li key={meeting.id}>
                    <div className="row">
                      <div>
                        <div className="row-title">{meeting.subject}</div>
                        <div className="row-meta">{formatDateTime(meeting.startsAt)}</div>
                        {meeting.summary && <div className="row-meta mt">{meeting.summary}</div>}
                      </div>
                      {meeting.joinUrl && new Date(meeting.startsAt) > new Date() && (
                        <a href={meeting.joinUrl} target="_blank" rel="noreferrer">
                          <button className="small">Teams öffnen</button>
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 style={{ margin: 0 }}>Stammdaten</h2>
        </div>
        <div className="card-body">
          <Field label="Projektnummer" value={project.number} mono />
          <Field label="Leistungsbereich" value={project.serviceArea} />
          <Field label="Bauort" value={project.siteAddress} />
          <Field label="Beginn" value={project.startsOn ? formatDateTime(project.startsOn) : null} />
          <Field label="Letzte Aktivität" value={relativeDays(project.lastActivityAt)} />
          {project.aliases.length > 0 && (
            <div className="field">
              <label>Weitere Bezeichnungen</label>
              <div className="badges">
                {project.aliases.map((alias) => (
                  <span key={alias} className="badge">
                    {alias}
                  </span>
                ))}
              </div>
            </div>
          )}
          {project.description && (
            <div className="field">
              <label>Beschreibung</label>
              <div className="small">{project.description}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ParticipantsTab({
  project,
  onAdd,
}: {
  project: ProjectDetail;
  onAdd: () => void;
}) {
  const queryClient = useQueryClient();

  const setRole = useMutation({
    mutationFn: (input: { contactId: string; role: ProjectContactRole }) =>
      api.post(`/api/projects/${project.id}/contacts`, { contactId: input.contactId, role: input.role }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
  });

  const remove = useMutation({
    mutationFn: (contactId: string) => api.delete(`/api/projects/${project.id}/contacts/${contactId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
  });

  return (
    <div className="card">
      <div className="card-header">
        <h2 style={{ margin: 0 }}>Beteiligte am Bauvorhaben</h2>
        {project.canEdit && (
          <button className="primary small" onClick={onAdd}>
            Beteiligten hinzufügen
          </button>
        )}
      </div>
      <div className="card-body tight">
        {project.contacts.length === 0 ? (
          <div className="empty">
            Noch keine Beteiligten. Sobald Mails zu diesem Projekt eingehen, werden die Absender hier
            vorgeschlagen – die Rolle tragen Sie ein.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rolle</th>
                <th>Name</th>
                <th>Firma</th>
                <th>Kontakt</th>
                <th>Letzter Kontakt</th>
                {project.canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {project.contacts.map((participant) => (
                <tr key={participant.id}>
                  <td style={{ minWidth: '180px' }}>
                    {project.canEdit ? (
                      <select
                        value={participant.role}
                        onChange={(e) =>
                          setRole.mutate({
                            contactId: participant.contactId,
                            role: e.target.value as ProjectContactRole,
                          })
                        }
                        style={participant.autoDetected ? { borderColor: 'var(--warning)' } : undefined}
                      >
                        {PROJECT_CONTACT_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {PROJECT_CONTACT_ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <RoleBadge role={participant.role} detail={participant.roleDetail} auto={participant.autoDetected} />
                    )}
                    {participant.autoDetected && (
                      <div className="small muted">aus Mailverkehr erkannt</div>
                    )}
                  </td>
                  <td>
                    <Link to={`/kontakte/${participant.contactId}`}>{participant.name}</Link>
                    {participant.position && <div className="row-meta">{participant.position}</div>}
                  </td>
                  <td>{participant.companyName ?? '–'}</td>
                  <td className="small">
                    <a href={`mailto:${participant.email}`}>{participant.email}</a>
                    {participant.phone && <div className="muted">{participant.phone}</div>}
                  </td>
                  <td className="nowrap muted small">{relativeDays(participant.lastContactAt)}</td>
                  {project.canEdit && (
                    <td className="nowrap">
                      <button
                        className="small danger"
                        onClick={() => {
                          if (window.confirm(`${participant.name} aus dem Projekt entfernen?`)) {
                            remove.mutate(participant.contactId);
                          }
                        }}
                      >
                        Entfernen
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function CommunicationTab({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const unlink = useMutation({
    mutationFn: (activityId: string) => api.delete(`/api/projects/${project.id}/activities/${activityId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
  });

  const rescan = useMutation({
    mutationFn: () => api.post<{ linked: number }>(`/api/projects/${project.id}/rescan`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
  });

  return (
    <div className="card">
      <div className="card-header">
        <h2 style={{ margin: 0 }}>Schriftverkehr zum Projekt</h2>
        <div className="actions">
          <span className="small muted">aus allen verbundenen Firmenpostfächern</span>
          <button className="small" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
            {rescan.isPending ? 'Sucht …' : 'Weitere Mails suchen'}
          </button>
        </div>
      </div>
      <div className="card-body">
        {rescan.isSuccess && (
          <div className="notice success">{rescan.data.linked} weitere Mails zugeordnet.</div>
        )}
        {project.activities.length === 0 ? (
          <div className="empty">
            Noch keine zugeordneten Mails. Mails werden über die Projektnummer im Betreff, den Mailverlauf oder die
            Beteiligten erkannt.
          </div>
        ) : (
          <ul className="timeline">
            {project.activities.map((activity) => (
              <li key={activity.id} className={activity.direction === 'INBOUND' ? 'inbound' : 'outbound'}>
                <div className="row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="when">
                      {formatDateTime(activity.occurredAt)} ·{' '}
                      {activity.direction === 'INBOUND' ? 'eingegangen' : activity.direction === 'OUTBOUND' ? 'gesendet' : 'intern'}
                      {activity.contactName && (
                        <>
                          {' · '}
                          <Link to={`/kontakte/${activity.contactId}`}>{activity.contactName}</Link>
                        </>
                      )}
                      {activity.mailbox && ` · Postfach ${activity.mailbox}`}
                    </div>
                    <div className="subject">{activity.subject ?? 'ohne Betreff'}</div>
                    <div
                      className={`preview ${expanded === activity.id ? 'expanded' : ''}`}
                      onClick={() => setExpanded(expanded === activity.id ? null : activity.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      {activity.summary ?? activity.bodyPreview ?? ''}
                    </div>
                    <div className="badges">
                      <LinkMethodBadge method={activity.linkMethod} score={activity.linkScore} />
                      {activity.attachmentNames.map((name) => (
                        <span key={name} className="badge" title="Anhänge werden nur als Dateiname erfasst">
                          📎 {name}
                        </span>
                      ))}
                    </div>
                  </div>
                  {project.canEdit && (
                    <button
                      className="small"
                      title="Diese Mail gehört nicht zum Projekt"
                      onClick={() => unlink.mutate(activity.id)}
                    >
                      Lösen
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TeamTab({
  project,
  currentUser,
  onAdd,
}: {
  project: ProjectDetail;
  currentUser: SessionUser;
  onAdd: () => void;
}) {
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: (userId: string) => api.delete(`/api/projects/${project.id}/members/${userId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
  });

  return (
    <div className="card">
      <div className="card-header">
        <h2 style={{ margin: 0 }}>Projektteam</h2>
        {project.canEdit && (
          <button className="primary small" onClick={onAdd}>
            Kollegen hinzufügen
          </button>
        )}
      </div>
      <div className="card-body">
        <div className="notice info">
          Alle Teammitglieder sehen dieses Projekt mit seinen Vorgängen und dem gesamten Schriftverkehr – auch die
          Vorgänge, die einem anderen Kollegen gehören.
        </div>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Rolle</th>
              <th>Rechte</th>
              {project.canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {project.members.map((member) => (
              <tr key={member.id}>
                <td>
                  {member.name}
                  {member.userId === currentUser.id && <span className="muted"> (Sie)</span>}
                  <div className="row-meta">{member.email}</div>
                </td>
                <td>
                  <span className="badge">{PROJECT_MEMBER_ROLE_LABELS[member.role]}</span>
                </td>
                <td className="small muted">{member.canEdit ? 'darf bearbeiten' : 'nur lesen'}</td>
                {project.canEdit && (
                  <td className="nowrap">
                    {member.userId !== project.lead.id && (
                      <button className="small danger" onClick={() => remove.mutate(member.userId)}>
                        Entfernen
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StageChanger({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (stage: ProjectStage) => api.patch(`/api/projects/${project.id}`, { stage }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['project', project.id] }),
  });

  return (
    <div className="actions">
      <label style={{ margin: 0 }} htmlFor="stage-select">
        Phase
      </label>
      <select
        id="stage-select"
        value={project.stage}
        onChange={(e) => update.mutate(e.target.value as ProjectStage)}
        style={{ width: 'auto' }}
      >
        {PROJECT_STAGES.map((stage) => (
          <option key={stage} value={stage}>
            {PROJECT_STAGE_LABELS[stage]}
          </option>
        ))}
      </select>
    </div>
  );
}

function AddContactModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ email: '', name: '', companyName: '', role: 'OTHER' as ProjectContactRole });
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.post(`/api/projects/${projectId}/contacts`, {
        email: form.email.trim(),
        name: form.name.trim() || undefined,
        companyName: form.companyName.trim() || undefined,
        role: form.role,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Hinzufügen fehlgeschlagen'),
  });

  return (
    <Modal
      title="Beteiligten hinzufügen"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" onClick={() => add.mutate()} disabled={!form.email.includes('@') || add.isPending}>
            Hinzufügen
          </button>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}
      <div className="field">
        <label htmlFor="c-email">E-Mail</label>
        <input id="c-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <div className="small muted">
          Ist die Adresse bereits bekannt, wird der vorhandene Kontakt verwendet – es entsteht keine Dublette.
        </div>
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="c-name">Name</label>
          <input id="c-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="c-company">Firma</label>
          <input
            id="c-company"
            type="text"
            value={form.companyName}
            onChange={(e) => setForm({ ...form, companyName: e.target.value })}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="c-role">Rolle im Projekt</label>
        <select id="c-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as ProjectContactRole })}>
          {PROJECT_CONTACT_ROLES.map((role) => (
            <option key={role} value={role}>
              {PROJECT_CONTACT_ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}

function AddMemberModal({
  projectId,
  existing,
  onClose,
}: {
  projectId: string;
  existing: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<ProjectMemberRole>('ENGINEER');

  const { data } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: Array<{ id: string; displayName: string; email: string }> }>('/api/users'),
  });

  const available = (data?.users ?? []).filter((u) => !existing.includes(u.id));

  const add = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/members`, { userId, role, canEdit: role !== 'OBSERVER' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      onClose();
    },
  });

  return (
    <Modal
      title="Kollegen zum Projekt hinzufügen"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" onClick={() => add.mutate()} disabled={!userId || add.isPending}>
            Hinzufügen
          </button>
        </>
      }
    >
      {available.length === 0 ? (
        <div className="notice info">Alle aktiven Kollegen sind bereits im Team.</div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="m-user">Kollege</label>
            <select id="m-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Bitte wählen …</option>
              {available.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} ({u.email})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="m-role">Rolle</label>
            <select id="m-role" value={role} onChange={(e) => setRole(e.target.value as ProjectMemberRole)}>
              {PROJECT_MEMBER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {PROJECT_MEMBER_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </Modal>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="field">
      <label>{label}</label>
      <div className={mono ? 'mono' : undefined}>{value}</div>
    </div>
  );
}
