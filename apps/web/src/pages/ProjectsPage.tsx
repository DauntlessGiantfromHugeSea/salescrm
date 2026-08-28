import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { PROJECT_STAGES, PROJECT_STAGE_LABELS, type ProjectStage } from '@salescrm/shared';
import { api, ApiError, downloadFile } from '../lib/api';
import { relativeDays } from '../lib/format';
import { ProjectStageBadge } from '../components/Badges';
import { Modal } from '../components/Modal';

interface ProjectRow {
  id: string;
  number: string;
  name: string;
  stage: ProjectStage;
  city: string | null;
  serviceArea: string | null;
  leadUserName: string;
  companyName: string | null;
  lastActivityAt: string | null;
  contactCount: number;
  memberCount: number;
  dealCount: number;
  activityCount: number;
}

/** Übersicht aller Bauprojekte. */
export function ProjectsPage() {
  const [search, setSearch] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['projects', { search, activeOnly }],
    queryFn: () =>
      api.get<{ projects: ProjectRow[] }>(
        `/api/projects?activeOnly=${activeOnly}${search ? `&search=${encodeURIComponent(search)}` : ''}`,
      ),
  });

  const projects = data?.projects ?? [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Bauprojekte</h1>
          <div className="subtitle">Beteiligte, Schriftverkehr und Vorgänge je Vorhaben</div>
        </div>
        <div className="actions">
          <button onClick={() => void downloadFile('/api/export/projects.xlsx', 'projekte.xlsx')}>Excel-Export</button>
          <button className="primary" onClick={() => setCreating(true)}>
            Projekt anlegen
          </button>
        </div>
      </div>

      <div className="card mb">
        <div className="card-body">
          <div className="actions">
            <input
              type="text"
              placeholder="Nummer, Name oder Ort …"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ maxWidth: '320px' }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0, fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => setActiveOnly(e.target.checked)}
                style={{ width: 'auto' }}
              />
              nur laufende
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        {isLoading ? (
          <div className="empty">
            <span className="spinner" /> Projekte werden geladen …
          </div>
        ) : projects.length === 0 ? (
          <div className="empty">
            Keine Projekte gefunden. Legen Sie ein Projekt mit seiner Projektnummer an – der vorhandene
            Mailverkehr wird dann automatisch zugeordnet.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nummer</th>
                <th>Projekt</th>
                <th>Phase</th>
                <th>Auftraggeber</th>
                <th>Projektleitung</th>
                <th className="nowrap">Beteiligte</th>
                <th className="nowrap">Mails</th>
                <th>Letzte Aktivität</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td className="mono nowrap">
                    <Link to={`/projekte/${project.id}`}>{project.number}</Link>
                  </td>
                  <td>
                    <Link to={`/projekte/${project.id}`}>{project.name}</Link>
                    {project.city && <div className="row-meta">{project.city}</div>}
                  </td>
                  <td>
                    <ProjectStageBadge stage={project.stage} />
                  </td>
                  <td>{project.companyName ?? '–'}</td>
                  <td className="nowrap">
                    {project.leadUserName}
                    {project.memberCount > 1 && <span className="muted"> +{project.memberCount - 1}</span>}
                  </td>
                  <td>{project.contactCount}</td>
                  <td>{project.activityCount}</td>
                  <td className="nowrap muted">{relativeDays(project.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CreateProjectModal onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    number: suggestNumber(),
    name: '',
    city: '',
    serviceArea: '',
    stage: 'LEAD' as ProjectStage,
    aliases: '',
  });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/projects', {
        number: form.number.trim(),
        name: form.name.trim(),
        city: form.city.trim() || undefined,
        serviceArea: form.serviceArea.trim() || undefined,
        stage: form.stage,
        aliases: form.aliases
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a.length >= 3),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projekte/${result.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Anlegen fehlgeschlagen'),
  });

  return (
    <Modal
      title="Bauprojekt anlegen"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button
            className="primary"
            onClick={() => create.mutate()}
            disabled={!form.number.trim() || !form.name.trim() || create.isPending}
          >
            {create.isPending ? 'Wird angelegt …' : 'Anlegen'}
          </button>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}

      <div className="field">
        <label htmlFor="p-number">Projektnummer</label>
        <input
          id="p-number"
          type="text"
          value={form.number}
          onChange={(e) => setForm({ ...form, number: e.target.value })}
          placeholder="2026-041"
        />
        <div className="small muted">
          Wichtigstes Zuordnungsmerkmal: Mails mit dieser Nummer im Betreff landen automatisch am Projekt.
        </div>
      </div>

      <div className="field">
        <label htmlFor="p-name">Bezeichnung</label>
        <input
          id="p-name"
          type="text"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Neubau Logistikzentrum Ost"
        />
      </div>

      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="p-city">Ort</label>
          <input id="p-city" type="text" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="p-stage">Phase</label>
          <select
            id="p-stage"
            value={form.stage}
            onChange={(e) => setForm({ ...form, stage: e.target.value as ProjectStage })}
          >
            {PROJECT_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {PROJECT_STAGE_LABELS[stage]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="p-service">Leistungsbereich</label>
        <input
          id="p-service"
          type="text"
          value={form.serviceArea}
          onChange={(e) => setForm({ ...form, serviceArea: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="p-aliases">Weitere Bezeichnungen</label>
        <input
          id="p-aliases"
          type="text"
          value={form.aliases}
          onChange={(e) => setForm({ ...form, aliases: e.target.value })}
          placeholder="BV Seestraße, Kundennummer 4711"
        />
        <div className="small muted">
          Kommagetrennt. Namen, unter denen das Vorhaben in Kundenmails auftaucht – sie werden ebenfalls für die
          automatische Zuordnung genutzt.
        </div>
      </div>
    </Modal>
  );
}

/** Schlägt die nächste Projektnummer im Format Jahr-Nummer vor. */
function suggestNumber(): string {
  return `${new Date().getFullYear()}-`;
}
