import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import {
  SCOPES,
  CALENDAR_READONLY_SCOPE,
  GMAIL_MODIFY_SCOPE,
  missingScopes,
  generateAuthorizationUrl,
  assertConsentGrantedAllScopes,
} from '../src/auth.js';
import {
  CalendarService,
  googleCalendarTransport,
  loadCalendarConfig,
  sanitizeTitle,
  toCalendarError,
  toSafeEvent,
  type CalendarTransport,
} from '../src/calendar/service.js';
import { CalendarError } from '../src/calendar/types.js';
import { resolveTimePhrase, zonedToUtc, localParts } from '../src/calendar/time.js';
import {
  describeAvailability,
  describeNextEvent,
  describeOpenTimes,
  describeSchedule,
  formatClock,
  spokenCalendarFailure,
} from '../src/calendar/speech.js';

const TZ = 'America/Los_Angeles';
/** Wednesday, October 14, 2026, 12:00 PDT. */
const NOW = new Date('2026-10-14T19:00:00Z');

function local(iso: string): string {
  const p = localParts(new Date(iso), TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

interface Recorded {
  method: string;
  params: Record<string, unknown>;
}

/** Mock transport over canned raw Google payloads; records every call. */
function mockTransport(opts: {
  pages?: unknown[];
  events?: unknown[];
  freeBusy?: unknown;
  error?: unknown;
}): { transport: CalendarTransport; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let page = 0;
  const transport: CalendarTransport = {
    async listEvents(params) {
      calls.push({ method: 'listEvents', params });
      if (opts.error) throw opts.error;
      if (opts.pages) return opts.pages[page++];
      return { items: opts.events ?? [] };
    },
    async getEvent(params) {
      calls.push({ method: 'getEvent', params });
      if (opts.error) throw opts.error;
      return (opts.events ?? [])[0];
    },
    async freeBusy(params) {
      calls.push({ method: 'freeBusy', params });
      if (opts.error) throw opts.error;
      return opts.freeBusy;
    },
  };
  return { transport, calls };
}

function service(transport: CalendarTransport) {
  return new CalendarService(transport, { calendarId: 'primary', timeZone: TZ, timeoutMs: 1000 });
}

function ev(id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) {
  return { id, summary, start: { dateTime: start }, end: { dateTime: end }, ...extra };
}

function busyResponse(busy: Array<[string, string]>) {
  return { calendars: { primary: { busy: busy.map(([start, end]) => ({ start, end })) } } };
}

describe('Calendar auth reuses the business Google OAuth client', () => {
  it('requests calendar.readonly alongside every existing Gmail scope, and no Calendar write scope', () => {
    for (const s of [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      GMAIL_MODIFY_SCOPE,
      CALENDAR_READONLY_SCOPE,
    ]) {
      assert.ok(SCOPES.includes(s), s);
    }
    assert.equal(SCOPES.length, 4);
    assert.ok(!SCOPES.some((s) => /\/calendar(\.events)?$/.test(s)), 'no full Calendar or events write scope');
    const url = new URL(generateAuthorizationUrl(new google.auth.OAuth2('id', 'secret', 'http://localhost:3000')));
    assert.ok(url.searchParams.get('scope')!.includes(CALENDAR_READONLY_SCOPE));
    assert.ok(url.searchParams.get('scope')!.includes(GMAIL_MODIFY_SCOPE));
  });

  it('missingScopes detects a Gmail-only token and an unticked consent checkbox', () => {
    const gmailOnly = SCOPES.slice(0, 3).join(' ');
    assert.deepEqual(missingScopes(gmailOnly), [CALENDAR_READONLY_SCOPE]);
    assert.deepEqual(missingScopes(`${CALENDAR_READONLY_SCOPE} ${SCOPES[0]}`), [SCOPES[1], SCOPES[2]]);
    assert.deepEqual(missingScopes(SCOPES.join(' ')), []);
    assert.deepEqual(missingScopes(undefined), SCOPES);
  });

  it('a re-consent that drops Gmail or Calendar scopes is refused before the token is written', () => {
    assert.throws(() => assertConsentGrantedAllScopes(SCOPES.slice(0, 3).join(' '), '/x/token.business.json'), /missing: .*calendar\.readonly.*token\.business\.json was left unchanged/);
    assert.throws(() => assertConsentGrantedAllScopes(`${CALENDAR_READONLY_SCOPE} ${SCOPES[0]}`, '/x/token.business.json'), /gmail\.compose/);
    assert.throws(() => assertConsentGrantedAllScopes(undefined, '/x/token.business.json'));
    assert.doesNotThrow(() => assertConsentGrantedAllScopes(SCOPES.join(' '), '/x/token.business.json'));
  });

  it('a token without Calendar scope maps to a spoken "no permission yet"', () => {
    const err = toCalendarError({ response: { status: 403, data: { error: { message: 'Request had insufficient authentication scopes.' } } } });
    assert.equal(err.kind, 'missing_scope');
    assert.equal(spokenCalendarFailure('missing_scope'), "I don't have permission to read your calendar yet.");
  });
});

describe('Calendar configuration', () => {
  it('uses explicit, validated timezone and calendar ID', () => {
    assert.deepEqual(loadCalendarConfig({}), { calendarId: 'primary', timeZone: 'America/Los_Angeles', timeoutMs: 10000 });
    assert.equal(loadCalendarConfig({ PHRO_TIMEZONE: 'America/New_York', PHRO_CALENDAR_ID: 'bookings@group.calendar.google.com' }).timeZone, 'America/New_York');
    assert.throws(() => loadCalendarConfig({ PHRO_TIMEZONE: 'Pacific/Nowhere' }), (e: unknown) => e instanceof CalendarError && e.kind === 'config');
  });
});

describe('Natural time phrases (America/Los_Angeles, now = Wed Oct 14 2026 12:00)', () => {
  const r = (q: string) => {
    const w = resolveTimePhrase(q, NOW, TZ)!;
    return [local(w.start.toISOString()), local(w.end.toISOString()), w.label];
  };

  it('today, tomorrow, weekday, this/next weekend', () => {
    assert.deepEqual(r('What do I have today?'), ['2026-10-14 00:00', '2026-10-15 00:00', 'today']);
    assert.deepEqual(r('What do I have tomorrow?'), ['2026-10-15 00:00', '2026-10-16 00:00', 'tomorrow']);
    assert.deepEqual(r('What do I have Saturday?'), ['2026-10-17 00:00', '2026-10-18 00:00', 'Saturday']);
    assert.deepEqual(r('next Saturday'), ['2026-10-24 00:00', '2026-10-25 00:00', 'next Saturday']);
    assert.deepEqual(r('What is my schedule this weekend?'), ['2026-10-17 00:00', '2026-10-19 00:00', 'this weekend']);
    assert.deepEqual(r('next weekend'), ['2026-10-24 00:00', '2026-10-26 00:00', 'next weekend']);
  });

  it('this weekend on a Sunday is the weekend in progress', () => {
    const sunday = new Date('2026-10-18T19:00:00Z');
    const w = resolveTimePhrase('this weekend', sunday, TZ)!;
    assert.deepEqual([local(w.start.toISOString()), local(w.end.toISOString())], ['2026-10-17 00:00', '2026-10-19 00:00']);
  });

  it('time windows: from 5 to 10, 9 to 5, morning, after 7, explicit am/pm', () => {
    assert.deepEqual(r('Am I available Saturday from 5 to 10?'), ['2026-10-17 17:00', '2026-10-17 22:00', 'Saturday']);
    assert.deepEqual(r('Saturday 9 to 5'), ['2026-10-17 09:00', '2026-10-17 17:00', 'Saturday']);
    assert.deepEqual(r('tomorrow morning'), ['2026-10-15 06:00', '2026-10-15 12:00', 'tomorrow']);
    assert.deepEqual(r('Saturday after 7'), ['2026-10-17 19:00', '2026-10-18 00:00', 'Saturday']);
    assert.deepEqual(r('from 10 a.m. to 2 p.m. tomorrow'), ['2026-10-15 10:00', '2026-10-15 14:00', 'tomorrow']);
    assert.deepEqual(r('Saturday from 5:30 pm to 7'), ['2026-10-17 17:30', '2026-10-17 19:00', 'Saturday']);
    assert.equal(resolveTimePhrase('read me the draft', NOW, TZ), null);
  });

  it('timezone conversion does not depend on the machine timezone', () => {
    // Saturday 5 PM PDT is 00:00 UTC Sunday.
    const w = resolveTimePhrase('Saturday from 5 to 10', NOW, TZ)!;
    assert.equal(w.start.toISOString(), '2026-10-18T00:00:00.000Z');
    assert.equal(w.end.toISOString(), '2026-10-18T05:00:00.000Z');
    const ny = resolveTimePhrase('Saturday from 5 to 10', NOW, 'America/New_York')!;
    assert.equal(ny.start.toISOString(), '2026-10-17T21:00:00.000Z');
  });

  it('DST boundaries: the fall-back day is 25 hours, the spring-forward day is 23', () => {
    const fallBack = resolveTimePhrase('tomorrow', new Date('2026-10-31T19:00:00Z'), TZ)!; // Sun Nov 1 2026
    assert.equal((fallBack.end.getTime() - fallBack.start.getTime()) / 3_600_000, 25);
    assert.equal(fallBack.start.toISOString(), '2026-11-01T07:00:00.000Z');
    assert.equal(fallBack.end.toISOString(), '2026-11-02T08:00:00.000Z');
    const spring = resolveTimePhrase('tomorrow', new Date('2026-03-07T20:00:00Z'), TZ)!; // Sun Mar 8 2026
    assert.equal((spring.end.getTime() - spring.start.getTime()) / 3_600_000, 23);
    // 5 PM after the change is PDT (-7).
    assert.equal(zonedToUtc(TZ, { year: 2026, month: 3, day: 8 }, 17).toISOString(), '2026-03-09T00:00:00.000Z');
  });
});

describe('Calendar event listing', () => {
  it('lists today with expanded, timezone-aware, sorted, non-cancelled events', async () => {
    const { transport, calls } = mockTransport({
      events: [
        ev('b', 'Dinner', '2026-10-14T19:00:00-07:00', '2026-10-14T21:00:00-07:00'),
        ev('a', 'Team sync', '2026-10-14T10:00:00-07:00', '2026-10-14T11:00:00-07:00'),
        ev('c', 'Cancelled call', '2026-10-14T13:00:00-07:00', '2026-10-14T14:00:00-07:00', { status: 'cancelled' }),
      ],
    });
    const w = resolveTimePhrase('today', NOW, TZ)!;
    const events = await service(transport).listEvents(w.start, w.end);
    assert.deepEqual(events.map((e) => e.title), ['Team sync', 'Dinner']);
    assert.equal(calls[0].params.timeMin, '2026-10-14T07:00:00.000Z');
    assert.equal(calls[0].params.timeMax, '2026-10-15T07:00:00.000Z');
    assert.equal(calls[0].params.timeZone, TZ);
    assert.equal(describeSchedule(events, w, TZ, NOW), 'You have two events today: Team sync at 10 AM, and Dinner at 7 PM.');
  });

  it('tomorrow and upcoming windows', async () => {
    const { transport } = mockTransport({ events: [ev('x', 'Smith wedding booth', '2026-10-15T17:00:00-07:00', '2026-10-15T22:00:00-07:00')] });
    const w = resolveTimePhrase('tomorrow', NOW, TZ)!;
    const events = await service(transport).listEvents(w.start, w.end);
    assert.equal(describeSchedule(events, w, TZ, NOW), 'You have one event tomorrow: Smith wedding booth at 5 PM.');
    const weekend = resolveTimePhrase('this weekend', NOW, TZ)!;
    const { transport: t2 } = mockTransport({
      events: [
        ev('s1', 'Booth: Garcia quinceañera', '2026-10-17T18:00:00-07:00', '2026-10-17T23:00:00-07:00'),
        ev('s2', 'Brunch', '2026-10-18T10:00:00-07:00', '2026-10-18T11:30:00-07:00'),
      ],
    });
    const wkEvents = await service(t2).listEvents(weekend.start, weekend.end);
    assert.equal(
      describeSchedule(wkEvents, weekend, TZ, NOW),
      'You have two events this weekend: Booth: Garcia quinceañera Saturday at 6 PM, and Brunch Sunday at 10 AM.'
    );
    assert.match(describeSchedule(wkEvents, weekend, TZ, NOW, { bookingsOnly: true }), /^You have one booking this weekend: Booth: Garcia/);
  });

  it('next event skips past events', async () => {
    const { transport } = mockTransport({
      events: [
        ev('p', 'Earlier today', '2026-10-14T09:00:00-07:00', '2026-10-14T13:00:00-07:00'),
        ev('n', 'Photo booth setup', '2026-10-17T18:00:00-07:00', '2026-10-17T19:00:00-07:00'),
      ],
    });
    const next = await service(transport).nextEvent(NOW);
    assert.equal(next?.id, 'n');
    assert.equal(describeNextEvent(next, TZ, NOW), 'Your next event is Photo booth setup, Saturday at 6 PM.');
    assert.equal(describeNextEvent(null, TZ, NOW), "You don't have anything scheduled in the next 30 days.");
  });

  it('requests expanded recurring occurrences, never recurring masters', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const api = {
      events: {
        async list(params: Record<string, unknown>) {
          recorded.push(params);
          return {
            data: {
              items: [
                ev('weekly_20261014T170000Z', 'Weekly check-in', '2026-10-14T10:00:00-07:00', '2026-10-14T10:30:00-07:00', { recurringEventId: 'weekly' }),
                ev('weekly_20261021T170000Z', 'Weekly check-in', '2026-10-21T10:00:00-07:00', '2026-10-21T10:30:00-07:00', { recurringEventId: 'weekly' }),
              ],
            },
          };
        },
        async get() {
          return { data: {} };
        },
      },
      freebusy: { async query() { return { data: {} }; } },
    };
    const svc = new CalendarService(googleCalendarTransport({} as never, 1000, api), { calendarId: 'primary', timeZone: TZ, timeoutMs: 1000 });
    const events = await svc.listEvents(new Date('2026-10-14T07:00:00Z'), new Date('2026-10-28T07:00:00Z'));
    assert.equal(recorded[0].singleEvents, true);
    assert.equal(recorded[0].orderBy, 'startTime');
    assert.equal(recorded[0].showDeleted, false);
    assert.equal(events.length, 2, 'each occurrence is its own event');
  });

  it('follows pagination', async () => {
    const { transport, calls } = mockTransport({
      pages: [
        { items: [ev('1', 'One', '2026-10-15T09:00:00-07:00', '2026-10-15T10:00:00-07:00')], nextPageToken: 'p2' },
        { items: [ev('2', 'Two', '2026-10-15T11:00:00-07:00', '2026-10-15T12:00:00-07:00')] },
      ],
    });
    const events = await service(transport).listEvents(NOW, new Date('2026-10-16T00:00:00Z'));
    assert.deepEqual(events.map((e) => e.id), ['1', '2']);
    assert.equal(calls[1].params.pageToken, 'p2');
  });

  it('overlapping events are both reported', async () => {
    const { transport } = mockTransport({
      events: [
        ev('o1', 'Booth A', '2026-10-17T17:00:00-07:00', '2026-10-17T21:00:00-07:00'),
        ev('o2', 'Booth B', '2026-10-17T19:00:00-07:00', '2026-10-17T23:00:00-07:00'),
      ],
    });
    const w = resolveTimePhrase('Saturday', NOW, TZ)!;
    const events = await service(transport).listEvents(w.start, w.end);
    assert.equal(events.length, 2);
    assert.match(describeSchedule(events, w, TZ, NOW), /two events Saturday: Booth A at 5 PM, and Booth B at 7 PM/);
  });

  it('all-day events use local dates in the business timezone', async () => {
    const { transport } = mockTransport({ events: [{ id: 'h', summary: 'Booth maintenance day', start: { date: '2026-10-17' }, end: { date: '2026-10-18' } }] });
    const w = resolveTimePhrase('Saturday', NOW, TZ)!;
    const [allDay] = await service(transport).listEvents(w.start, w.end);
    assert.equal(allDay.allDay, true);
    assert.equal(allDay.start, '2026-10-17T07:00:00.000Z');
    assert.equal(allDay.end, '2026-10-18T07:00:00.000Z');
    assert.equal(describeSchedule([allDay], w, TZ, NOW), 'You have one event Saturday: Booth maintenance day, all day.');
  });

  it('events crossing midnight appear on both days', async () => {
    const late = ev('late', 'Late booth', '2026-10-17T21:00:00-07:00', '2026-10-18T01:00:00-07:00');
    const sat = resolveTimePhrase('Saturday', NOW, TZ)!;
    const sun = resolveTimePhrase('Sunday', NOW, TZ)!;
    assert.equal((await service(mockTransport({ events: [late] }).transport).listEvents(sat.start, sat.end)).length, 1);
    assert.equal((await service(mockTransport({ events: [late] }).transport).listEvents(sun.start, sun.end)).length, 1);
  });

  it('transparent events are marked free', () => {
    const e = toSafeEvent(ev('t', 'Hold (tentative)', '2026-10-17T10:00:00-07:00', '2026-10-17T11:00:00-07:00', { transparency: 'transparent' }), TZ)!;
    assert.equal(e.busy, false);
  });

  it('an empty calendar is a real empty answer', async () => {
    const w = resolveTimePhrase('Sunday', NOW, TZ)!;
    const events = await service(mockTransport({ events: [] }).transport).listEvents(w.start, w.end);
    assert.equal(describeSchedule(events, w, TZ, NOW), "You don't have anything scheduled Sunday.");
  });
});

describe('Calendar availability (FreeBusy)', () => {
  const sat5to10 = () => resolveTimePhrase('Saturday from 5 to 10', NOW, TZ)!;

  it('free window', async () => {
    const { transport, calls } = mockTransport({ freeBusy: busyResponse([]) });
    const w = sat5to10();
    const result = await service(transport).availability(w.start, w.end);
    assert.equal(result.isFree, true);
    assert.equal(calls[0].method, 'freeBusy');
    assert.equal(calls[0].params.timeZone, TZ);
    assert.equal(describeAvailability(result, w, TZ, NOW), "You're free Saturday from 5 to 10 PM.");
  });

  it('busy then free, with overlapping busy windows merged', async () => {
    const { transport } = mockTransport({
      freeBusy: busyResponse([
        ['2026-10-18T00:00:00Z', '2026-10-18T01:30:00Z'], // 5:00-6:30 PM
        ['2026-10-18T01:00:00Z', '2026-10-18T02:00:00Z'], // 6:00-7:00 PM (overlaps)
      ]),
    });
    const w = sat5to10();
    const result = await service(transport).availability(w.start, w.end);
    assert.equal(result.busy.length, 1);
    assert.equal(describeAvailability(result, w, TZ, NOW), "You're busy from 5 to 7 PM Saturday, but you're free after 7 PM.");
  });

  it('fully busy window (e.g. an all-day busy event)', async () => {
    const { transport } = mockTransport({ freeBusy: busyResponse([['2026-10-17T07:00:00Z', '2026-10-18T07:00:00Z']]) });
    const w = sat5to10();
    const result = await service(transport).availability(w.start, w.end);
    assert.equal(result.isFree, false);
    assert.equal(describeAvailability(result, w, TZ, NOW), "You're busy the whole time from 5 to 10 PM Saturday.");
  });

  it('a busy block ending exactly when the window starts is not a conflict', async () => {
    const { transport } = mockTransport({ freeBusy: busyResponse([['2026-10-17T22:00:00Z', '2026-10-18T00:00:00Z']]) }); // 3-5 PM
    const w = sat5to10();
    const result = await service(transport).availability(w.start, w.end);
    assert.equal(result.isFree, true);
  });

  it('open times for a day inside the owner day window', async () => {
    const { transport } = mockTransport({ freeBusy: busyResponse([['2026-10-17T19:00:00Z', '2026-10-17T22:00:00Z']]) }); // 12-3 PM
    const day = resolveTimePhrase('Saturday', NOW, TZ)!;
    const start = zonedToUtc(TZ, day.day!, 8);
    const end = zonedToUtc(TZ, day.day!, 22);
    const free = await service(transport).openTimes(start, end);
    assert.equal(describeOpenTimes(free, day, start, end, TZ, NOW), 'Saturday you\'re free from 8 AM to noon, and after 3 PM.');
  });

  it('calendar-level FreeBusy errors fail closed instead of reporting free', async () => {
    const { transport } = mockTransport({ freeBusy: { calendars: { primary: { busy: [], errors: [{ domain: 'global', reason: 'backendError' }] } } } });
    const w = sat5to10();
    await assert.rejects(service(transport).availability(w.start, w.end), (e: unknown) => e instanceof CalendarError && e.kind === 'upstream_error');
  });
});

describe('Calendar failures never become empty schedules or availability', () => {
  const w = () => resolveTimePhrase('Saturday from 5 to 10', NOW, TZ)!;
  const cases: Array<[string, unknown, string]> = [
    ['401', { response: { status: 401, data: { error: 'invalid_token' } } }, 'unauthorized'],
    ['invalid_grant', { response: { status: 400, data: { error: 'invalid_grant' } } }, 'unauthorized'],
    ['timeout', { code: 'ETIMEDOUT', message: 'timeout of 1000ms exceeded' }, 'timeout'],
    ['network', { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }, 'network'],
    ['5xx', { response: { status: 503 } }, 'upstream_error'],
    ['api disabled', { response: { status: 403, data: { error: { errors: [{ reason: 'accessNotConfigured' }] } } } }, 'config'],
  ];
  for (const [name, error, kind] of cases) {
    it(`${name} -> ${kind}`, async () => {
      const { transport } = mockTransport({ error });
      await assert.rejects(service(transport).availability(w().start, w().end), (e: unknown) => e instanceof CalendarError && e.kind === kind);
      await assert.rejects(service(transport).listEvents(w().start, w().end), (e: unknown) => e instanceof CalendarError && e.kind === kind);
    });
  }

  it('malformed responses are rejected', async () => {
    await assert.rejects(service(mockTransport({ freeBusy: { nope: true } }).transport).availability(w().start, w().end), (e: unknown) => e instanceof CalendarError && e.kind === 'malformed_response');
    await assert.rejects(service(mockTransport({ freeBusy: busyResponse([['not-a-date', '2026-10-18T01:00:00Z']]) }).transport).availability(w().start, w().end), (e: unknown) => e instanceof CalendarError && e.kind === 'malformed_response');
    await assert.rejects(service(mockTransport({ pages: [{ items: 'x' }] }).transport).listEvents(w().start, w().end), (e: unknown) => e instanceof CalendarError && e.kind === 'malformed_response');
    await assert.rejects(service(mockTransport({ events: [{ id: 'x', summary: 'No times' }] }).transport).listEvents(w().start, w().end), (e: unknown) => e instanceof CalendarError && e.kind === 'malformed_response');
  });

  it('spoken failures are failures', () => {
    assert.equal(spokenCalendarFailure('unauthorized'), "I can't authenticate with Google Calendar right now.");
    assert.equal(spokenCalendarFailure('timeout'), "Google Calendar isn't responding right now.");
    assert.equal(spokenCalendarFailure('network'), "Google Calendar isn't responding right now.");
    assert.equal(spokenCalendarFailure('malformed_response'), "I couldn't safely interpret the calendar response.");
    for (const k of ['unauthorized', 'timeout', 'network', 'upstream_error', 'malformed_response', 'missing_scope', 'config', 'not_found', 'other']) {
      assert.doesNotMatch(spokenCalendarFailure(k), /\bfree\b|\bavailable\b|nothing scheduled/i, k);
    }
  });
});

describe('Calendar privacy and read-only transport', () => {
  it('the safe model keeps only title/times/flags and strips contact details from titles', () => {
    const raw = {
      id: 'evt_1',
      summary: 'Call jane@client.com re: booth https://zoom.us/j/123 +1 (949) 555-0123',
      description: 'Private notes: gate code 4455',
      location: '123 Main St',
      attendees: [{ email: 'jane@client.com' }],
      organizer: { email: 'owner@pacifichorizonlabs.com' },
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      htmlLink: 'https://www.google.com/calendar/event?eid=xyz',
      attachments: [{ fileUrl: 'https://drive.google.com/x' }],
      start: { dateTime: '2026-10-17T17:00:00-07:00' },
      end: { dateTime: '2026-10-17T18:00:00-07:00' },
    };
    const safe = toSafeEvent(raw, TZ)!;
    assert.deepEqual(Object.keys(safe).sort(), ['allDay', 'busy', 'end', 'id', 'start', 'title']);
    assert.equal(safe.title, 'Call re: booth');
    const serialized = JSON.stringify(safe);
    for (const leak of ['jane@client.com', 'zoom.us', '555-0123', 'gate code', 'Main St', 'owner@', 'meet.google', 'drive.google']) {
      assert.ok(!serialized.includes(leak), leak);
    }
  });

  it('private events are spoken as "Private event"', () => {
    const safe = toSafeEvent(ev('p', 'Doctor appointment', '2026-10-17T10:00:00-07:00', '2026-10-17T11:00:00-07:00', { visibility: 'private' }), TZ)!;
    assert.equal(safe.title, 'Private event');
    assert.equal(sanitizeTitle(''), 'Untitled event');
  });

  it('spoken clock times never include raw timestamps', () => {
    assert.equal(formatClock('2026-10-17T19:00:00Z', TZ), 'noon');
    assert.equal(formatClock('2026-10-18T00:30:00Z', TZ), '5:30 PM');
  });

  it('the Google transport only ever touches events.list, events.get and freebusy.query', async () => {
    const touched: string[] = [];
    const track = (name: string): unknown =>
      new Proxy(async () => ({ data: { items: [], calendars: { primary: { busy: [] } } } }), {
        get: (_t, prop) => {
          touched.push(`${name}.${String(prop)}`);
          return track(`${name}.${String(prop)}`);
        },
      });
    const api = { events: track('events'), freebusy: track('freebusy') } as never;
    const transport = googleCalendarTransport({} as never, 1000, api);
    await transport.listEvents({ calendarId: 'primary', timeMin: 'a', timeMax: 'b', timeZone: TZ });
    await transport.getEvent({ calendarId: 'primary', eventId: 'x' });
    await transport.freeBusy({ calendarId: 'primary', timeMin: 'a', timeMax: 'b', timeZone: TZ });
    const methods = new Set(touched.filter((t) => !t.includes('then')));
    assert.deepEqual([...methods].sort(), ['events.get', 'events.list', 'freebusy.query']);
    assert.ok(!('createEvent' in transport) && !('insert' in transport) && !('update' in transport) && !('delete' in transport));
    assert.deepEqual(Object.keys(transport).sort(), ['freeBusy', 'getEvent', 'listEvents']);
  });
});
