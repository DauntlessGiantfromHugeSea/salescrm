import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatSlot } from '../lib/format';

interface Slot {
  start: string;
  end: string;
  confidence: number;
}

interface BookingInfo {
  link: { title: string; description: string | null; durationMinutes: number; ownerName: string };
  slots: Slot[];
}

/**
 * Öffentliche Terminbuchung.
 *
 * Läuft ohne Anmeldung unter der eigenen Domain. Bewusst schlicht gehalten:
 * Zeitpunkt wählen, drei Felder ausfüllen, fertig. Der Teams-Termin entsteht
 * unmittelbar, die Einladung geht sofort raus.
 */
export function BookingPage() {
  const { slug } = useParams<{ slug: string }>();
  const [selected, setSelected] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: '', email: '', company: '', note: '' });
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['booking', slug],
    queryFn: () => api.get<BookingInfo>(`/api/public/booking/${slug}`),
    enabled: Boolean(slug),
    retry: false,
  });

  const book = useMutation({
    mutationFn: () =>
      api.post<{ startsAt: string; endsAt: string; joinUrl: string | null }>(`/api/public/booking/${slug}`, {
        start: selected?.start,
        name: form.name.trim(),
        email: form.email.trim(),
        company: form.company.trim() || undefined,
        note: form.note.trim() || undefined,
      }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Die Buchung ist fehlgeschlagen.'),
  });

  if (isLoading) {
    return (
      <div className="booking-page">
        <div className="empty">
          <span className="spinner" /> Freie Termine werden geladen …
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="booking-page">
        <div className="card">
          <div className="card-body">
            <h1>Terminbuchung</h1>
            <div className="notice error">
              Dieser Buchungslink ist nicht verfügbar. Bitte wenden Sie sich direkt an Ihren Ansprechpartner.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (book.isSuccess) {
    return (
      <div className="booking-page">
        <div className="card">
          <div className="card-body">
            <h1>Termin bestätigt</h1>
            <div className="notice success">
              Ihr Termin am <strong>{formatSlot(book.data.startsAt, book.data.endsAt)}</strong> steht.
              Die Einladung mit dem Teams-Link ist an {form.email} unterwegs.
            </div>
            {book.data.joinUrl && (
              <p>
                <a href={book.data.joinUrl} target="_blank" rel="noreferrer">
                  Direkt zur Teams-Besprechung
                </a>
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Termine nach Tagen gruppieren – eine flache Liste über zwei Wochen
  // ist unübersichtlich.
  const byDay = new Map<string, Slot[]>();
  for (const slot of data.slots) {
    const day = new Date(slot.start).toLocaleDateString('de-DE', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      timeZone: 'Europe/Berlin',
    });
    const group = byDay.get(day);
    if (group) group.push(slot);
    else byDay.set(day, [slot]);
  }

  const canSubmit = selected && form.name.trim().length > 1 && form.email.includes('@');

  return (
    <div className="booking-page">
      <div className="card">
        <div className="card-body">
          <h1>{data.link.title}</h1>
          <p className="muted">
            {data.link.durationMinutes} Minuten per Microsoft Teams mit {data.link.ownerName}
          </p>
          {data.link.description && <p>{data.link.description}</p>}

          {error && <div className="notice error">{error}</div>}

          {data.slots.length === 0 ? (
            <div className="notice warning">
              In den nächsten Wochen ist leider kein Termin frei. Bitte schreiben Sie uns direkt eine E-Mail.
            </div>
          ) : (
            <>
              <h2 className="mt">Zeitpunkt wählen</h2>
              {[...byDay.entries()].map(([day, slots]) => (
                <div className="day-group" key={day}>
                  <h3>{day}</h3>
                  <div className="slot-grid">
                    {slots.map((slot) => (
                      <button
                        key={slot.start}
                        className={selected?.start === slot.start ? 'selected' : ''}
                        onClick={() => setSelected(slot)}
                      >
                        {new Date(slot.start).toLocaleTimeString('de-DE', {
                          hour: '2-digit',
                          minute: '2-digit',
                          timeZone: 'Europe/Berlin',
                        })}{' '}
                        Uhr
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {selected && (
                <>
                  <h2 className="mt">Ihre Angaben</h2>
                  <div className="field">
                    <label htmlFor="b-name">Name *</label>
                    <input
                      id="b-name"
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      autoComplete="name"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="b-email">E-Mail *</label>
                    <input
                      id="b-email"
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      autoComplete="email"
                    />
                    <div className="small muted">An diese Adresse geht die Termineinladung.</div>
                  </div>
                  <div className="field">
                    <label htmlFor="b-company">Firma</label>
                    <input
                      id="b-company"
                      type="text"
                      value={form.company}
                      onChange={(e) => setForm({ ...form, company: e.target.value })}
                      autoComplete="organization"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="b-note">Worum geht es?</label>
                    <textarea
                      id="b-note"
                      value={form.note}
                      onChange={(e) => setForm({ ...form, note: e.target.value })}
                      placeholder="Kurz das Vorhaben oder die Fragestellung – das hilft uns bei der Vorbereitung."
                    />
                  </div>

                  <button
                    className="primary"
                    onClick={() => {
                      setError(null);
                      book.mutate();
                    }}
                    disabled={!canSubmit || book.isPending}
                    style={{ width: '100%', padding: '0.6rem' }}
                  >
                    {book.isPending
                      ? 'Termin wird gebucht …'
                      : `Termin ${formatSlot(selected.start, selected.end)} verbindlich buchen`}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
