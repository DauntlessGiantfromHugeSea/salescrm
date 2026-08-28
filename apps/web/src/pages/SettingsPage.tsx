import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatDateTime, relativeDays } from '../lib/format';
import { Modal } from '../components/Modal';
import type { SessionUser } from '../App';

interface Mailbox {
  id: string;
  address: string;
  displayName: string;
  kind: 'USER' | 'SHARED';
  authMode: 'DELEGATED' | 'APP_ONLY';
  syncEnabled: boolean;
  initialImportDone: boolean;
  folders: string[];
  ownerUserId: string | null;
  ownerName: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  messagesSynced: number;
  activityCount: number;
}

interface BookingLink {
  id: string;
  slug: string;
  title: string;
  durationMinutes: number;
  active: boolean;
  ownerName: string;
  bookingCount: number;
  url: string;
}

export function SettingsPage({ user }: { user: SessionUser }) {
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Einstellungen</h1>
          <div className="subtitle">Verbindung, Postfächer und Buchungslinks</div>
        </div>
      </div>

      <ConnectionCard user={user} />
      <BookingLinksCard />
      {user.role === 'ADMIN' && <MailboxesCard />}
      <SystemStatusCard />
    </>
  );
}

function ConnectionCard({ user }: { user: SessionUser }) {
  return (
    <div className="card mb">
      <div className="card-header">
        <h2 style={{ margin: 0 }}>Microsoft 365</h2>
      </div>
      <div className="card-body">
        <div className="field">
          <label>Angemeldet als</label>
          {user.email} {user.role === 'ADMIN' && <span className="badge accent">Administrator</span>}
        </div>
        <div className="field">
          <label>Verbundenes Postfach</label>
          {user.mailboxAddress ?? <span className="muted">keines</span>}
        </div>

        {user.unavailableFeatures.length > 0 && (
          <div className="notice warning">
            <strong>Eingeschränkte Funktionen.</strong> Für diese Bereiche fehlen Berechtigungen im Tenant:
            <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
              {user.unavailableFeatures.map((f) => (
                <li key={f.scope}>
                  {f.feature} <span className="mono small">({f.scope})</span>
                </li>
              ))}
            </ul>
            <div className="mt">
              Nach Freigabe durch die IT hilft eine erneute Anmeldung:{' '}
              <a href="/api/auth/login?prompt=consent">Berechtigungen erneut anfragen</a>
            </div>
          </div>
        )}

        <div className="field">
          <label>KI-Funktionen</label>
          {user.hasAi ? (
            <span className="badge success">verfügbar</span>
          ) : (
            <>
              <span className="badge">nicht eingerichtet</span>
              <div className="small muted">
                Ohne <span className="mono">ANTHROPIC_API_KEY</span> entfallen Mailentwürfe,
                Besprechungsnotizen und Firmenprofile. Import, Projektakte, Termine und Export
                laufen davon unabhängig.
              </div>
            </>
          )}
        </div>

        <div className="actions">
          <a href="/api/auth/login?prompt=consent">
            <button>Verbindung erneuern</button>
          </a>
        </div>
      </div>
    </div>
  );
}

