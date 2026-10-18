import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import {
  CALENDAR_READONLY_SCOPE,
  authenticateViaLoopback,
  loadCredentials,
  missingScopes,
  resolveCredentialPath,
  resolveTokenPath,
} from '../auth.js';
import { CalendarService } from './service.js';
import { CalendarError, type SafeCalendarEvent } from './types.js';
import { addDays, localDateOf, resolveTimePhrase, zonedToUtc, type ResolvedWindow } from './time.js';
import { describeAvailability, describeNextEvent, describeSchedule, spokenCalendarFailure } from './speech.js';

function printHelp(): void {
  console.log(`
Pacific Rising Ops - Google Calendar CLI (read-only)

Commands:
  auth          One-time re-consent adding Calendar READ access to the business Google token.
                Backs up the current token first; keeps it unchanged unless every Gmail scope
                and calendar.readonly are granted.
                Usage: npm run calendar:auth

  today         Today's schedule.                  npm run calendar:today
  upcoming      Next N days (default 7).           npm run calendar:upcoming [-- <days>]
  next          Next event.                        npm run calendar:next
  availability  FreeBusy for a window, as ISO times or a spoken phrase.
                npm run calendar:availability -- 2026-10-24T17:00 2026-10-24T22:00
                npm run calendar:availability -- "Saturday from 5 to 10"

Configuration: PHRO_TIMEZONE (default America/Los_Angeles), PHRO_CALENDAR_ID (default primary).
Tokens are never printed. No command can create, change or delete Calendar events.
`);
}

function eventLine(ev: SafeCalendarEvent, tz: string): string {
  const fmt = (iso: string, withTime: boolean) =>
    new Date(iso).toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    });
  const when = ev.allDay ? `${fmt(ev.start, false)} (all day)` : `${fmt(ev.start, true)} - ${fmt(ev.end, true)}`;
  return `  ${when.padEnd(44)} ${ev.title}${ev.busy ? '' : '  [shown as free]'}`;
}

async function handleAuth(): Promise<void> {
  const { credentialPath } = resolveCredentialPath('business');
  const { tokenPath } = resolveTokenPath('business');
  const { clientId, clientSecret, redirectUri, port } = loadCredentials(credentialPath);

  if (fs.existsSync(tokenPath)) {
    const current = JSON.parse(fs.readFileSync(tokenPath, 'utf-8')) as { scope?: string };
    if (missingScopes(current.scope).length === 0) {
      console.log('\nThe business token already includes Gmail and Calendar read access. Nothing to do.\n');
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(path.dirname(tokenPath), `token.business.PRE_CALENDAR_${stamp}.json`);
    fs.copyFileSync(tokenPath, backup);
    fs.chmodSync(backup, 0o600);
    console.log(`[calendar:auth] Backed up ${path.basename(tokenPath)} to ${path.basename(backup)} (gitignored).`);
  }

  console.log('[calendar:auth] Requesting: Gmail (unchanged) + calendar.readonly. No Calendar write access is requested.');
  console.log('[calendar:auth] Sign in with the business account and keep every permission checked.');
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  await authenticateViaLoopback(client, port, tokenPath, 'business');

  const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf-8')) as { scope?: string };
  const missing = missingScopes(saved.scope);
  console.log(`[calendar:auth] Granted scopes: ${(saved.scope ?? '').split(' ').map((s) => s.replace('https://www.googleapis.com/auth/', '')).join(', ')}`);
  if (missing.length > 0 || !(saved.scope ?? '').includes(CALENDAR_READONLY_SCOPE)) {
    throw new Error('Calendar read access is still missing.');
  }
  console.log('\nDone. Verify with: npm run calendar:today\n');
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) return printHelp();
  if (command === 'auth') return handleAuth();

  const service = await CalendarService.fromBusinessAuth();
  const tz = service.timeZone;
  const now = new Date();
  const today = localDateOf(now, tz);
  console.log(`\nTimezone: ${tz} · Calendar: ${service.config.calendarId}`);

  switch (command) {
    case 'today':
    case 'upcoming': {
      const days = command === 'today' ? 1 : Math.max(1, Math.min(31, Number(rest[0]) || 7));
      const window: ResolvedWindow = {
        start: zonedToUtc(tz, today),
        end: zonedToUtc(tz, addDays(today, days)),
        label: command === 'today' ? 'today' : `in the next ${days} days`,
        day: command === 'today' ? today : null,
        hasTimeOfDay: false,
      };
      const events = await service.listEvents(window.start, window.end);
      for (const ev of events) console.log(eventLine(ev, tz));
      console.log(`\nSpoken: ${describeSchedule(events, window, tz, now)}\n`);
      return;
    }
    case 'next': {
      const ev = await service.nextEvent(now);
      if (ev) console.log(eventLine(ev, tz));
      console.log(`\nSpoken: ${describeNextEvent(ev, tz, now)}\n`);
      return;
    }
    case 'availability': {
      let window: ResolvedWindow | null;
      if (rest.length === 2 && rest.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(r))) {
        const toInstant = (r: string) => {
          if (/(Z|[+-]\d{2}:\d{2})$/.test(r)) return new Date(r);
          const [d, t] = r.split('T');
          const [y, m, day] = d.split('-').map(Number);
          const [hh, mm] = t.split(':').map(Number);
          return zonedToUtc(tz, { year: y, month: m, day }, hh, mm); // local wall time in PHRO_TIMEZONE
        };
        const start = toInstant(rest[0]);
        window = { start, end: toInstant(rest[1]), label: '', day: localDateOf(start, tz), hasTimeOfDay: true };
      } else {
        window = resolveTimePhrase(rest.join(' '), now, tz);
      }
      if (!window || window.end <= window.start) throw new Error('Give a start and end (ISO local times) or a phrase like "Saturday from 5 to 10".');
      const result = await service.availability(window.start, window.end);
      for (const b of result.busy) console.log(`  busy  ${b.start} - ${b.end}`);
      for (const f of result.free) console.log(`  free  ${f.start} - ${f.end}`);
      console.log(`\nSpoken: ${describeAvailability(result, window, tz, now)}\n`);
      return;
    }
    default:
      console.error(`Unknown calendar command: "${command}"`);
      printHelp();
      process.exit(1);
  }
}

if (process.argv[1]?.endsWith('calendar/cli.ts') || process.argv[1]?.endsWith('calendar/cli.js')) {
  main().catch((err) => {
    if (err instanceof CalendarError) {
      console.error(`\nCalendar error (${err.kind}): ${err.message}\nSpoken equivalent: ${spokenCalendarFailure(err.kind)}\n`);
    } else {
      console.error('\nCalendar CLI Error:', err instanceof Error ? err.message : err);
    }
    process.exit(1);
  });
}
