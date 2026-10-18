import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import {
  SCOPES,
  CALENDAR_READONLY_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_MODIFY_SCOPE,
  assertConsentGrantedAllScopes,
  generateAuthorizationUrl,
  describeLoopbackError,
} from '../src/auth.js';
import { loadGoogleProfiles, scopesForProfile, GoogleProfileError, maskAccount } from '../src/google/profiles.js';
import { getProfileClient, clearVerifiedIdentityCache } from '../src/google/clients.js';

const CREDS = JSON.stringify({ installed: { client_id: 'cid', client_secret: 'csecret', redirect_uris: ['http://localhost:3000'] } });

function writeToken(dir: string, file: string, scopes: string[], access = `access_${file}`) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ access_token: access, refresh_token: `refresh_${file}`, scope: scopes.join(' '), token_type: 'Bearer', expiry_date: Date.now() + 3_600_000 }));
}

describe('Google profile registry', () => {
  let dir: string;
  const env = (extra: Record<string, string> = {}) => ({ PHRO_GMAIL_BUSINESS_ACCOUNT: 'owner@business.example', ...extra });
  const registryFile = (profiles: unknown[]) => fs.writeFileSync(path.join(dir, 'google-profiles.json'), JSON.stringify({ profiles }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-gprof-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('1. the business profile loads with no registry file, unchanged from before', () => {
    const r = loadGoogleProfiles({ baseDir: dir, env: env() });
    assert.equal(r.profiles.length, 1);
    const b = r.get('business');
    assert.deepEqual(b.capabilities, ['gmail.read', 'gmail.write', 'calendar.read']);
    assert.equal(b.expectedAccount, 'owner@business.example');
    assert.deepEqual(scopesForProfile(b), SCOPES, 'business still requires exactly its current four scopes');
  });

  it('2. an arbitrary second profile can be registered; read-only by default', () => {
    registryFile([{ id: 'school', expectedAccount: 'Me@School.edu', oauthClient: 'personal', calendars: [{ id: 'primary' }, { id: 'abc123@group.calendar.google.com', label: 'WGU' }] }]);
    const r = loadGoogleProfiles({ baseDir: dir, env: env() });
    const s = r.get('school');
    assert.equal(s.label, 'School');
    assert.equal(s.expectedAccount, 'me@school.edu');
    assert.deepEqual(s.capabilities, ['gmail.read', 'calendar.read']);
    assert.deepEqual(s.calendars.map((c) => c.label), ['Primary', 'WGU']);
  });

  it('7-8. business keeps compose/modify; read-only profiles never request them', () => {
    registryFile([{ id: 'personal', expectedAccount: 'me@gmail.example' }]);
    const r = loadGoogleProfiles({ baseDir: dir, env: env() });
    assert.ok(scopesForProfile(r.get('business')).includes(GMAIL_COMPOSE_SCOPE));
    assert.ok(scopesForProfile(r.get('business')).includes(GMAIL_MODIFY_SCOPE));
    assert.deepEqual(scopesForProfile(r.get('personal')), [GMAIL_READONLY_SCOPE, CALENDAR_READONLY_SCOPE]);
    const url = new URL(generateAuthorizationUrl(new google.auth.OAuth2('id', 's', 'http://localhost:3000'), scopesForProfile(r.get('personal'))));
    const requested = url.searchParams.get('scope')!;
    assert.ok(!requested.includes('gmail.compose') && !requested.includes('gmail.modify'));
  });

  it('rejects write capability for non-business profiles and any change to business capabilities', () => {
    registryFile([{ id: 'personal', expectedAccount: 'me@gmail.example', capabilities: ['gmail.read', 'gmail.write'] }]);
    assert.throws(() => loadGoogleProfiles({ baseDir: dir, env: env() }), (e: unknown) => e instanceof GoogleProfileError && e.kind === 'invalid_registry');
    registryFile([{ id: 'business', capabilities: ['gmail.read'] }]);
    assert.throws(() => loadGoogleProfiles({ baseDir: dir, env: env() }), /fixed/);
  });

  it('requires an expected account for every non-business profile, and rejects malformed entries', () => {
    registryFile([{ id: 'personal' }]);
    assert.throws(() => loadGoogleProfiles({ baseDir: dir, env: env() }), /expectedAccount/);
    assert.equal(loadGoogleProfiles({ baseDir: dir, env: env({ PHRO_GOOGLE_PERSONAL_ACCOUNT: 'me@gmail.example' }) }).get('personal').expectedAccount, 'me@gmail.example');
    registryFile([{ id: 'Bad Id!', expectedAccount: 'x@y.z' }]);
    assert.throws(() => loadGoogleProfiles({ baseDir: dir, env: env() }), (e: unknown) => e instanceof GoogleProfileError && e.kind === 'invalid_registry');
    registryFile([{ id: 'personal', expectedAccount: 'x@y.z', password: 'nope' }]);
    assert.throws(() => loadGoogleProfiles({ baseDir: dir, env: env() }), /invalid/, 'unknown keys (e.g. secrets) are rejected');
  });

  it('9. unknown and disabled profiles fail closed', () => {
    registryFile([{ id: 'school', expectedAccount: 'me@school.edu', enabled: false }]);
    const r = loadGoogleProfiles({ baseDir: dir, env: env() });
    assert.throws(() => r.get('personal'), (e: unknown) => e instanceof GoogleProfileError && e.kind === 'unknown_profile');
    assert.throws(() => r.get('school'), (e: unknown) => e instanceof GoogleProfileError && e.kind === 'disabled');
    assert.deepEqual(r.withCapability('calendar.read').map((p) => p.id), ['business']);
  });

  it('3. token paths are separate per profile and never collide', () => {
    registryFile([{ id: 'personal', expectedAccount: 'me@gmail.example' }, { id: 'school', expectedAccount: 'me@school.edu' }]);
    const r = loadGoogleProfiles({ baseDir: dir, env: env() });
    const paths = r.profiles.map((p) => path.basename(r.tokenPath(p)));
    assert.deepEqual(paths, ['token.business.json', 'token.personal.json', 'token.school.json']);
    assert.equal(new Set(paths).size, 3);
  });

  it('masks accounts for display', () => {
    assert.equal(maskAccount('hector@example.com'), 'h***@example.com');
  });
});

describe('Profile-scoped Google clients', () => {
  let dir: string;
  let registry: ReturnType<typeof loadGoogleProfiles>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-gclient-'));
    fs.writeFileSync(path.join(dir, 'credentials.business.json'), CREDS);
    fs.writeFileSync(path.join(dir, 'credentials.personal.json'), CREDS);
    fs.writeFileSync(
      path.join(dir, 'google-profiles.json'),
      JSON.stringify({ profiles: [{ id: 'personal', expectedAccount: 'me@gmail.example', oauthClient: 'personal' }, { id: 'calonly', expectedAccount: 'c@x.example', oauthClient: 'personal', capabilities: ['calendar.read'] }] })
    );
    registry = loadGoogleProfiles({ baseDir: dir, env: { PHRO_GMAIL_BUSINESS_ACCOUNT: 'owner@business.example' } });
    writeToken(dir, 'token.business.json', SCOPES);
    writeToken(dir, 'token.personal.json', [GMAIL_READONLY_SCOPE, CALENDAR_READONLY_SCOPE]);
    clearVerifiedIdentityCache();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const identity = (map: Record<string, string>) => async (_c: unknown, p: { id: string }) => map[p.id];
  const ok = identity({ business: 'owner@business.example', personal: 'me@gmail.example' });

  it('10-11. Gmail and Calendar clients use the requested profile\'s own token', async () => {
    const personalGmail = await getProfileClient('personal', 'gmail.read', { registry, resolveIdentity: ok });
    assert.equal(personalGmail.credentials.access_token, 'access_token.personal.json');
    const personalCal = await getProfileClient('personal', 'calendar.read', { registry, resolveIdentity: ok });
    assert.equal(personalCal.credentials.access_token, 'access_token.personal.json');
    const businessCal = await getProfileClient('business', 'calendar.read', { registry, resolveIdentity: ok });
    assert.equal(businessCal.credentials.access_token, 'access_token.business.json');
  });

  it('never falls back to another profile\'s token', async () => {
    fs.rmSync(path.join(dir, 'token.personal.json'));
    await assert.rejects(getProfileClient('personal', 'calendar.read', { registry, resolveIdentity: ok }), (e: unknown) => e instanceof GoogleProfileError && e.kind === 'not_connected');
  });

  it('5. expected-account mismatch fails closed', async () => {
    await assert.rejects(
      getProfileClient('personal', 'gmail.read', { registry, resolveIdentity: identity({ personal: 'owner@business.example' }) }),
      (e: unknown) => e instanceof GoogleProfileError && e.kind === 'account_mismatch'
    );
  });

  it('missing scopes and missing capabilities fail closed', async () => {
    writeToken(dir, 'token.personal.json', [GMAIL_READONLY_SCOPE]);
    await assert.rejects(getProfileClient('personal', 'calendar.read', { registry, resolveIdentity: ok }), (e: unknown) => e instanceof GoogleProfileError && e.kind === 'missing_scope');
    await assert.rejects(getProfileClient('personal', 'gmail.write', { registry, resolveIdentity: ok }), (e: unknown) => e instanceof GoogleProfileError && e.kind === 'capability');
    await assert.rejects(getProfileClient('calonly', 'gmail.read', { registry, resolveIdentity: ok }), (e: unknown) => e instanceof GoogleProfileError && e.kind === 'capability');
    await assert.rejects(getProfileClient('school', 'calendar.read', { registry, resolveIdentity: ok }), (e: unknown) => e instanceof GoogleProfileError && e.kind === 'unknown_profile');
  });

  it('a token file alone never authorizes an unregistered profile', async () => {
    writeToken(dir, 'token.rogue.json', [GMAIL_READONLY_SCOPE, CALENDAR_READONLY_SCOPE]);
    await assert.rejects(getProfileClient('rogue', 'gmail.read', { registry, resolveIdentity: ok }), (e: unknown) => e instanceof GoogleProfileError && e.kind === 'unknown_profile');
  });

  it('4. refreshed tokens are written only to the requesting profile\'s file', async () => {
    const businessBefore = fs.readFileSync(path.join(dir, 'token.business.json'), 'utf-8');
    const client = await getProfileClient('personal', 'gmail.read', { registry, resolveIdentity: ok });
    client.emit('tokens', { access_token: 'refreshed_personal' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'token.personal.json'), 'utf-8')).access_token, 'refreshed_personal');
    assert.equal(fs.readFileSync(path.join(dir, 'token.business.json'), 'utf-8'), businessBefore);
  });

  it('6. partial consent is refused per profile, before any token is written', () => {
    const personal = scopesForProfile(registry.get('personal'));
    assert.throws(() => assertConsentGrantedAllScopes(GMAIL_READONLY_SCOPE, 'token.personal.json', personal), /calendar\.readonly.*token\.personal\.json was left unchanged/);
    assert.doesNotThrow(() => assertConsentGrantedAllScopes(personal.join(' '), 'token.personal.json', personal));
    // Business still demands its full set.
    assert.throws(() => assertConsentGrantedAllScopes(personal.join(' '), 'token.business.json'), /gmail\.compose/);
  });

  it('a busy OAuth callback port gives a clear, actionable error', () => {
    // Unit-level on purpose: tests never start the real loopback flow (it would open a browser).
    const err = describeLoopbackError(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }), 3000);
    assert.match(err.message, /OAuth callback port 3000 is already in use/);
    assert.match(err.message, /No token was changed/);
    const other = new Error('boom');
    assert.equal(describeLoopbackError(other, 3000), other);
  });
});
