import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { exec } from 'node:child_process';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

const CREDENTIALS_PATH = path.resolve(process.cwd(), 'credentials.json');
const LEGACY_TOKEN_PATH = path.resolve(process.cwd(), 'token.json');

export const VALID_PROFILES = ['business', 'personal'] as const;
export type GmailProfile = (typeof VALID_PROFILES)[number];

export interface CredentialResolution {
  profile: GmailProfile;
  credentialPath: string;
  isFallback: boolean;
}

export interface TokenResolution {
  profile: GmailProfile;
  tokenPath: string;
  isFallback: boolean;
}

/**
 * Resolves the active Gmail profile from environment or parameter,
 * validating profile names strictly against allowed values.
 */
export function getActiveProfile(profileInput?: string): GmailProfile {
  const raw = profileInput ?? process.env.PHRO_GMAIL_PROFILE ?? 'business';
  const sanitized = raw.trim().toLowerCase();

  if (!sanitized || !(VALID_PROFILES as readonly string[]).includes(sanitized)) {
    throw new Error(
      `Invalid Gmail profile "${raw}". Valid profiles are: ${VALID_PROFILES.join(', ')}.`
    );
  }

  return sanitized as GmailProfile;
}

/**
 * Resolves the OAuth client credentials file path for the active profile:
 * - business -> credentials.business.json (falls back to legacy credentials.json if credentials.business.json does not exist)
 * - personal -> credentials.personal.json (strictly isolated; never falls back to business/legacy credentials)
 */
export function resolveCredentialPath(profileInput?: string, baseDir: string = process.cwd()): CredentialResolution {
  const profile = getActiveProfile(profileInput);

  if (profile === 'personal') {
    const personalPath = path.resolve(baseDir, 'credentials.personal.json');
    if (!fs.existsSync(personalPath)) {
      throw new Error(
        `OAuth credentials file for profile "personal" not found at credentials.personal.json.\n` +
        `Personal Gmail accounts cannot use the business Internal OAuth client.\n` +
        `Please create an OAuth 2.0 Desktop Client in a Google Cloud project configured for an External audience, ` +
        `download the credentials JSON, and save it as credentials.personal.json in the project root.`
      );
    }
    return {
      profile: 'personal',
      credentialPath: personalPath,
      isFallback: false,
    };
  }

  // Profile: business
  const businessPath = path.resolve(baseDir, 'credentials.business.json');
  if (fs.existsSync(businessPath)) {
    return {
      profile: 'business',
      credentialPath: businessPath,
      isFallback: false,
    };
  }

  const legacyCredentialsPath = path.resolve(baseDir, 'credentials.json');
  if (fs.existsSync(legacyCredentialsPath)) {
    return {
      profile: 'business',
      credentialPath: legacyCredentialsPath,
      isFallback: true,
    };
  }

  throw new Error(
    `OAuth credentials file for profile "business" not found (checked credentials.business.json and credentials.json).\n` +
    `Please download your OAuth 2.0 Client ID (Desktop app) credentials from Google Cloud Console ` +
    `and save them as credentials.business.json (or credentials.json) in the project root.`
  );
}

/**
 * Resolves the token file path for the active profile:
 * - business -> token.business.json (falls back to legacy token.json if token.business.json does not exist)
 * - personal -> token.personal.json
 */
export function resolveTokenPath(profileInput?: string, baseDir: string = process.cwd()): TokenResolution {
  const profile = getActiveProfile(profileInput);

  if (profile === 'personal') {
    return {
      profile: 'personal',
      tokenPath: path.resolve(baseDir, 'token.personal.json'),
      isFallback: false,
    };
  }

  // Profile: business
  const businessPath = path.resolve(baseDir, 'token.business.json');
  if (fs.existsSync(businessPath)) {
    return {
      profile: 'business',
      tokenPath: businessPath,
      isFallback: false,
    };
  }

  const legacyTokenPath = path.resolve(baseDir, 'token.json');
  // Fallback to legacy token.json only for business profile if token.business.json does not exist
  if (fs.existsSync(legacyTokenPath)) {
    return {
      profile: 'business',
      tokenPath: legacyTokenPath,
      isFallback: true,
    };
  }

  // Default to token.business.json if neither exists yet
  return {
    profile: 'business',
    tokenPath: businessPath,
    isFallback: false,
  };
}

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
];

export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

/**
 * Checks if the authenticated OAuth2Client has been granted a specific scope.
 */
export function hasScope(auth: OAuth2Client, requiredScope: string): boolean {
  const granted = auth.credentials?.scope;
  if (!granted) return false;
  const scopes = granted.split(' ');
  return scopes.includes(requiredScope);
}

interface CredentialsFile {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
}

/**
 * Loads OAuth credentials from the specified credentials file path
 */
