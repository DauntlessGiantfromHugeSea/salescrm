import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../lib/api';
import type { SessionUser } from '../App';

const NAV = [
  { to: '/', label: 'Heute', end: true },
  { to: '/entwuerfe', label: 'Entwürfe' },
  { to: '/projekte', label: 'Projekte' },
  { to: '/vorgaenge', label: 'Vorgänge' },
  { to: '/kontakte', label: 'Kontakte' },
  { to: '/pruefen', label: 'Prüfen' },
  { to: '/einstellungen', label: 'Einstellungen' },
];

export function Layout({ user, children }: { user: SessionUser; children: ReactNode }) {
  async function logout(): Promise<void> {
    await api.post('/api/auth/logout');
    window.location.href = '/login';
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Akquise</span>
        <nav>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="user">
          <span>
            {user.displayName}
            {user.role === 'ADMIN' && <span className="badge accent" style={{ marginLeft: '0.4rem' }}>Admin</span>}
          </span>
          <button className="small" onClick={() => void logout()}>
            Abmelden
          </button>
        </div>
      </header>

      <main>
        {/* Im Demo-Modus soll auf jedem Bildschirm sichtbar sein, dass hier
            keine echten Daten stehen und nichts nach außen geht. */}
        {user.demoMode && (
          <div className="notice warning">
            <strong>Demo-Modus.</strong> Keine Verbindung zu Microsoft 365: es werden keine Postfächer gelesen,
            keine Termine angelegt und keine E-Mails versendet. Die angezeigten Daten sind Beispieldaten.
          </div>
        )}
        {/* Ein abgelaufenes Token ist der häufigste Grund, warum morgens
            nichts Neues da ist – deshalb steht der Hinweis ganz oben. */}
        {user.connectionError && (
          <div className="notice error">
            <strong>Die Verbindung zu Microsoft 365 ist gestört.</strong> {user.connectionError}{' '}
            <a href="/api/auth/login">Erneut anmelden</a>
          </div>
        )}
        {!user.hasMailboxConnected && !user.demoMode && (
          <div className="notice warning">
            Es ist kein Postfach verbunden. Ohne Verbindung werden keine Mails gelesen und keine Termine angelegt.{' '}
            <a href="/api/auth/login">Jetzt verbinden</a>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
