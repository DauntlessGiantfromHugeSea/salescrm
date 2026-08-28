import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { REVIEW_TYPE_LABELS, type ReviewType } from '@salescrm/shared';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';

interface Candidate {
  id: string;
  email?: string;
  name?: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  position?: string | null;
  emailCount?: number;
  emailDomain?: string | null;
  website?: string | null;
  createdAt: string;
  company?: { name: string } | null;
  _count?: { contacts: number; deals: number };
}

interface ReviewItem {
  id: string;
  type: ReviewType;
  title: string;
  detail: string;
  createdAt: string;
  dealId: string | null;
  dealTitle: string | null;
  projectId: string | null;
  projectNumber: string | null;
  candidates: {
    contactA: Candidate | null;
    contactB: Candidate | null;
    companyA: Candidate | null;
    companyB: Candidate | null;
  };
}

/**
 * Bucket D. Hier trifft ein Mensch die Entscheidungen, die das System
 * bewusst nicht selbst trifft.
 */
export function ReviewsPage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['reviews'],
    queryFn: () => api.get<{ items: ReviewItem[] }>('/api/reviews?status=OPEN'),
  });

  const resolve = useMutation({
    mutationFn: (input: { id: string; action: string; keepId?: string }) =>
      api.post(`/api/reviews/${input.id}/resolve`, { action: input.action, keepId: input.keepId }),
    onSuccess: () => {
      setMessage('Erledigt.');
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const items = data?.items ?? [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Prüfen</h1>
          <div className="subtitle">
            Fälle, die das System nicht selbst entscheidet. Nichts wird automatisch geändert oder gelöscht.
          </div>
        </div>
      </div>

      {message && <div className="notice success">{message}</div>}

      {isLoading ? (
        <div className="empty">
          <span className="spinner" /> Wird geladen …
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <div className="empty">Nichts zu prüfen.</div>
        </div>
      ) : (
        <div className="grid">
          {items.map((item) => {
            const isDuplicate = item.type === 'DUPLICATE_CONTACT' || item.type === 'DUPLICATE_COMPANY';
            const a = item.candidates.contactA ?? item.candidates.companyA;
            const b = item.candidates.contactB ?? item.candidates.companyB;

            return (
              <div className="card" key={item.id}>
                <div className="card-header">
                  <div>
                    <h2 style={{ margin: 0 }}>{item.title}</h2>
                    <span className="badge">{REVIEW_TYPE_LABELS[item.type] ?? item.type}</span>
                  </div>
                  <span className="small muted nowrap">seit {formatDate(item.createdAt)}</span>
                </div>
                <div className="card-body">
                  <p style={{ marginTop: 0 }}>{item.detail}</p>

                  {item.dealId && (
                    <p className="small">
                      Vorgang: <Link to={`/vorgaenge/${item.dealId}`}>{item.dealTitle}</Link>
                    </p>
                  )}
                  {item.projectId && (
                    <p className="small">
                      Projekt: <Link to={`/projekte/${item.projectId}`}>{item.projectNumber}</Link>
                    </p>
                  )}

                  {isDuplicate && a && b && (
                    <div className="grid grid-2 mb">
                      <CandidateCard candidate={a} label="Datensatz A" />
                      <CandidateCard candidate={b} label="Datensatz B" />
                    </div>
                  )}

                  <div className="actions">
                    {isDuplicate && a && b ? (
                      <>
                        <button
                          className="primary"
                          onClick={() => resolve.mutate({ id: item.id, action: 'MERGE', keepId: a.id })}
                        >
                          Zusammenführen, A behalten
                        </button>
                        <button onClick={() => resolve.mutate({ id: item.id, action: 'MERGE', keepId: b.id })}>
                          Zusammenführen, B behalten
                        </button>
                        <button onClick={() => resolve.mutate({ id: item.id, action: 'KEEP_BOTH' })}>
                          Sind verschieden
                        </button>
                      </>
                    ) : (
                      <button className="primary" onClick={() => resolve.mutate({ id: item.id, action: 'RESOLVE' })}>
                        Erledigt
                      </button>
                    )}
                    <div className="spacer" />
                    <button onClick={() => resolve.mutate({ id: item.id, action: 'DISMISS' })}>
                      Nicht mehr anzeigen
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function CandidateCard({ candidate, label }: { candidate: Candidate; label: string }) {
  const title =
    candidate.name ?? [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') ?? candidate.email ?? '–';

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.75rem' }}>
      <div className="small muted">{label}</div>
      <div className="row-title">{title}</div>
      {candidate.email && <div className="small">{candidate.email}</div>}
      {candidate.emailDomain && <div className="small">{candidate.emailDomain}</div>}
      {candidate.website && <div className="small">{candidate.website}</div>}
      {candidate.phone && <div className="small">{candidate.phone}</div>}
      {candidate.position && <div className="small muted">{candidate.position}</div>}
      {candidate.company?.name && <div className="small muted">{candidate.company.name}</div>}
      <div className="small muted mt">
        angelegt {formatDate(candidate.createdAt)}
        {candidate.emailCount !== undefined && ` · ${candidate.emailCount} Mails`}
        {candidate._count && ` · ${candidate._count.contacts} Kontakte, ${candidate._count.deals} Vorgänge`}
      </div>
    </div>
  );
}
