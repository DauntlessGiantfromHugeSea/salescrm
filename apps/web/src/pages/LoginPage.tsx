import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

const ERRORS: Record<string, string> = {
  not_allowed: 'Diese Adresse ist für das System nicht freigeschaltet. Bitte wenden Sie sich an die Administration.',
  state_mismatch: 'Die Anmeldung konnte nicht überprüft werden. Bitte erneut versuchen.',
  token_exchange: 'Microsoft hat die Anmeldung abgelehnt. Bitte erneut versuchen.',
  missing_scopes:
    'Es fehlen Berechtigungen für Postfach oder Kalender. Ohne sie kann das System nicht arbeiten – bitte die Administration einschalten.',
  no_refresh_token:
    'Microsoft hat keinen dauerhaften Zugriff erteilt. In den Tenant-Einstellungen muss „offline_access" erlaubt sein.',
  missing_code: 'Die Anmeldung wurde abgebrochen.',
  no_account: 'Es konnte kein Konto ermittelt werden.',
  no_microsoft:
    'Microsoft 365 ist für dieses System noch nicht eingerichtet. Zum Ausprobieren steht die Demo-Anmeldung bereit.',
};

/**
 * Bietet die Anmeldung ohne Microsoft an, aber nur wenn der Server sie
 * tatsächlich bereitstellt. Die Prüfung läuft über einen Aufruf gegen die
 * Route selbst: gibt es sie nicht, bleibt der Bereich leer.
 */
function DemoLogin() {
  const { data } = useQuery({
    queryKey: ['demo-available'],
    queryFn: async () => {
      const response = await fetch('/api/health/demo', { credentials: 'same-origin' });
      if (!response.ok) return { demoMode: false };
      return (await response.json()) as { demoMode: boolean };
    },
    retry: false,
    staleTime: Infinity,
  });

  if (!data?.demoMode) return null;

  return (
    <div className="notice warning mt" style={{ textAlign: 'left' }}>
      <strong>Demo-Modus aktiv.</strong> Dieses System ist noch nicht mit Microsoft 365 verbunden.
      Sie können sich ohne Microsoft anmelden und die Anwendung mit Beispieldaten ansehen – es werden
      keine Postfächer gelesen und keine E-Mails versendet.
      <div className="mt">
        <a href="/api/auth/demo-login">
          <button>Ohne Microsoft ansehen</button>
        </a>
      </div>
    </div>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const error = params.get('error');
  const detail = params.get('detail');

  return (
    <div className="booking-page">
      <div className="card">
        <div className="card-body" style={{ textAlign: 'center', padding: '2.5rem 2rem' }}>
          <h1>Akquisesystem</h1>
          <p className="muted">
            Anmeldung mit dem Microsoft-365-Konto der Firma. Ein eigenes Passwort gibt es nicht.
          </p>

          {error && (
            <div className="notice error" style={{ textAlign: 'left' }}>
              {ERRORS[error] ?? 'Die Anmeldung ist fehlgeschlagen.'}
              {detail && <div className="small mono mt">{detail}</div>}
            </div>
          )}

          <a href="/api/auth/login">
            <button className="primary" style={{ padding: '0.6rem 1.5rem', fontSize: '1rem' }}>
              Mit Microsoft anmelden
            </button>
          </a>

          <p className="small muted mt">
            Beim ersten Mal fragt Microsoft nach Zustimmung zu Postfach-, Kalender- und Teams-Zugriff.
          </p>

          {/* Nur sichtbar, wenn der Server im Demo-Modus läuft – sonst
              antwortet die Route mit 404 und der Hinweis wäre irreführend. */}
          <DemoLogin />
        </div>
      </div>
    </div>
  );
}
