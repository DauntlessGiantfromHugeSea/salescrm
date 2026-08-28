import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  DEAL_STAGES,
  DEAL_STAGE_LABELS,
  DRAFT_TYPES,
  DRAFT_TYPE_LABELS,
  type DealStage,
  type DraftType,
} from '@salescrm/shared';
import { api, ApiError } from '../lib/api';
import { formatDateTime, formatSlot, relativeDays } from '../lib/format';
import { StageBadge } from '../components/Badges';
import { Modal } from '../components/Modal';
import type { SessionUser } from '../App';

interface DealDetail {
  id: string;
  title: string;
  description: string | null;
  stage: DealStage;
  serviceArea: string | null;
  nextAction: string | null;
  dueDate: string | null;
  followUpDate: string | null;
  lastContactAt: string | null;
  openReasons: string[];
  isOpen: boolean;
  ownerName: string;
  contactName: string | null;
  contactEmail: string | null;
  project: { id: string; number: string; name: string } | null;
  company: { id: string; name: string; website: string | null; profile: string | null } | null;
  contact: { id: string; email: string; phone: string | null; position: string | null } | null;
  activities: Array<{
    id: string;
    occurredAt: string;
    direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
    channel: string;
    subject: string | null;
    summary: string | null;
    bodyPreview: string | null;
    attachmentNames: string[];
  }>;
  drafts: Array<{ id: string; type: DraftType; status: string; subject: string; createdAt: string }>;
  meetings: Array<{
    id: string;
    subject: string;
    startsAt: string;
    endsAt: string;
    status: string;
    joinUrl: string | null;
    summary: string | null;
    transcriptFetchedAt: string | null;
  }>;
}

