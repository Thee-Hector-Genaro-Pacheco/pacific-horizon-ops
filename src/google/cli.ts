import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { authenticateViaLoopback, loadCredentials, missingScopes } from '../auth.js';
import { GoogleProfileError, loadGoogleProfiles, maskAccount, scopesForProfile, type GoogleProfile } from './profiles.js';
import { inboxSourcesFromRegistry, readInboxes } from './gmailRead.js';

/**
 * Multi-account Google CLI. Never prints access or refresh tokens; account emails are masked.
 *
 *   npm run google:profiles
 *   npm run google:auth -- <profileId>
 *   npm run gmail:latest -- --profile <id> | --all
 */

const short = (scope: string) => scope.replace('https://www.googleapis.com/auth/', '');

function tokenScopes(tokenPath: string): string | null {
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return (JSON.parse(fs.readFileSync(tokenPath, 'utf-8')) as { scope?: string }).scope ?? '';
  } catch {
    return '';
  }
}

function listProfiles(): void {
  const registry = loadGoogleProfiles();
  console.log('\nGoogle profiles (registry: google-profiles.json, business is built in)\n');
  for (const p of registry.profiles) {
    const tokenPath = registry.tokenPath(p);
    const granted = tokenScopes(tokenPath);
    const required = scopesForProfile(p);
    const missing = granted === null ? required : missingScopes(granted, required);
    let creds = 'ok';
    try {
      registry.credentialPath(p);
    } catch {
      creds = `missing credentials.${p.oauthClient}.json`;
    }
    const connection = granted === null ? 'not connected' : missing.length ? `missing ${missing.map(short).join(', ')}` : 'connected';
    console.log(`  ${p.id.padEnd(12)} ${p.label}${p.enabled ? '' : ' (disabled)'}`);
    console.log(`    account:      ${maskAccount(p.expectedAccount)}`);
    console.log(`    capabilities: ${p.capabilities.join(', ')}`);
    console.log(`    scopes:       ${required.map(short).join(', ')}`);
    console.log(`    calendars:    ${p.calendars.map((c) => `${c.label}${c.privacy === 'busy_only' ? ' (busy only)' : ''}`).join(', ')}`);
    console.log(`    oauth client: ${p.oauthClient} (${creds})`);
    console.log(`    token:        ${path.basename(tokenPath)} · ${connection}\n`);
  }
}

function identityResolverFor(profile: GoogleProfile) {
  return async (client: OAuth2Client): Promise<string> => {
    if (profile.capabilities.includes('gmail.read')) {
      const res = await google.gmail({ version: 'v1', auth: client }).users.getProfile({ userId: 'me' });
      return (res.data.emailAddress ?? '').toLowerCase();
    }
    const res = await google.calendar({ version: 'v3', auth: client }).calendarList.get({ calendarId: 'primary' });
    return (res.data.id ?? '').toLowerCase();
  };
}

async function authProfile(profileId: string | undefined, force: boolean): Promise<void> {
  if (!profileId) throw new Error('Usage: npm run google:auth -- <profileId>');
  const registry = loadGoogleProfiles();
  const profile = registry.get(profileId); // unknown/disabled fail closed
  if (!profile.expectedAccount && profile.id !== 'business') {
    throw new GoogleProfileError('invalid_registry', `Profile "${profileId}" has no expectedAccount.`, profileId);
  }
  const credentialPath = registry.credentialPath(profile);
  const tokenPath = registry.tokenPath(profile);
  const scopes = scopesForProfile(profile);

  const current = tokenScopes(tokenPath);
  if (current !== null && missingScopes(current, scopes).length === 0 && !force) {
    console.log(`\nProfile "${profileId}" is already connected with ${scopes.map(short).join(', ')}. Use --force to re-consent.\n`);
    return;
  }
  if (current !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(path.dirname(tokenPath), `token.${profile.id}.PRE_AUTH_${stamp}.json`);
    fs.copyFileSync(tokenPath, backup);
    fs.chmodSync(backup, 0o600);
    console.log(`[google:auth] Backed up ${path.basename(tokenPath)} to ${path.basename(backup)} (gitignored).`);
  }

  const { clientId, clientSecret, redirectUri, port } = loadCredentials(credentialPath);
  console.log(`[google:auth] Profile: ${profile.id} (${profile.label}) · account ${maskAccount(profile.expectedAccount)}`);
  console.log(`[google:auth] Requesting only: ${scopes.map(short).join(', ')}`);
  console.log(`[google:auth] Token file: ${path.basename(tokenPath)} (other profiles' tokens are never touched)`);
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  await authenticateViaLoopback(client, port, tokenPath, profile.id, undefined, {
    scopes,
    expectedAccount: profile.expectedAccount,
    resolveIdentity: identityResolverFor(profile),
  });
  console.log(`\nConnected "${profileId}". Granted: ${(tokenScopes(tokenPath) ?? '').split(' ').map(short).join(', ')}`);
  console.log('Verify with: npm run google:profiles\n');
}

async function gmailLatest(args: string[]): Promise<void> {
  const all = args.includes('--all');
  const idx = args.indexOf('--profile');
  const selection = all ? 'all' : [idx >= 0 ? args[idx + 1] : 'business'];
  if (!all && !selection[0]) throw new Error('Usage: npm run gmail:latest -- --profile <id> | --all');
  const sources = inboxSourcesFromRegistry(selection);
  console.log(`\nInboxes queried: ${sources.map((s) => `${s.label} (${s.profileId})`).join(', ')}`);
  const agg = await readInboxes(sources, { max: 5 });
  for (const i of agg.items) {
    const when = new Date(i.internalDate).toLocaleString('en-US', { timeZone: process.env.PHRO_TIMEZONE || 'America/Los_Angeles' });
    console.log(`  [${i.profileLabel}] ${when}  ${i.senderName} · ${i.subject}${i.unread ? '  (unread)' : ''}`);
  }
  if (agg.items.length === 0) console.log('  (no recent messages)');
  for (const f of agg.failed) console.log(`  ! ${f.label}: could not read (${f.kind})`);
  console.log(`\nStatus: ${agg.status}\n`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'profiles':
      return listProfiles();
    case 'auth':
      return authProfile(rest.find((a) => !a.startsWith('--')), rest.includes('--force'));
    case 'gmail-latest':
      return gmailLatest(rest);
    default:
      console.log('Commands: profiles | auth <profileId> [--force] | gmail-latest --profile <id> | --all');
  }
}

if (process.argv[1]?.endsWith('google/cli.ts') || process.argv[1]?.endsWith('google/cli.js')) {
  main().catch((err) => {
    console.error(`\nGoogle CLI Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
