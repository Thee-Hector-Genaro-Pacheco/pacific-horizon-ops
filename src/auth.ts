import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { exec } from 'node:child_process';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

const CREDENTIALS_PATH = path.resolve(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.resolve(process.cwd(), 'token.json');

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

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
 * Loads OAuth credentials from credentials.json
 */
function loadCredentials(): { clientId: string; clientSecret: string; redirectUri: string; port: number } {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found at ${CREDENTIALS_PATH}.\n` +
      'Please download your OAuth 2.0 Client ID (Desktop app) credentials from Google Cloud Console ' +
      'and save them as credentials.json in the project root.'
    );
  }

  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as CredentialsFile;
  const config = parsed.installed || parsed.web;

  if (!config || !config.client_id || !config.client_secret) {
    throw new Error('credentials.json is invalid. Expected "installed" or "web" client config with client_id and client_secret.');
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
 * Saves or updates tokens in token.json
 */
function persistTokens(tokens: Record<string, unknown>): void {
  let existingTokens: Record<string, unknown> = {};
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      existingTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    } catch {
      existingTokens = {};
    }
  }
  const merged = { ...existingTokens, ...tokens };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2), 'utf-8');
}

/**
 * Starts a temporary local loopback server to capture OAuth authorization code
 */
async function authenticateViaLoopback(
  oauth2Client: OAuth2Client,
  port: number
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
            '<p style="color: #374151; font-size: 16px;">Pacific Rising Ops is now authorized to access Gmail.</p>' +
            '<p style="color: #6b7280; font-size: 14px;">You may safely close this tab and return to your terminal.</p>' +
            '</body></html>'
          );

          server.close();

          console.log('Exchanging authorization code for tokens...');
          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);
          persistTokens(tokens as Record<string, unknown>);
          console.log(`OAuth tokens successfully saved to ${TOKEN_PATH}`);
          resolve();
        }
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
      });

      console.log('\n--- Google Workspace Gmail Authorization ---');
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
 * Retrieves an authenticated Google OAuth2 client, refreshing or prompting for login as needed.
 */
export async function getAuthenticatedClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret, redirectUri, port } = loadCredentials();

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // Automatically persist refreshed tokens
  oauth2Client.on('tokens', (tokens) => {
    console.log('OAuth access token refreshed. Updating token.json...');
    persistTokens(tokens as Record<string, unknown>);
  });

  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const rawTokens = fs.readFileSync(TOKEN_PATH, 'utf-8');
      const tokens = JSON.parse(rawTokens);
      oauth2Client.setCredentials(tokens);
      return oauth2Client;
    } catch (err) {
      console.warn('Existing token.json is corrupt or unreadable. Initiating new OAuth flow...');
    }
  }

  // First run: execute loopback auth flow
  await authenticateViaLoopback(oauth2Client, port);
  return oauth2Client;
}
