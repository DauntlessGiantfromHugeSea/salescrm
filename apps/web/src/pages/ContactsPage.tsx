import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { relativeDays } from '../lib/format';

interface ContactRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  position: string | null;
  companyName: string | null;
  emailCount: number;
  projectCount: number;
  dealCount: number;
  optedOut: boolean;
  lastInboundAt: string | null;
}

export function ContactsPage() {
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['contacts', search],
    queryFn: () =>
      api.get<{ contacts: ContactRow[]; total: number }>(
        `/api/contacts?limit=200${search ? `&search=${encodeURIComponent(search)}` : ''}`,
      ),
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Kontakte</h1>
          <div className="subtitle">
            {data ? `${data.total} Kontakte aus Outlook-Adressbuch und Mailverkehr` : ' '}
          </div>
        </div>
      </div>

      <div className="card mb">
        <div className="card-body">
          <input
            type="text"
            placeholder="Name, E-Mail oder Firma …"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: '360px' }}
          />
        </div>
      </div>

      <div className="card">
        {isLoading ? (
          <div className="empty">
            <span className="spinner" /> Wird geladen …
          </div>
        ) : !data?.contacts.length ? (
          <div className="empty">Keine Kontakte gefunden.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Firma</th>
                <th>E-Mail</th>
                <th>Telefon</th>
                <th className="nowrap">Mails</th>
                <th className="nowrap">Projekte</th>
                <th>Letzte Nachricht</th>
              </tr>
            </thead>
            <tbody>
              {data.contacts.map((contact) => (
                <tr key={contact.id}>
                  <td>
                    <Link to={`/kontakte/${contact.id}`}>{contact.name}</Link>
                    {contact.position && <div className="row-meta">{contact.position}</div>}
                    {contact.optedOut && (
                      <div>
                        <span className="badge danger">Kontaktaufnahme widersprochen</span>
                      </div>
                    )}
                  </td>
                  <td>{contact.companyName ?? '–'}</td>
                  <td className="small">
                    <a href={`mailto:${contact.email}`}>{contact.email}</a>
                  </td>
                  <td className="small nowrap">{contact.phone ?? '–'}</td>
                  <td>{contact.emailCount}</td>
                  <td>{contact.projectCount}</td>
                  <td className="nowrap muted small">{relativeDays(contact.lastInboundAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
