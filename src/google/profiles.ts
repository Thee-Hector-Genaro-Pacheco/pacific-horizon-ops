import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CALENDAR_READONLY_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  resolveCredentialPath,
  resolveTokenPath,
} from '../auth.js';

/**
 * Typed registry of Google accounts Pacific Ops may use.
 *
 * - `business` is built in: full Gmail (read/compose/modify) + Calendar read, unchanged
 *   from before. Its expected account comes from PHRO_GMAIL_BUSINESS_ACCOUNT.
 * - Every other profile must be listed explicitly in the local, gitignored
 *   google-profiles.json (see google-profiles.example.json), be enabled, and name its
 *   expected account. They default to read-only Gmail + Calendar.
 * - The registry holds no secrets. A token file existing never authorizes a profile:
 *   only an enabled registry entry does.
 */

export type GoogleCapability = 'gmail.read' | 'gmail.write' | 'calendar.read';
/** titles: speak sanitized event titles. busy_only: use busy time, say "<Label> event". */
export type CalendarPrivacy = 'titles' | 'busy_only';

export const CAPABILITY_SCOPES: Record<GoogleCapability, readonly string[]> = {
  'gmail.read': [GMAIL_READONLY_SCOPE],
  'gmail.write': [GMAIL_COMPOSE_SCOPE, GMAIL_MODIFY_SCOPE],
  'calendar.read': [CALENDAR_READONLY_SCOPE],
};

export const BUSINESS_FULL: readonly GoogleCapability[] = ['gmail.read', 'gmail.write', 'calendar.read'];
export const READ_ONLY: readonly GoogleCapability[] = ['gmail.read', 'calendar.read'];

export const BUSINESS_PROFILE_ID = 'business';
export const DEFAULT_REGISTRY_FILE = 'google-profiles.json';

export interface ProfileCalendar {
  /** Google Calendar ID. Internal only: never shown or spoken (group IDs look like emails). */
  id: string;
  /** Display-safe label, e.g. "Primary", "Bookings". */
  label: string;
  /** Title disclosure for this calendar. Availability always uses it regardless. */
  privacy: CalendarPrivacy;
}

export interface GoogleProfile {
  /** Stable internal identifier; also names the token file (token.<id>.json). */
  id: string;
  /** Display-safe label, e.g. "Personal". Never an email address. */
  label: string;
  /** Lowercased expected Google account. Required for every non-business profile. */
  expectedAccount: string | null;
  /** OAuth client: credentials.<oauthClient>.json ("business" also accepts legacy credentials.json). */
  oauthClient: string;
  capabilities: readonly GoogleCapability[];
  calendars: readonly ProfileCalendar[];
  enabled: boolean;
}

export type GoogleProfileErrorKind =
  | 'invalid_registry'
  | 'unknown_profile'
  | 'disabled'
  | 'capability'
  | 'not_connected'
  | 'missing_scope'
  | 'account_mismatch'
  | 'credentials_missing';

export class GoogleProfileError extends Error {
  readonly kind: GoogleProfileErrorKind;
  readonly profileId?: string;
  constructor(kind: GoogleProfileErrorKind, message: string, profileId?: string) {
    super(message);
    this.name = 'GoogleProfileError';
    this.kind = kind;
    this.profileId = profileId;
  }
}