export function loadCredentials(credentialPath?: string): { clientId: string; clientSecret: string; redirectUri: string; port: number } {
  const resolvedPath = credentialPath ?? path.resolve(process.cwd(), 'credentials.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `credentials file not found at ${path.basename(resolvedPath)}.\n` +
      'Please download your OAuth 2.0 Client ID (Desktop app) credentials from Google Cloud Console ' +
      `and save them as ${path.basename(resolvedPath)} in the project root.`
    );
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = JSON.parse(raw) as CredentialsFile;
  const config = parsed.installed || parsed.web;

  if (!config || !config.client_id || !config.client_secret) {
    throw new Error(`${path.basename(resolvedPath)} is invalid. Expected "installed" or "web" client config with client_id and client_secret.`);
  }

  let port = 3000;
  let redirectUri = `http://localhost:${port}`;

  if (config.redirect_uris && config.redirect_uris.length > 0) {
    const matchingUri = config.redirect_uris.find(
      (uri) => uri.includes('localhost') || uri.includes('127.0.0.1')
    );
    if (matchingUri) {
      try {
        const parsedUrl = new URL(matchingUri);
        if (parsedUrl.port) {
          port = Number.parseInt(parsedUrl.port, 10);
          redirectUri = matchingUri;
        } else {
          redirectUri = `${parsedUrl.protocol}//${parsedUrl.hostname}:${port}`;
        }
      } catch {
        // Fall back to default localhost:3000
      }
    }
  }

  return {
    clientId: config.client_id,
    clientSecret: config.client_secret,
    redirectUri,
    port,
  };
}

/**
 * Saves or updates tokens in the resolved profile token file with 0600 permissions
 */
export function persistTokens(tokens: Record<string, unknown>, targetTokenPath: string): void {
  let existingTokens: Record<string, unknown> = {};
  if (fs.existsSync(targetTokenPath)) {
    try {
      existingTokens = JSON.parse(fs.readFileSync(targetTokenPath, 'utf-8'));
    } catch {
      existingTokens = {};
    }
  }
  const merged = { ...existingTokens, ...tokens };
  fs.writeFileSync(targetTokenPath, JSON.stringify(merged, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(targetTokenPath, 0o600);
  } catch {
    // Ignore on filesystems without POSIX permissions
  }
}

/**
 * Resolves the expected Gmail account email for the specified profile from environment variables.
 * Returns undefined if not configured.
 */
export function getExpectedAccount(profile: GmailProfile): string | undefined {
  const envVar =
    profile === 'business'
      ? process.env.PHRO_GMAIL_BUSINESS_ACCOUNT
      : process.env.PHRO_GMAIL_PERSONAL_ACCOUNT;

  const trimmed = envVar?.trim();
  return trimmed || undefined;
}

/**
 * Retrieves the normalized authenticated email address for an OAuth2Client using Gmail API.
 */
export async function getAuthenticatedEmail(auth: OAuth2Client): Promise<string> {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.getProfile({ userId: 'me' });
  const email = res.data.emailAddress?.trim().toLowerCase();
  if (!email) {
    throw new Error('Failed to retrieve emailAddress from Gmail user profile.');
  }
  return email;
}

/**
 * Verifies that the authenticated Gmail identity matches the expected account for the profile, if configured.
 * Throws a safe error and does not mutate tokens if there is a mismatch.
 */
export async function verifyProfileAccountBinding(
  auth: OAuth2Client,
  profile: GmailProfile
): Promise<string> {
  const authenticatedEmail = await getAuthenticatedEmail(auth);
  const expected = getExpectedAccount(profile);

  if (expected && authenticatedEmail.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Authenticated Gmail account does not match the configured account for profile ${profile}.`
    );
  }

  return authenticatedEmail;
}

/**
 * Generates the OAuth authorization URL forcing account selection and consent.
 */
export function generateAuthorizationUrl(oauth2Client: OAuth2Client): string {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account consent',
  });
}

/**
 * Starts a temporary local loopback server to capture OAuth authorization code
 */
export async function authenticateViaLoopback(
  oauth2Client: OAuth2Client,
  port: number,
  targetTokenPath: string,
  profile: GmailProfile,
  onValidated?: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url) return;
        const requestUrl = new URL(req.url, `http://localhost:${port}`);
        const code = requestUrl.searchParams.get('code');
        const error = requestUrl.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authentication Failed</h1><p>${error}</p>`);
          server.close();
          reject(new Error(`OAuth authentication failed: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; padding-top: 60px;">' +
            '<h1 style="color: #10b981;">Authentication Successful!</h1>' +
            `<p style="color: #374151; font-size: 16px;">Pacific Rising Ops is now authorized for profile <strong>${profile}</strong>.</p>` +
            '<p style="color: #6b7280; font-size: 14px;">You may safely close this tab and return to your terminal.</p>' +
            '</body></html>'
          );

          server.close();

          console.log(`[auth] Exchanging authorization code for tokens (profile: ${profile})...`);
          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);

          // Verify authenticated identity against configured expected account BEFORE persisting!
          const expected = getExpectedAccount(profile);
          if (expected) {
            const authenticatedEmail = await getAuthenticatedEmail(oauth2Client);
            if (authenticatedEmail.toLowerCase() !== expected.toLowerCase()) {
              throw new Error(
                `Authenticated Gmail account does not match the configured account for profile ${profile}.`
              );
            }
            console.log(`[auth] Authenticated Gmail identity verified: ${authenticatedEmail}`);
          } else {
            console.log(
              `[auth] Note: Expected-account enforcement is not configured for profile "${profile}". Set PHRO_GMAIL_${profile.toUpperCase()}_ACCOUNT in .env to enforce.`
            );
          }

          if (onValidated) {
            onValidated();
          }

          persistTokens(tokens as Record<string, unknown>, targetTokenPath);
          console.log(`[auth] Tokens successfully saved to ${path.basename(targetTokenPath)}`);
          resolve();
        }
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      const authUrl = generateAuthorizationUrl(oauth2Client);

      console.log(`\n--- Gmail Authorization for Profile: "${profile}" ---`);
      console.log('Opening your browser for OAuth consent...');
      console.log(`If your browser does not open automatically, visit this URL:\n${authUrl}\n`);

      const openCommand =
        process.platform === 'darwin'
          ? `open "${authUrl}"`
          : process.platform === 'win32'
          ? `start "" "${authUrl}"`
          : `xdg-open "${authUrl}"`;

      exec(openCommand, (execErr) => {
        if (execErr) {
          console.warn('Could not launch browser automatically. Please open the URL manually.');
        }
      });
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Retrieves an authenticated Google OAuth2 client for the selected profile,
 * refreshing or prompting for login as needed.
 */