function BookingLinksCard() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['booking-links'],
    queryFn: () => api.get<{ links: BookingLink[] }>('/api/booking-links'),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      api.patch(`/api/booking-links/${input.id}`, { active: input.active }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['booking-links'] }),
  });

  const links = data?.links ?? [];

  return (
    <div className="card mb">
      <div className="card-header">
        <h2 style={{ margin: 0 }}>Buchungslinks</h2>
        <button className="primary small" onClick={() => setCreating(true)}>
          Link anlegen
        </button>
      </div>
      <div className="card-body">
        <div className="small muted mb">
          Kunden buchen über diesen Link selbst einen Teams-Termin in Ihrem Kalender. Kontakt und Vorgang entstehen
          dabei automatisch.
        </div>

        {links.length === 0 ? (
          <div className="empty">Noch kein Buchungslink angelegt.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Titel</th>
                <th>Adresse</th>
                <th>Dauer</th>
                <th>Buchungen</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td>{link.title}</td>
                  <td className="small">
                    <a href={link.url} target="_blank" rel="noreferrer">
                      {link.url}
                    </a>
                  </td>
                  <td className="nowrap">{link.durationMinutes} Min.</td>
                  <td>{link.bookingCount}</td>
                  <td>
                    <span className={`badge ${link.active ? 'success' : ''}`}>
                      {link.active ? 'aktiv' : 'deaktiviert'}
                    </span>
                  </td>
                  <td className="nowrap">
                    <div className="actions">
                      <button
                        className="small"
                        onClick={() => {
                          void navigator.clipboard.writeText(link.url);
                          setCopied(link.id);
                          setTimeout(() => setCopied(null), 2000);
                        }}
                      >
                        {copied === link.id ? 'Kopiert' : 'Kopieren'}
                      </button>
                      <button className="small" onClick={() => toggle.mutate({ id: link.id, active: !link.active })}>
                        {link.active ? 'Deaktivieren' : 'Aktivieren'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CreateLinkModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateLinkModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    title: 'Erstgespräch',
    description: '',
    durationMinutes: 30,
    workdayStart: '09:00',
    workdayEnd: '17:00',
  });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/booking-links', {
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        durationMinutes: form.durationMinutes,
        workdayStart: form.workdayStart,
        workdayEnd: form.workdayEnd,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['booking-links'] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Anlegen fehlgeschlagen'),
  });

  return (
    <Modal
      title="Buchungslink anlegen"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" onClick={() => create.mutate()} disabled={!form.title.trim() || create.isPending}>
            Anlegen
          </button>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}
      <div className="field">
        <label htmlFor="l-title">Titel</label>
        <input id="l-title" type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="l-desc">Beschreibung</label>
        <textarea
          id="l-desc"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Was passiert in diesem Termin?"
        />
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="l-duration">Dauer</label>
          <select
            id="l-duration"
            value={form.durationMinutes}
            onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })}
          >
            <option value={15}>15 Minuten</option>
            <option value={30}>30 Minuten</option>
            <option value={45}>45 Minuten</option>
            <option value={60}>60 Minuten</option>
          </select>
        </div>
        <div className="field">
          <label>Buchbare Zeiten</label>
          <div className="actions">
            <input
              type="text"
              value={form.workdayStart}
              onChange={(e) => setForm({ ...form, workdayStart: e.target.value })}
              style={{ width: '80px' }}
            />
            <span>bis</span>
            <input
              type="text"
              value={form.workdayEnd}
              onChange={(e) => setForm({ ...form, workdayEnd: e.target.value })}
              style={{ width: '80px' }}
            />
          </div>
          <div className="small muted">Mo–Fr, freie Zeiten aus Ihrem Kalender</div>
        </div>
      </div>
    </Modal>
  );
}

