/** Einheitliche Formatierung. Alles auf Deutsch, alles in Europe/Berlin. */

const TZ = 'Europe/Berlin';

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '–';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '–';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  });
}

export function formatSlot(start: string, end: string): string {
  const from = new Date(start);
  const to = new Date(end);
  const day = from.toLocaleDateString('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    timeZone: TZ,
  });
  const time = (d: Date): string =>
    d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  return `${day}, ${time(from)}–${time(to)} Uhr`;
}

/** "vor 12 Tagen" – nützlicher als ein Datum, wenn es um Liegezeiten geht. */
export function relativeDays(value: string | Date | null | undefined): string {
  if (!value) return 'noch nie';
  const date = typeof value === 'string' ? new Date(value) : value;
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 0) return `in ${Math.abs(days)} Tagen`;
  if (days === 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days < 31) return `vor ${days} Tagen`;
  const months = Math.floor(days / 30);
  if (months < 24) return `vor ${months} Monaten`;
  return `vor ${Math.floor(months / 12)} Jahren`;
}