export async function getAuthenticatedClient(
  profileOverride?: string,
  baseDir: string = process.cwd()
): Promise<OAuth2Client> {
  const { profile, credentialPath, isFallback: isCredFallback } = resolveCredentialPath(profileOverride, baseDir);
  const { tokenPath, isFallback: isTokenFallback } = resolveTokenPath(profileOverride, baseDir);
  const { clientId, clientSecret, redirectUri, port } = loadCredentials(credentialPath);

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  console.log(`[auth] Active Gmail profile: ${profile}`);
  console.log(
    `[auth] Credential file: ${path.basename(credentialPath)}${
      isCredFallback ? ' (legacy fallback)' : ''
    }`
  );
  console.log(
    `[auth] Token file: ${path.basename(tokenPath)}${
      isTokenFallback ? ' (legacy fallback)' : ''
    }`
  );

  let bindingValidated = false;
  let pendingRefreshedTokens: Record<string, unknown> | null = null;

  // Safe refresh listener: Never write to disk until profile binding is validated!
  oauth2Client.on('tokens', (tokens) => {
    if (bindingValidated) {
      console.log(`[auth] OAuth token refreshed for profile "${profile}". Updating ${path.basename(tokenPath)}...`);
      persistTokens(tokens as Record<string, unknown>, tokenPath);
    } else {
      // Stage in memory ONLY. Never touch disk before validation!
      pendingRefreshedTokens = { ...(pendingRefreshedTokens || {}), ...tokens };
    }
  });

  if (fs.existsSync(tokenPath)) {
    try {
      const rawTokens = fs.readFileSync(tokenPath, 'utf-8');
      const tokens = JSON.parse(rawTokens);
      oauth2Client.setCredentials(tokens);

      // Verify authenticated identity against configured expected account BEFORE trusting existing tokens!
      const expected = getExpectedAccount(profile);
      if (expected) {
        const authenticatedEmail = await getAuthenticatedEmail(oauth2Client);
        if (authenticatedEmail.toLowerCase() !== expected.toLowerCase()) {
          throw new Error(
            `Authenticated Gmail account does not match the configured account for profile ${profile}.`
          );
        }
        console.log(`[auth] Authenticated Gmail identity verified: ${authenticatedEmail}`);
      } else {
        console.log(
          `[auth] Note: Expected-account enforcement is not configured for profile "${profile}". Set PHRO_GMAIL_${profile.toUpperCase()}_ACCOUNT in .env to enforce.`
        );
      }

      bindingValidated = true;

      // If tokens refreshed during getAuthenticatedEmail, persist the latest tokens
      if (pendingRefreshedTokens) {
        console.log(`[auth] OAuth token refreshed for profile "${profile}". Updating ${path.basename(tokenPath)}...`);
        persistTokens(pendingRefreshedTokens, tokenPath);
        pendingRefreshedTokens = null;
      }

      return oauth2Client;
    } catch (err) {
      if (err instanceof Error && err.message.includes('does not match the configured account for profile')) {
        // Identity mismatch on existing tokens must throw immediately, NOT silently start new OAuth or overwrite!
        throw err;
      }
      console.warn(
        `[auth] Token file ${path.basename(tokenPath)} is corrupt or unreadable. Initiating new OAuth flow...`
      );
    }
  }

  // First run for this profile: execute loopback auth flow
  await authenticateViaLoopback(oauth2Client, port, tokenPath, profile, () => {
    bindingValidated = true;
  });

  if (pendingRefreshedTokens) {
    persistTokens(pendingRefreshedTokens, tokenPath);
    pendingRefreshedTokens = null;
  }

  return oauth2Client;
}