function MailboxesCard() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const { data } = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () =>
      api.get<{ appOnlyEnabled: boolean; accessPolicyGroup: string | null; mailboxes: Mailbox[] }>(
        '/api/admin/mailboxes',
      ),
  });

  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: Array<{ id: string; displayName: string }> }>('/api/users'),
  });

  const discover = useMutation({
    mutationFn: () => api.post<{ discovered: number; added: number }>('/api/admin/mailboxes/discover'),
    onSuccess: (result) => {
      setMessage({
        tone: 'success',
        text: `${result.discovered} Postfächer gefunden, ${result.added} neu übernommen. Neue Postfächer sind deaktiviert – bitte Zuständigen eintragen und aktivieren.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
    },
    onError: (err) => setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Fehlgeschlagen' }),
  });

  const update = useMutation({
    mutationFn: (input: { id: string; patch: Record<string, unknown> }) =>
      api.patch(`/api/admin/mailboxes/${input.id}`, input.patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['mailboxes'] }),
    onError: (err) => setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Fehlgeschlagen' }),
  });

  const sync = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/sync/mailbox/${id}`),
    onSuccess: () => setMessage({ tone: 'success', text: 'Abgleich wurde eingereiht.' }),
  });

  return (
    <div className="card mb">
      <div className="card-header">
        <h2 style={{ margin: 0 }}>Firmenpostfächer</h2>
        {data?.appOnlyEnabled && (
          <button className="small" onClick={() => discover.mutate()} disabled={discover.isPending}>
            {discover.isPending ? 'Sucht …' : 'Postfächer suchen'}
          </button>
        )}
      </div>
      <div className="card-body">
        {message && <div className={`notice ${message.tone}`}>{message.text}</div>}

        {!data?.appOnlyEnabled ? (
          <div className="notice warning">
            Der firmenweite Postfachzugriff ist nicht aktiviert. Es werden nur die Postfächer der angemeldeten
            Benutzer gelesen. Zum Einschalten: <span className="mono">MS_APP_ONLY_ENABLED=true</span> setzen und die
            Anwendungsberechtigungen im Tenant freigeben (siehe <span className="mono">docs/AZURE_SETUP.md</span>).
          </div>
        ) : (
          <div className="notice info">
            Die Anwendung darf nur Postfächer lesen, die in der Zugriffsrichtlinie freigegeben sind
            {data.accessPolicyGroup && (
              <>
                {' '}
                (Gruppe <span className="mono">{data.accessPolicyGroup}</span>)
              </>
            )}
            . Alles außerhalb bleibt unerreichbar.
          </div>
        )}

        {!data?.mailboxes.length ? (
          <div className="empty">Noch keine Postfächer erfasst.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Postfach</th>
                <th>Zugriff</th>
                <th>Zuständig</th>
                <th>Mails</th>
                <th>Letzter Abgleich</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.mailboxes.map((mailbox) => (
                <tr key={mailbox.id}>
                  <td>
                    {mailbox.address}
                    <div className="row-meta">{mailbox.displayName}</div>
                  </td>
                  <td>
                    <span className={`badge ${mailbox.authMode === 'DELEGATED' ? 'success' : ''}`}>
                      {mailbox.authMode === 'DELEGATED' ? 'persönlich' : 'Anwendung'}
                    </span>
                  </td>
                  <td>
                    <select
                      value={mailbox.ownerUserId ?? ''}
                      onChange={(e) =>
                        update.mutate({ id: mailbox.id, patch: { ownerUserId: e.target.value || null } })
                      }
                    >
                      <option value="">– nicht gesetzt –</option>
                      {(users?.users ?? []).map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="nowrap">{mailbox.activityCount}</td>
                  <td className="nowrap small muted">{relativeDays(mailbox.lastSyncAt)}</td>
                  <td>
                    {mailbox.lastError ? (
                      <span className="badge danger" title={mailbox.lastError}>
                        Fehler
                      </span>
                    ) : !mailbox.syncEnabled ? (
                      <span className="badge">aus</span>
                    ) : !mailbox.initialImportDone ? (
                      <span className="badge warning">Erstimport läuft</span>
                    ) : (
                      <span className="badge success">aktiv</span>
                    )}
                  </td>
                  <td className="nowrap">
                    <div className="actions">
                      <button
                        className="small"
                        onClick={() => update.mutate({ id: mailbox.id, patch: { syncEnabled: !mailbox.syncEnabled } })}
                      >
                        {mailbox.syncEnabled ? 'Aus' : 'An'}
                      </button>
                      {mailbox.syncEnabled && (
                        <button className="small" onClick={() => sync.mutate(mailbox.id)}>
                          Jetzt abgleichen
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SystemStatusCard() {
  const { data } = useQuery({
    queryKey: ['status'],
    queryFn: () =>
      api.get<{
        lastRun: {
          date: string;
          dealsEvaluated: number;
          followUp: number;
          conflicts: number;
          finishedAt: string | null;
        } | null;
        syncStates: Array<{ resource: string; lastRunAt: string | null; lastError: string | null; itemsSynced: number }>;
      }>('/api/dashboard/status'),
  });

  return (
    <div className="card">
      <div className="card-header">
        <h2 style={{ margin: 0 }}>Systemstatus</h2>
      </div>
      <div className="card-body">
        <div className="field">
          <label>Letzter Priorisierungslauf</label>
          {data?.lastRun ? (
            <>
              {formatDateTime(data.lastRun.finishedAt)} · {data.lastRun.dealsEvaluated} Vorgänge bewertet ·{' '}
              {data.lastRun.followUp} Follow-ups · {data.lastRun.conflicts} Prüfpunkte
            </>
          ) : (
            <span className="muted">Noch kein Lauf erfolgt.</span>
          )}
        </div>

        {data?.syncStates.length ? (
          <table>
            <thead>
              <tr>
                <th>Bereich</th>
                <th>Letzter Lauf</th>
                <th>Datensätze</th>
                <th>Fehler</th>
              </tr>
            </thead>
            <tbody>
              {data.syncStates.map((state) => (
                <tr key={state.resource}>
                  <td className="mono small">{state.resource}</td>
                  <td className="small">{relativeDays(state.lastRunAt)}</td>
                  <td>{state.itemsSynced}</td>
                  <td className="small">
                    {state.lastError ? <span className="badge danger">{state.lastError}</span> : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}
