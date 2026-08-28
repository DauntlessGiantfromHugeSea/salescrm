import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BUCKET_LABELS } from '@salescrm/shared';
import { api, downloadFile } from '../lib/api';
import { relativeDays } from '../lib/format';
import { StageBadge } from '../components/Badges';
import type { SessionUser } from '../App';

interface DealSummary {
  id: string;
  title: string;
  stage: Parameters<typeof StageBadge>[0]['stage'];
  nextAction: string | null;
  companyName: string | null;
  contactName: string | null;
  ownerName: string;
  lastContactAt: string | null;
  hasDraft: boolean;
  openReasons: string[];
  projectId: string | null;
  projectNumber: string | null;
  projectName: string | null;
}

interface ReviewItem {
  id: string;
  title: string;
  detail: string;
  dealId: string | null;
  projectId: string | null;
}

interface Dashboard {
  date: string;
  generatedAt: string;
  buckets: {
    A_FOLLOW_UP: DealSummary[];
    B_REACTIVATION: DealSummary[];
    C_COLD_OUTREACH: DealSummary[];
  };
  conflicts: ReviewItem[];
  counts: {
    followUp: number;
    reactivation: number;
    coldOutreach: number;
    conflicts: number;
    draftsPending: number;
  };
}

/**
 * Die Tagesübersicht (Kapitel 9.1).
 * Die eine Seite, mit der der Arbeitstag beginnt: was liegt an, was ist unklar.
 */
export function DashboardPage({ user }: { user: SessionUser }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<Dashboard>('/api/dashboard'),
  });

  if (isLoading) {
    return (
      <div className="empty">
        <span className="spinner" /> Tagesübersicht wird geladen …
      </div>
    );
  }
  if (error || !data) {
    return <div className="notice error">Die Tagesübersicht konnte nicht geladen werden.</div>;
  }

  const nothingToDo =
    data.counts.followUp + data.counts.reactivation + data.counts.coldOutreach + data.counts.conflicts === 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Guten Tag, {user.displayName.split(' ')[0]}</h1>
          <div className="subtitle">
            Stand {new Date(data.generatedAt).toLocaleString('de-DE', { dateStyle: 'long', timeStyle: 'short' })}
          </div>
        </div>
        <div className="actions">
          <button onClick={() => void downloadFile('/api/export/deals.xlsx', `offene-vorgaenge-${data.date}.xlsx`)}>
            Excel-Export
          </button>
          <Link to="/entwuerfe">
            <button className="primary">
              Entwürfe prüfen{data.counts.draftsPending > 0 && ` (${data.counts.draftsPending})`}
            </button>
          </Link>
        </div>
      </div>

      <div className="grid grid-4 mb">
        <Stat label="A – Follow-up" value={data.counts.followUp} hint="ohne Antwort, Frist abgelaufen" />
        <Stat label="B – Reaktivierung" value={data.counts.reactivation} hint="lange kein Kontakt" />
        <Stat label="C – Kaltakquise" value={data.counts.coldOutreach} hint="noch nie kontaktiert" />
        <Stat label="D – Prüfen" value={data.counts.conflicts} hint="unklar, braucht eine Entscheidung" />
      </div>

      {nothingToDo && (
        <div className="notice success">
          Nichts Offenes. Alle Vorgänge sind beantwortet, terminiert oder bewusst zurückgestellt.
        </div>
      )}

      <div className="grid grid-2">
        <BucketCard title={BUCKET_LABELS.A_FOLLOW_UP} deals={data.buckets.A_FOLLOW_UP} />
        <BucketCard title={BUCKET_LABELS.B_REACTIVATION} deals={data.buckets.B_REACTIVATION} />
        <BucketCard title={BUCKET_LABELS.C_COLD_OUTREACH} deals={data.buckets.C_COLD_OUTREACH} />

        <div className="card">
          <div className="card-header">
            <h2 style={{ margin: 0 }}>{BUCKET_LABELS.D_CONFLICTS}</h2>
            <Link to="/pruefen" className="small">
              Alle anzeigen
            </Link>
          </div>
          <div className="card-body tight">
            {data.conflicts.length === 0 ? (
              <div className="empty">Keine offenen Prüfpunkte.</div>
            ) : (
              <ul className="list">
                {data.conflicts.slice(0, 8).map((item) => (
                  <li key={item.id}>
                    <div className="row-title">{item.title}</div>
                    <div className="row-meta">{item.detail}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="hint">{hint}</div>
    </div>
  );
}

function BucketCard({ title, deals }: { title: string; deals: DealSummary[] }) {
  return (
    <div className="card">
      <div className="card-header">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="badge">{deals.length}</span>
      </div>
      <div className="card-body tight">
        {deals.length === 0 ? (
          <div className="empty">Nichts offen.</div>
        ) : (
          <ul className="list">
            {deals.slice(0, 12).map((deal) => (
              <li key={deal.id}>
                <div className="row">
                  <div style={{ minWidth: 0 }}>
                    <div className="row-title">
                      <Link to={`/vorgaenge/${deal.id}`}>{deal.title}</Link>
                    </div>
                    <div className="row-meta">
                      {[deal.companyName, deal.contactName].filter(Boolean).join(' · ') || 'ohne Firma'}
                      {' · '}
                      Letzter Kontakt {relativeDays(deal.lastContactAt)}
                    </div>
                    {deal.projectNumber && (
                      <div className="row-meta">
                        <Link to={`/projekte/${deal.projectId}`}>
                          {deal.projectNumber} {deal.projectName}
                        </Link>
                      </div>
                    )}
                    {/* Die Begründung der Regel-Engine – damit nachvollziehbar
                        bleibt, warum ein Vorgang heute in der Liste steht. */}
                    <div className="badges">
                      {deal.openReasons.map((reason) => (
                        <span key={reason} className="badge">
                          {reason}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }} className="nowrap">
                    <StageBadge stage={deal.stage} />
                    {deal.hasDraft && (
                      <div style={{ marginTop: '0.35rem' }}>
                        <span className="badge success">Entwurf bereit</span>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {deals.length > 12 && (
          <div style={{ padding: '0.6rem 1rem', borderTop: '1px solid var(--border)' }} className="small muted">
            + {deals.length - 12} weitere · <Link to="/vorgaenge?openOnly=true">alle Vorgänge</Link>
          </div>
        )}
      </div>
    </div>
  );
}