const PROFILE_ID = /^[a-z][a-z0-9_-]{1,31}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ProfileEntrySchema = z
  .object({
    id: z.string().regex(PROFILE_ID, 'profile id must be lowercase letters, digits, "-" or "_" (2-32 chars)'),
    label: z.string().min(1).max(32).optional(),
    expectedAccount: z.string().regex(EMAIL, 'expectedAccount must be an email address').optional(),
    oauthClient: z.string().regex(PROFILE_ID).optional(),
    capabilities: z.array(z.enum(['gmail.read', 'gmail.write', 'calendar.read'])).min(1).optional(),
    calendars: z
      .array(
        z.union([
          z.string().min(1),
          z.object({ id: z.string().min(1), label: z.string().min(1).max(32).optional(), privacy: z.enum(['titles', 'busy_only']).optional() }).strict(),
        ])
      )
      .min(1)
      .optional(),
    /** Default title privacy for this profile's calendars. */
    calendarPrivacy: z.enum(['titles', 'busy_only']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const RegistryFileSchema = z.object({ profiles: z.array(ProfileEntrySchema) }).strict();

export interface RegistryOptions {
  baseDir?: string;
  env?: NodeJS.ProcessEnv;
}

function toCalendars(
  entries: z.infer<typeof ProfileEntrySchema>['calendars'],
  fallbackId: string,
  privacy: CalendarPrivacy
): ProfileCalendar[] {
  const list = entries ?? [fallbackId];
  const calendars = list.map((c, i) => {
    const id = typeof c === 'string' ? c : c.id;
    const label = (typeof c === 'string' ? undefined : c.label) ?? (id === 'primary' ? 'Primary' : `Calendar ${i + 1}`);
    return { id, label, privacy: (typeof c === 'string' ? undefined : c.privacy) ?? privacy };
  });
  if (new Set(calendars.map((c) => c.label.toLowerCase())).size !== calendars.length) {
    throw new GoogleProfileError('invalid_registry', 'Calendar labels must be unique within a profile.');
  }
  return calendars;
}

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ');
}

function envAccount(env: NodeJS.ProcessEnv, id: string): string | null {
  const key = id.toUpperCase().replace(/-/g, '_');
  const raw = env[`PHRO_GOOGLE_${key}_ACCOUNT`] ?? env[`PHRO_GMAIL_${key}_ACCOUNT`];
  const trimmed = raw?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export class GoogleProfileRegistry {
  constructor(
    readonly profiles: readonly GoogleProfile[],
    private readonly baseDir: string
  ) {}

  /** Fails closed on unknown or disabled profile IDs. */
  get(id: string): GoogleProfile {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) throw new GoogleProfileError('unknown_profile', `Google profile "${id}" is not configured.`, id);
    if (!profile.enabled) throw new GoogleProfileError('disabled', `Google profile "${id}" is disabled.`, id);
    return profile;
  }

  has(id: string): boolean {
    return this.profiles.some((p) => p.id === id && p.enabled);
  }

  /** Enabled profiles with a capability, business first. */
  withCapability(capability: GoogleCapability): GoogleProfile[] {
    return this.profiles.filter((p) => p.enabled && p.capabilities.includes(capability));
  }

  tokenPath(profile: GoogleProfile): string {
    return profile.id === BUSINESS_PROFILE_ID
      ? resolveTokenPath('business', this.baseDir).tokenPath
      : path.resolve(this.baseDir, `token.${profile.id}.json`);
  }

  /** Throws credentials_missing if the profile's OAuth client file does not exist. */
  credentialPath(profile: GoogleProfile): string {
    if (profile.oauthClient === BUSINESS_PROFILE_ID) {
      try {
        return resolveCredentialPath('business', this.baseDir).credentialPath;
      } catch (err) {
        throw new GoogleProfileError('credentials_missing', (err as Error).message, profile.id);
      }
    }
    const file = path.resolve(this.baseDir, `credentials.${profile.oauthClient}.json`);
    if (!fs.existsSync(file)) {
      throw new GoogleProfileError(
        'credentials_missing',
        `OAuth client file credentials.${profile.oauthClient}.json not found for profile "${profile.id}".`,
        profile.id
      );
    }
    return file;
  }
}

/** Scopes a profile requests and requires, from its capabilities only. */
export function scopesForProfile(profile: Pick<GoogleProfile, 'capabilities'>): string[] {
  return [...new Set(profile.capabilities.flatMap((c) => CAPABILITY_SCOPES[c]))];
}

export function loadGoogleProfiles(options: RegistryOptions = {}): GoogleProfileRegistry {
  const baseDir = options.baseDir ?? process.cwd();
  const env = options.env ?? process.env;
  const file = path.resolve(baseDir, env.PHRO_GOOGLE_PROFILES_FILE?.trim() || DEFAULT_REGISTRY_FILE);

  const business: GoogleProfile = {
    id: BUSINESS_PROFILE_ID,
    label: 'Business',
    expectedAccount: envAccount(env, BUSINESS_PROFILE_ID),
    oauthClient: BUSINESS_PROFILE_ID,
    capabilities: BUSINESS_FULL,
    calendars: toCalendars(undefined, env.PHRO_CALENDAR_ID?.trim() || 'primary', 'titles'),
    enabled: true,
  };

  if (!fs.existsSync(file)) return new GoogleProfileRegistry([business], baseDir);

  let parsed: z.infer<typeof RegistryFileSchema>;
  try {
    parsed = RegistryFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (err) {
    const detail = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message;
    throw new GoogleProfileError('invalid_registry', `${path.basename(file)} is invalid: ${detail}`);
  }

  const profiles: GoogleProfile[] = [business];
  const seen = new Set<string>();
  for (const entry of parsed.profiles) {
    if (seen.has(entry.id)) throw new GoogleProfileError('invalid_registry', `Duplicate profile id "${entry.id}".`, entry.id);
    seen.add(entry.id);

    if (entry.id === BUSINESS_PROFILE_ID) {
      // Business keeps its scopes and OAuth client; only display/calendar settings may change.
      if (entry.capabilities || entry.oauthClient || entry.enabled === false) {
        throw new GoogleProfileError(
          'invalid_registry',
          'The business profile\'s capabilities, OAuth client and enablement are fixed; only label, expectedAccount, calendars and calendarPrivacy may be set.',
          entry.id
        );
      }
      profiles[0] = {
        ...business,
        label: entry.label ?? business.label,
        expectedAccount: entry.expectedAccount?.toLowerCase() ?? business.expectedAccount,
        calendars: toCalendars(entry.calendars, business.calendars[0].id, entry.calendarPrivacy ?? 'titles'),
      };
      continue;
    }

    const capabilities = entry.capabilities ?? READ_ONLY;
    if (capabilities.includes('gmail.write')) {
      throw new GoogleProfileError(
        'invalid_registry',
        `Profile "${entry.id}" requests gmail.write. Only the business profile can draft or send in this version.`,
        entry.id
      );
    }
    const expectedAccount = entry.expectedAccount?.toLowerCase() ?? envAccount(env, entry.id);
    if (!expectedAccount) {
      throw new GoogleProfileError(
        'invalid_registry',
        `Profile "${entry.id}" needs an expectedAccount (in ${path.basename(file)} or PHRO_GOOGLE_${entry.id.toUpperCase()}_ACCOUNT).`,
        entry.id
      );
    }
    profiles.push({
      id: entry.id,
      label: entry.label ?? titleCase(entry.id),
      expectedAccount,
      oauthClient: entry.oauthClient ?? entry.id,
      capabilities: [...new Set(capabilities)],
      calendars: toCalendars(entry.calendars, 'primary', entry.calendarPrivacy ?? 'titles'),
      enabled: entry.enabled ?? true,
    });
  }

  const labels = new Set<string>();
  for (const p of profiles) {
    const l = p.label.toLowerCase();
    if (labels.has(l)) throw new GoogleProfileError('invalid_registry', `Duplicate profile label "${p.label}".`, p.id);
    labels.add(l);
  }
  return new GoogleProfileRegistry(profiles, baseDir);
}

/** "h***@gmail.com" for CLI display. */
export function maskAccount(email: string | null): string {
  if (!email) return '(not set)';
  const [user, domain] = email.split('@');
  return `${user.charAt(0)}***@${domain}`;
}
