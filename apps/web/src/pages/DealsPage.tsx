import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { DEAL_STAGES, DEAL_STAGE_LABELS, type DealStage } from '@salescrm/shared';
import { api, downloadFile } from '../lib/api';
import { relativeDays } from '../lib/format';
import { StageBadge } from '../components/Badges';

interface DealRow {
  id: string;
  title: string;
  stage: DealStage;
  nextAction: string | null;
  companyName: string | null;
  contactName: string | null;
  ownerName: string;
  lastContactAt: string | null;
  hasDraft: boolean;
  projectId: string | null;
  projectNumber: string | null;
}

export function DealsPage() {
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState<DealStage | ''>('');
  const [openOnly, setOpenOnly] = useState(params.get('openOnly') === 'true');

  const { data, isLoading } = useQuery({
    queryKey: ['deals', { search, stage, openOnly }],
    queryFn: () => {
      const query = new URLSearchParams({ limit: '200' });
      if (search) query.set('search', search);
      if (stage) query.set('stage', stage);
      if (openOnly) query.set('openOnly', 'true');
      return api.get<{ deals: DealRow[]; total: number }>(`/api/deals?${query}`);
    },
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Vorgänge</h1>
          <div className="subtitle">{data ? `${data.total} Einträge` : ' '}</div>
        </div>
        <button onClick={() => void downloadFile('/api/export/deals.xlsx', 'offene-vorgaenge.xlsx')}>
          Excel-Export
        </button>
      </div>

      <div className="card mb">
        <div className="card-body">
          <div className="actions">
            <input
              type="text"
              placeholder="Firma, Kontakt oder Titel …"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ maxWidth: '300px' }}
            />
            <select value={stage} onChange={(e) => setStage(e.target.value as DealStage | '')} style={{ width: 'auto' }}>
              <option value="">Alle Status</option>
              {DEAL_STAGES.map((s) => (
                <option key={s} value={s}>
                  {DEAL_STAGE_LABELS[s]}
                </option>
              ))}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0, fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={openOnly}
                onChange={(e) => setOpenOnly(e.target.checked)}
                style={{ width: 'auto' }}
              />
              nur offene
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        {isLoading ? (
          <div className="empty">
            <span className="spinner" /> Wird geladen …
          </div>
        ) : !data?.deals.length ? (
          <div className="empty">Keine Vorgänge gefunden.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Vorgang</th>
                <th>Status</th>
                <th>Firma / Kontakt</th>
                <th>Projekt</th>
                <th>Nächste Aktion</th>
                <th>Bearbeiter</th>
                <th>Letzter Kontakt</th>
              </tr>
            </thead>
            <tbody>
              {data.deals.map((deal) => (
                <tr key={deal.id}>
                  <td>
                    <Link to={`/vorgaenge/${deal.id}`}>{deal.title}</Link>
                    {deal.hasDraft && (
                      <div>
                        <span className="badge success">Entwurf bereit</span>
                      </div>
                    )}
                  </td>
                  <td>
                    <StageBadge stage={deal.stage} />
                  </td>
                  <td>
                    {deal.companyName ?? '–'}
                    {deal.contactName && <div className="row-meta">{deal.contactName}</div>}
                  </td>
                  <td className="mono small nowrap">
                    {deal.projectNumber ? <Link to={`/projekte/${deal.projectId}`}>{deal.projectNumber}</Link> : '–'}
                  </td>
                  <td className="small">{deal.nextAction ?? <span className="muted">keine</span>}</td>
                  <td className="nowrap">{deal.ownerName}</td>
                  <td className="nowrap muted small">{relativeDays(deal.lastContactAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
