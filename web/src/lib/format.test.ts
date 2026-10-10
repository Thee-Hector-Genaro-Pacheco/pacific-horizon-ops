import { describe, expect, it } from 'vitest';
import { duration, humanize, initials, relativeTime } from './format';

describe('relativeTime', () => {
  const now = Date.parse('2026-10-04T22:00:00Z');
  it('formats recent and older timestamps', () => {
    expect(relativeTime('2026-10-04T21:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-10-04T21:56:00Z', now)).toBe('4m ago');
    expect(relativeTime('2026-10-04T19:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-10-03T12:00:00Z', now)).toBe('Yesterday');
  });
  it('tolerates small clock skew and missing values', () => {
    expect(relativeTime('2026-10-04T22:00:30Z', now)).toBe('just now');
    expect(relativeTime(null, now)).toBe('—');
    expect(relativeTime('not a date', now)).toBe('—');
  });
});

describe('duration / initials / humanize', () => {
  it('formats durations', () => {
    expect(duration(0)).toBe('0s');
    expect(duration(119)).toBe('1m 59s');
    expect(duration(3700)).toBe('1h 2m');
    expect(duration(null)).toBe('—');
  });
  it('derives initials without parenthetical org names', () => {
    expect(initials('Sarah Martinez')).toBe('SM');
    expect(initials('Hemachander Sekar (Twilio Support)')).toBe('HS');
    expect(initials('jerry')).toBe('JE');
  });
  it('humanizes tokens', () => {
    expect(humanize('booking_inquiry')).toBe('Booking inquiry');
  });
});
