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
};

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
        </div>
      </div>
    </div>
  );
}
