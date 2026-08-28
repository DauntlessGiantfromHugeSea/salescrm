import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { DECISION_MAKER_LEVELS, type ProjectContactRole, type ProjectStage } from '@salescrm/shared';
import { api } from '../lib/api';
import { formatDateTime, relativeDays } from '../lib/format';
import { ProjectStageBadge, RoleBadge, StageBadge } from '../components/Badges';
import type { DealStage } from '@salescrm/shared';

interface ContactDetail {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  position: string | null;
  decisionMakerLevel: (typeof DECISION_MAKER_LEVELS)[number];
  emailCount: number;
  optedOut: boolean;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  company: { id: string; name: string; website: string | null; profile: string | null } | null;
  projects: Array<{
    projectId: string;
    number: string;
    name: string;
    stage: ProjectStage;
    role: ProjectContactRole;
    roleLabel: string;
    roleDetail: string | null;
    autoDetected: boolean;
    actingFor: string | null;
    lastContactAt: string | null;
  }>;
  deals: Array<{
    id: string;
    title: string;
    stage: DealStage;
    nextAction: string | null;
    ownerName: string;
    projectNumber: string | null;
  }>;
  activities: Array<{
    id: string;
    occurredAt: string;
    direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
    subject: string | null;
    summary: string | null;
    bodyPreview: string | null;
    attachmentNames: string[];
    mailbox: string | null;
    projectId: string | null;
    projectNumber: string | null;
  }>;
}

/**
 * Die Kontaktakte: wie stehen wir zu dieser Person – über alle Projekte hinweg.
 * Genau die Frage, die vor einem Anruf zu beantworten ist.
 */
export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const { data: contact, isLoading } = useQuery({
    queryKey: ['contact', id],
    queryFn: () => api.get<ContactDetail>(`/api/contacts/${id}`),
    enabled: Boolean(id),
  });

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/api/contacts/${id}`, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['contact', id] }),
  });

  if (isLoading) {
    return (
      <div className="empty">
        <span className="spinner" /> Kontakt wird geladen …
      </div>
    );
  }
  if (!contact) return <div className="notice error">Der Kontakt konnte nicht geladen werden.</div>;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="small muted">
            <Link to="/kontakte">Kontakte</Link>
          </div>
          <h1>{contact.name}</h1>
          <div className="subtitle">
            {[contact.position, contact.company?.name].filter(Boolean).join(' · ') || contact.email}
          </div>
        </div>
        <div className="actions">
          <a href={`mailto:${contact.email}`}>
            <button>E-Mail schreiben</button>
          </a>
        </div>
      </div>

      {contact.optedOut && (
        <div className="notice error">
          Dieser Kontakt hat weiterer Kontaktaufnahme widersprochen. Es können keine Mails an ihn freigegeben werden.
        </div>
      )}

      <div className="split">
        <div>
          {/* Die Rollenübersicht ist der eigentliche Mehrwert: dieselbe Person
              tritt in verschiedenen Vorhaben in verschiedenen Rollen auf. */}
          <div className="card mb">
            <div className="card-header">
              <h2 style={{ margin: 0 }}>Rolle in Projekten</h2>
              <span className="badge">{contact.projects.length}</span>
            </div>
            <div className="card-body tight">
              {contact.projects.length === 0 ? (
                <div className="empty">Diese Person ist keinem Projekt zugeordnet.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Projekt</th>
                      <th>Phase</th>
                      <th>Rolle</th>
                      <th>Auftretend für</th>
                      <th>Letzter Kontakt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contact.projects.map((project) => (
                      <tr key={project.projectId}>
                        <td>
                          <Link to={`/projekte/${project.projectId}`}>
                            <span className="mono">{project.number}</span> {project.name}
                          </Link>
                        </td>
                        <td>
                          <ProjectStageBadge stage={project.stage} />
                        </td>
                        <td>
                          <RoleBadge role={project.role} detail={project.roleDetail} auto={project.autoDetected} />
                        </td>
                        <td className="small">{project.actingFor ?? '–'}</td>
                        <td className="nowrap muted small">{relativeDays(project.lastContactAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="card mb">
            <div className="card-header">
              <h2 style={{ margin: 0 }}>Vorgänge</h2>
            </div>
            <div className="card-body tight">
              {contact.deals.length === 0 ? (
                <div className="empty">Keine Vorgänge.</div>
              ) : (
                <ul className="list">
                  {contact.deals.map((deal) => (
                    <li key={deal.id}>
                      <div className="row">
                        <div>
                          <div className="row-title">
                            <Link to={`/vorgaenge/${deal.id}`}>{deal.title}</Link>
                          </div>
                          <div className="row-meta">
                            {deal.ownerName}
                            {deal.projectNumber && ` · Projekt ${deal.projectNumber}`}
                          </div>
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
              <h2 style={{ margin: 0 }}>Gesamter Schriftverkehr</h2>
              <span className="badge">{contact.emailCount} Mails</span>
            </div>
            <div className="card-body">
              {contact.activities.length === 0 ? (
                <div className="empty">Keine Nachrichten erfasst.</div>
              ) : (
                <ul className="timeline">
                  {contact.activities.map((activity) => (
                    <li key={activity.id} className={activity.direction === 'INBOUND' ? 'inbound' : 'outbound'}>
                      <div className="when">
                        {formatDateTime(activity.occurredAt)} ·{' '}
                        {activity.direction === 'INBOUND' ? 'eingegangen' : 'gesendet'}
                        {activity.mailbox && ` · ${activity.mailbox}`}
                        {activity.projectNumber && (
                          <>
                            {' · '}
                            <Link to={`/projekte/${activity.projectId}`}>{activity.projectNumber}</Link>
                          </>
                        )}
                      </div>
                      <div className="subject">{activity.subject ?? 'ohne Betreff'}</div>
                      <div className="preview">{activity.summary ?? activity.bodyPreview ?? ''}</div>
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
            <div className="field">
              <label>E-Mail</label>
              <a href={`mailto:${contact.email}`}>{contact.email}</a>
            </div>
            {contact.phone && (
              <div className="field">
                <label>Telefon</label>
                <a href={`tel:${contact.phone}`}>{contact.phone}</a>
              </div>
            )}
            <div className="field">
              <label htmlFor="dm-level">Entscheidungsebene</label>
              <select
                id="dm-level"
                value={contact.decisionMakerLevel}
                onChange={(e) => update.mutate({ decisionMakerLevel: e.target.value })}
              >
                <option value="DECISION_MAKER">Entscheider</option>
                <option value="INFLUENCER">Beeinflusser</option>
                <option value="UNKNOWN">Unbekannt</option>
              </select>
            </div>
            <div className="field">
              <label>Letzte Antwort</label>
              {relativeDays(contact.lastInboundAt)}
            </div>
            <div className="field">
              <label>Letzte eigene Mail</label>
              {relativeDays(contact.lastOutboundAt)}
            </div>

            {contact.company?.profile && (
              <div className="field">
                <label>Firmenprofil</label>
                <div className="small">{contact.company.profile}</div>
              </div>
            )}

            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '1rem 0' }} />

            <button
              className={contact.optedOut ? '' : 'danger'}
              onClick={() => {
                const next = !contact.optedOut;
                if (
                  !next ||
                  window.confirm(
                    'Diesen Kontakt für weitere Kontaktaufnahme sperren? Offene Entwürfe an ihn werden verworfen.',
                  )
                ) {
                  update.mutate({ optedOut: next });
                }
              }}
            >
              {contact.optedOut ? 'Sperre aufheben' : 'Kontaktaufnahme sperren'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
