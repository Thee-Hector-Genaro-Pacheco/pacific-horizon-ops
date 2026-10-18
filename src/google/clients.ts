import fs from 'node:fs';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { loadCredentials, missingScopes, persistTokens, GMAIL_READONLY_SCOPE } from '../auth.js';
import {
  CAPABILITY_SCOPES,
  GoogleProfileError,
  loadGoogleProfiles,
  type GoogleCapability,
  type GoogleProfile,
  type GoogleProfileRegistry,
} from './profiles.js';

/**
 * Non-interactive, profile-scoped Google clients for reads.
 *
 * Never opens a browser (no token -> not_connected), never falls back to another
 * profile's token, verifies granted scopes and the expected account, and writes
 * refreshed tokens only to the requesting profile's own token file.
 */

export type IdentityResolver = (client: OAuth2Client, profile: GoogleProfile, grantedScope: string) => Promise<string>;

/** Gmail profile email when Gmail read is granted, otherwise the primary calendar's ID (its owner's email). */
export const defaultIdentityResolver: IdentityResolver = async (client, _profile, grantedScope) => {
  if (missingScopes(grantedScope, [GMAIL_READONLY_SCOPE]).length === 0) {
    const res = await google.gmail({ version: 'v1', auth: client }).users.getProfile({ userId: 'me' });
    return (res.data.emailAddress ?? '').trim().toLowerCase();
  }
  const res = await google.calendar({ version: 'v3', auth: client }).calendarList.get({ calendarId: 'primary' });
  return (res.data.id ?? '').trim().toLowerCase();
};

const verified = new Map<string, string>();

export interface ProfileClientOptions {
  registry?: GoogleProfileRegistry;
  resolveIdentity?: IdentityResolver;
}

export async function getProfileClient(
  profileId: string,
  capability: GoogleCapability,
  options: ProfileClientOptions = {}
): Promise<OAuth2Client> {
  const registry = options.registry ?? loadGoogleProfiles();
  const profile = registry.get(profileId);
  if (!profile.capabilities.includes(capability)) {
    throw new GoogleProfileError('capability', `Profile "${profileId}" is not enabled for ${capability}.`, profileId);
  }

  const tokenPath = registry.tokenPath(profile);
  if (!fs.existsSync(tokenPath)) {
    throw new GoogleProfileError('not_connected', `Profile "${profileId}" is not connected. Run: npm run google:auth -- ${profileId}`, profileId);
  }
  const { clientId, clientSecret, redirectUri } = loadCredentials(registry.credentialPath(profile));
  const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf-8')) as Record<string, unknown> & { scope?: string };

  const missing = missingScopes(tokens.scope, CAPABILITY_SCOPES[capability]);
  if (missing.length > 0) {
    throw new GoogleProfileError(
      'missing_scope',
      `Profile "${profileId}" has not granted ${missing.map((s) => s.split('/').pop()).join(', ')}. Run: npm run google:auth -- ${profileId}`,
      profileId
    );
  }

  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  client.setCredentials(tokens);

  let identityChecked = false;
  let pending: Record<string, unknown> | null = null;
  client.on('tokens', (fresh) => {
    if (identityChecked) persistTokens(fresh as Record<string, unknown>, tokenPath);
    else pending = { ...(pending ?? {}), ...fresh };
  });

  if (profile.expectedAccount) {
    const cacheKey = `${tokenPath}:${fs.statSync(tokenPath).mtimeMs}`;
    if (verified.get(cacheKey) !== profile.expectedAccount) {
      const actual = await (options.resolveIdentity ?? defaultIdentityResolver)(client, profile, tokens.scope ?? '');
      if (actual !== profile.expectedAccount) {
        throw new GoogleProfileError('account_mismatch', `Profile "${profileId}" is signed in to a different Google account than configured.`, profileId);
      }
      verified.set(cacheKey, actual);
    }
  }
  identityChecked = true;
  if (pending) persistTokens(pending, tokenPath);
  return client;
}

/** Test hook: forget cached identity verifications. */
export function clearVerifiedIdentityCache(): void {
  verified.clear();
}
