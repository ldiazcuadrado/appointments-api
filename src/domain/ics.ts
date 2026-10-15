export interface IcsEvent {
  uid: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description?: string;
  location?: string;
  status: 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED';
  /** Revision counter; bump when the event changes so clients replace it. */
  sequence?: number;
  stamp: Date;
}

const formatUtc = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

export const escapeText = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/[;,]/g, (char) => `\\${char}`)
    .replace(/\r?\n/g, '\\n');

/** Folds a content line at 75 octets without splitting a multi-byte character. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let limit = 75;
  for (const char of line) {
    if (Buffer.byteLength(current + char) > limit) {
      parts.push(current);
      current = '';
      limit = 74;
    }
    current += char;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(event: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//appointments-api//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${formatUtc(event.stamp)}`,
    `DTSTART:${formatUtc(event.startsAt)}`,
    `DTEND:${formatUtc(event.endsAt)}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `STATUS:${event.status}`,
    `SUMMARY:${escapeText(event.summary)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
