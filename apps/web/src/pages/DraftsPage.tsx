import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { DraftTypeBadge, StageBadge } from '../components/Badges';
import type { DealStage, DraftType } from '@salescrm/shared';

interface Draft {
  id: string;
  dealId: string;
  dealTitle: string;
  dealStage: DealStage;
  openReasons: string[];
  companyName: string | null;
  projectNumber: string | null;
  projectName: string | null;
  type: DraftType;
  status: string;
  subject: string;
  body: string;
  toEmail: string;
  toName: string | null;
  ccEmails: string[];
  model: string | null;
  rationale: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  error: string | null;
}

/**
 * Der Freigabe-Arbeitsplatz (Kapitel 10.2).
 *
 * Ein Entwurf verlässt diese Seite nur über den Knopf "Freigeben und senden" –
 * es gibt keinen anderen Weg nach draußen.
 */
export function DraftsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['drafts'],
    queryFn: () => api.get<{ drafts: Draft[] }>('/api/drafts'),
  });

  const drafts = data?.drafts ?? [];
  const pending = drafts.filter((d) => ['DRAFT', 'EDITED', 'APPROVED'].includes(d.status));
  const failed = drafts.filter((d) => d.status === 'FAILED');
  const selected = drafts.find((d) => d.id === selectedId) ?? pending[0] ?? null;

  if (isLoading) {
    return (
      <div className="empty">
        <span className="spinner" /> Entwürfe werden geladen …
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Entwürfe</h1>
          <div className="subtitle">
            {pending.length === 0
              ? 'Keine Entwürfe zur Freigabe.'
              : `${pending.length} Entwurf${pending.length === 1 ? '' : 'e'} warten auf Ihre Freigabe. Nichts wird ohne Ihre Bestätigung versendet.`}
          </div>
        </div>
      </div>

      {failed.length > 0 && (
        <div className="notice error">
          {failed.length} Mail{failed.length === 1 ? '' : 's'} konnte{failed.length === 1 ? '' : 'n'} nicht versendet
          werden. Bitte unten prüfen und erneut freigeben.
        </div>
      )}

      {pending.length === 0 && failed.length === 0 ? (
        <div className="card">
          <div className="empty">
            Nichts zu tun. Neue Entwürfe entstehen im nächtlichen Lauf oder direkt am Vorgang.
          </div>
        </div>
      ) : (
        <div className="split">
          <div className="card">
            <div className="card-header">
              <h2 style={{ margin: 0 }}>{selected ? 'Entwurf prüfen' : 'Kein Entwurf ausgewählt'}</h2>
              {selected && <DraftTypeBadge type={selected.type} />}
            </div>
            <div className="card-body">
              {selected ? (
                <DraftEditor
                  key={selected.id}
                  draft={selected}
                  onDone={() => {
                    setSelectedId(null);
                    void queryClient.invalidateQueries({ queryKey: ['drafts'] });
                    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
                  }}
                />
              ) : (
                <div className="empty">Bitte links einen Entwurf auswählen.</div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 style={{ margin: 0 }}>Warteschlange</h2>
              <span className="badge">{pending.length + failed.length}</span>
            </div>
            <div className="card-body tight">
              <ul className="list">
                {[...pending, ...failed].map((draft) => (
                  <li
                    key={draft.id}
                    className="clickable"
                    onClick={() => setSelectedId(draft.id)}
                    style={
                      selected?.id === draft.id
                        ? { background: 'var(--accent-soft)', borderLeft: '3px solid var(--accent)' }
                        : undefined
                    }
                  >
                    <div className="row-title">{draft.subject}</div>
                    <div className="row-meta">
                      {draft.toName ?? draft.toEmail}
                      {draft.companyName && ` · ${draft.companyName}`}
                    </div>
                    <div className="badges">
                      <DraftTypeBadge type={draft.type} />
                      {draft.status === 'FAILED' && <span className="badge danger">Versand fehlgeschlagen</span>}
                      {draft.status === 'EDITED' && <span className="badge">bearbeitet</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DraftEditor({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [toEmail, setToEmail] = useState(draft.toEmail);
  const [message, setMessage] = useState<{ tone: 'error' | 'success' | 'warning'; text: string } | null>(
    draft.error ? { tone: 'error', text: `Letzter Versandversuch: ${draft.error}` } : null,
  );
  // Die Fassung, die der Server kennt. Nur wenn sie mit dem übereinstimmt,
  // was hier gerade angezeigt wird, darf freigegeben werden.
  const [serverVersion, setServerVersion] = useState({
    subject: draft.subject,
    toEmail: draft.toEmail,
    updatedAt: draft.updatedAt,
  });

  const dirty =
    subject !== serverVersion.subject || body !== draft.body || toEmail !== serverVersion.toEmail;

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ id: string; status: string; updatedAt: string }>(`/api/drafts/${draft.id}`, {
        subject,
        body,
        toEmail,
        ccEmails: draft.ccEmails,
      }),
    onSuccess: (result) => {
      setServerVersion({ subject, toEmail, updatedAt: result.updatedAt });
      setMessage({ tone: 'success', text: 'Änderungen gespeichert.' });
    },
    onError: (error) => setMessage({ tone: 'error', text: describe(error) }),
  });

  const approve = useMutation({
    mutationFn: () =>
      api.post<{ status: string; sentAt: string }>(`/api/drafts/${draft.id}/approve`, {
        confirmedSubject: serverVersion.subject,
        confirmedToEmail: serverVersion.toEmail,
        updatedAt: serverVersion.updatedAt,
      }),
    onSuccess: () => onDone(),
    onError: (error) => setMessage({ tone: 'error', text: describe(error) }),
  });

  const discard = useMutation({
    mutationFn: () => api.post(`/api/drafts/${draft.id}/discard`),
    onSuccess: () => onDone(),
    onError: (error) => setMessage({ tone: 'error', text: describe(error) }),
  });

  async function approveAndSend(): Promise<void> {
    if (dirty) {
      setMessage({ tone: 'warning', text: 'Bitte erst die Änderungen speichern.' });
      return;
    }
    const confirmed = window.confirm(
      `Diese E-Mail wird jetzt aus Ihrem Postfach an ${toEmail} versendet.\n\nBetreff: ${subject}\n\nWirklich senden?`,
    );
    if (!confirmed) return;
    approve.mutate();
  }

  return (
    <>
      <div className="small muted mb">
        Vorgang:{' '}
        <Link to={`/vorgaenge/${draft.dealId}`}>{draft.dealTitle}</Link> <StageBadge stage={draft.dealStage} />
        {draft.projectNumber && (
          <>
            {' · Projekt '}
            {draft.projectNumber} {draft.projectName}
          </>
        )}
      </div>

      {draft.openReasons.length > 0 && (
        <div className="badges mb">
          {draft.openReasons.map((reason) => (
            <span key={reason} className="badge">
              {reason}
            </span>
          ))}
        </div>
      )}

      {draft.rationale && <div className="notice info">{draft.rationale}</div>}
      {message && <div className={`notice ${message.tone}`}>{message.text}</div>}

      <div className="field">
        <label htmlFor="draft-to">Empfänger</label>
        <input id="draft-to" type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="draft-subject">Betreff</label>
        <input id="draft-subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="draft-body">Text</label>
        <textarea
          id="draft-body"
          className="mail-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="small muted">
          Grußformel und Signatur werden aus Ihrem Postfach ergänzt und stehen nicht im Entwurf.
        </div>
      </div>

      <div className="actions">
        <button
          className="primary"
          onClick={() => void approveAndSend()}
          disabled={approve.isPending || dirty}
          title={dirty ? 'Bitte erst speichern' : undefined}
        >
          {approve.isPending ? 'Wird gesendet …' : 'Freigeben und senden'}
        </button>
        <button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
          {save.isPending ? 'Speichert …' : 'Änderungen speichern'}
        </button>
        <div className="spacer" />
        <button className="danger" onClick={() => discard.mutate()} disabled={discard.isPending}>
          Verwerfen
        </button>
      </div>

      <div className="small muted mt">
        Erzeugt {formatDateTime(draft.createdAt)}
        {draft.model && ` · Modell ${draft.model}`}
      </div>
    </>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'stale' || error.code === 'content_changed') {
      return `${error.message} Die Seite bitte neu laden.`;
    }
    return error.message;
  }
  return 'Unerwarteter Fehler.';
}