export function DealDetailPage({ user }: { user: SessionUser }) {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const { data: deal, isLoading } = useQuery({
    queryKey: ['deal', id],
    queryFn: () => api.get<DealDetail>(`/api/deals/${id}`),
    enabled: Boolean(id),
  });

  const generate = useMutation({
    mutationFn: (type: DraftType) =>
      api.post<{ id: string }>('/api/drafts/generate', { dealId: id, type, includeMeetingProposals: false }),
    onSuccess: () => {
      setMessage({ tone: 'success', text: 'Entwurf erzeugt. Er liegt jetzt unter „Entwürfe" zur Freigabe.' });
      void queryClient.invalidateQueries({ queryKey: ['deal', id] });
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    },
    onError: (err) => setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Fehlgeschlagen' }),
  });

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/api/deals/${id}`, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['deal', id] }),
  });

  if (isLoading) {
    return (
      <div className="empty">
        <span className="spinner" /> Vorgang wird geladen …
      </div>
    );
  }
  if (!deal) return <div className="notice error">Der Vorgang konnte nicht geladen werden.</div>;

  // Besprechungsnotizen brauchen beides: die Graph-Berechtigung für das
  // Transkript und ein Modell, das daraus eine Notiz macht.
  const transcriptAvailable =
    user.hasAi && user.unavailableFeatures.every((f) => !f.scope.includes('Transcript'));

  return (
    <>
      <div className="page-header">
        <div>
          <div className="small muted">
            <Link to="/vorgaenge">Vorgänge</Link>
            {deal.project && (
              <>
                {' / '}
                <Link to={`/projekte/${deal.project.id}`}>
                  {deal.project.number} {deal.project.name}
                </Link>
              </>
            )}
          </div>
          <h1>{deal.title}</h1>
          <div className="subtitle">
            <StageBadge stage={deal.stage} />
            {deal.company && ` · ${deal.company.name}`}
            {deal.contactName && ` · ${deal.contactName}`}
            {` · Bearbeiter ${deal.ownerName}`}
          </div>
        </div>
        <div className="actions">
          <select
            value={deal.stage}
            onChange={(e) => update.mutate({ stage: e.target.value as DealStage })}
            style={{ width: 'auto' }}
          >
            {DEAL_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {DEAL_STAGE_LABELS[stage]}
              </option>
            ))}
          </select>
          <button className="primary" onClick={() => setMeetingOpen(true)} disabled={!deal.contactEmail}>
            Teams-Termin
          </button>
        </div>
      </div>

      {message && <div className={`notice ${message.tone}`}>{message.text}</div>}

      {deal.isOpen && deal.openReasons.length > 0 && (
        <div className="notice warning">
          <strong>Offen, weil:</strong> {deal.openReasons.join(' · ')}
        </div>
      )}

      <div className="split">
        <div>
          <div className="card mb">
            <div className="card-header">
              <h2 style={{ margin: 0 }}>Termine</h2>
            </div>
            <div className="card-body tight">
              {deal.meetings.length === 0 ? (
                <div className="empty">Noch kein Termin vereinbart.</div>
              ) : (
                <ul className="list">
                  {deal.meetings.map((meeting) => (
                    <li key={meeting.id}>
                      <div className="row">
                        <div>
                          <div className="row-title">{meeting.subject}</div>
                          <div className="row-meta">
                            {formatSlot(meeting.startsAt, meeting.endsAt)} · {meeting.status}
                          </div>
                          {meeting.summary && (
                            <div className="small mt" style={{ whiteSpace: 'pre-wrap' }}>
                              {meeting.summary}
                            </div>
                          )}
                        </div>
                        <div className="actions">
                          {meeting.joinUrl && new Date(meeting.startsAt) > new Date() && (
                            <a href={meeting.joinUrl} target="_blank" rel="noreferrer">
                              <button className="small primary">Teilnehmen</button>
                            </a>
                          )}
                          {!meeting.summary &&
                            new Date(meeting.endsAt) < new Date() &&
                            transcriptAvailable && <TranscriptButton meetingId={meeting.id} dealId={deal.id} />}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 style={{ margin: 0 }}>Verlauf</h2>
              <span className="badge">{deal.activities.length}</span>
            </div>
            <div className="card-body">
              {deal.activities.length === 0 ? (
                <div className="empty">Noch keine Kommunikation erfasst.</div>
              ) : (
                <ul className="timeline">
                  {deal.activities.map((activity) => (
                    <li key={activity.id} className={activity.direction === 'INBOUND' ? 'inbound' : 'outbound'}>
                      <div className="when">
                        {formatDateTime(activity.occurredAt)} ·{' '}
                        {activity.direction === 'INBOUND'
                          ? 'eingegangen'
                          : activity.direction === 'OUTBOUND'
                            ? 'gesendet'
                            : 'intern'}
                      </div>
                      <div className="subject">{activity.subject ?? 'ohne Betreff'}</div>
                      <div className="preview">{activity.summary ?? activity.bodyPreview ?? ''}</div>
                      {activity.attachmentNames.length > 0 && (
                        <div className="badges">
                          {activity.attachmentNames.map((name) => (
                            <span key={name} className="badge">
                              📎 {name}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="card mb">
            <div className="card-header">
              <h2 style={{ margin: 0 }}>Nächster Schritt</h2>
            </div>
            <div className="card-body">
              <NextActionEditor deal={deal} onSave={(patch) => update.mutate(patch)} />
            </div>
          </div>

          <div className="card mb">
            <div className="card-header">
              <h2 style={{ margin: 0 }}>Entwurf erzeugen</h2>
            </div>
            <div className="card-body">
              {user.hasAi ? (
                <div className="small muted mb">
                  Die KI schreibt einen Vorschlag. Versendet wird erst nach Ihrer Freigabe unter „Entwürfe".
                </div>
              ) : (
                <div className="notice info">
                  Für Entwürfe ist kein KI-Schlüssel hinterlegt. Alles andere funktioniert ohne –
                  Mails an diesen Kontakt schreiben Sie so lange direkt in Outlook.
                </div>
              )}
              <div className="actions">
                {DRAFT_TYPES.map((type) => (
                  <button
                    key={type}
                    onClick={() => generate.mutate(type)}
                    disabled={generate.isPending || !deal.contactEmail || !user.hasAi}
                    title={!user.hasAi ? 'Kein KI-Schlüssel hinterlegt' : undefined}
                  >
                    {DRAFT_TYPE_LABELS[type]}
                  </button>
                ))}
              </div>
              {generate.isPending && (
                <div className="small muted mt">
                  <span className="spinner" /> Entwurf wird geschrieben …
                </div>
              )}
              {deal.drafts.filter((d) => ['DRAFT', 'EDITED', 'APPROVED'].includes(d.status)).length > 0 && (
                <div className="notice info mt">
                  Es liegt bereits ein Entwurf bereit. <Link to="/entwuerfe">Zur Freigabe</Link>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 style={{ margin: 0 }}>Kontakt</h2>
            </div>
            <div className="card-body">
              {deal.contact ? (
                <>
                  <div className="field">
                    <label>Name</label>
                    <Link to={`/kontakte/${deal.contact.id}`}>{deal.contactName}</Link>
                    {deal.contact.position && <div className="row-meta">{deal.contact.position}</div>}
                  </div>
                  <div className="field">
                    <label>E-Mail</label>
                    <a href={`mailto:${deal.contact.email}`}>{deal.contact.email}</a>
                  </div>
                  {deal.contact.phone && (
                    <div className="field">
                      <label>Telefon</label>
                      <a href={`tel:${deal.contact.phone}`}>{deal.contact.phone}</a>
                    </div>
                  )}
                  <div className="field">
                    <label>Letzter Kontakt</label>
                    {relativeDays(deal.lastContactAt)}
                  </div>
                </>
              ) : (
                <div className="muted small">Kein Kontakt hinterlegt.</div>
              )}
              {deal.company?.profile && (
                <div className="field">
                  <label>Firmenprofil</label>
                  <div className="small">{deal.company.profile}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {meetingOpen && deal.contactEmail && (
        <MeetingModal
          dealId={deal.id}
          dealTitle={deal.title}
          attendeeEmail={deal.contactEmail}
          onClose={() => setMeetingOpen(false)}
        />
      )}
    </>
  );
}

function NextActionEditor({
  deal,
  onSave,
}: {
  deal: DealDetail;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [nextAction, setNextAction] = useState(deal.nextAction ?? '');
  const [followUpDate, setFollowUpDate] = useState(deal.followUpDate?.slice(0, 10) ?? '');

  const dirty = nextAction !== (deal.nextAction ?? '') || followUpDate !== (deal.followUpDate?.slice(0, 10) ?? '');

  return (
    <>
      <div className="field">
        <label htmlFor="next-action">Nächste Aktion</label>
        <textarea
          id="next-action"
          value={nextAction}
          onChange={(e) => setNextAction(e.target.value)}
          placeholder="z. B. Angebot nachfassen, Statik-Rückfrage klären"
          style={{ minHeight: '70px' }}
        />
      </div>
      <div className="field">
        <label htmlFor="follow-up">Wiedervorlage</label>
        <input id="follow-up" type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
        <div className="small muted">Bis zu diesem Tag erscheint der Vorgang nicht in der Tagesübersicht.</div>
      </div>
      <button
        className="primary"
        disabled={!dirty}
        onClick={() =>
          onSave({
            nextAction: nextAction.trim() || null,
            followUpDate: followUpDate ? new Date(`${followUpDate}T09:00:00`).toISOString() : null,
          })
        }
      >
        Speichern
      </button>
    </>
  );
}

function TranscriptButton({ meetingId, dealId }: { meetingId: string; dealId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const fetchTranscript = useMutation({
    mutationFn: () => api.post(`/api/meetings/${meetingId}/transcript`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['deal', dealId] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Fehlgeschlagen'),
  });

  return (
    <>
      <button className="small" onClick={() => fetchTranscript.mutate()} disabled={fetchTranscript.isPending}>
        {fetchTranscript.isPending ? 'Wertet aus …' : 'Notiz aus Transkript'}
      </button>
      {error && <div className="small muted">{error}</div>}
    </>
  );
}

function MeetingModal({
  dealId,
  dealTitle,
  attendeeEmail,
  onClose,
}: {
  dealId: string;
  dealTitle: string;
  attendeeEmail: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState(`Abstimmung: ${dealTitle}`);
  const [duration, setDuration] = useState(30);
  const [selected, setSelected] = useState<string | null>(null);
  const [agenda, setAgenda] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: suggestions, isLoading } = useQuery({
    queryKey: ['slots', attendeeEmail, duration],
    queryFn: () =>
      api.post<{ slots: Array<{ start: string; end: string; confidence: number }> }>('/api/meetings/suggest', {
        attendeeEmails: [attendeeEmail],
        durationMinutes: duration,
      }),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ joinUrl: string | null }>('/api/meetings', {
        dealId,
        subject,
        startsAt: selected,
        durationMinutes: duration,
        attendeeEmails: [attendeeEmail],
        agenda: agenda.trim() || undefined,
        sendInvitation: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['deal', dealId] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Termin konnte nicht angelegt werden'),
  });

  return (
    <Modal
      title="Teams-Termin vereinbaren"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" onClick={() => create.mutate()} disabled={!selected || create.isPending}>
            {create.isPending ? 'Wird angelegt …' : 'Termin anlegen und einladen'}
          </button>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}
      <div className="notice info">
        Der Termin entsteht in Ihrem Kalender als Teams-Besprechung. {attendeeEmail} erhält eine Einladung mit
        Einwahllink.
      </div>

      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="m-subject">Betreff</label>
          <input id="m-subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="m-duration">Dauer</label>
          <select id="m-duration" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            <option value={15}>15 Minuten</option>
            <option value={30}>30 Minuten</option>
            <option value={45}>45 Minuten</option>
            <option value={60}>60 Minuten</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label>Freie Zeitfenster</label>
        {isLoading ? (
          <div className="small muted">
            <span className="spinner" /> Kalender wird geprüft …
          </div>
        ) : !suggestions?.slots.length ? (
          <div className="notice warning">
            In den nächsten zwei Wochen wurde kein freies Fenster gefunden. Bitte den Termin direkt in Outlook anlegen.
          </div>
        ) : (
          <div className="slot-grid">
            {suggestions.slots.map((slot) => (
              <button
                key={slot.start}
                className={selected === slot.start ? 'selected' : ''}
                onClick={() => setSelected(slot.start)}
              >
                {formatSlot(slot.start, slot.end)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="m-agenda">Agenda</label>
        <textarea id="m-agenda" value={agenda} onChange={(e) => setAgenda(e.target.value)} />
      </div>
    </Modal>
  );
}
