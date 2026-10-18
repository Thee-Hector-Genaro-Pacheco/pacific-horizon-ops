import crypto from 'node:crypto';

/** Bump when normalization or chunking changes, so identical files are re-chunked once. */
export const PIPELINE_VERSION = 'kp1';

/**
 * Deterministic text normalization: Unicode NFC, LF line endings, no BOM, no control
 * characters (except tab/newline), no trailing spaces, at most one blank line in a row.
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(/^﻿/, '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function contentHash(normalized: string): string {
  return crypto.createHash('sha256').update(`${PIPELINE_VERSION}\n${normalized}`).digest('hex');
}

/**
 * Credential-looking content. A document containing any of these is refused (recorded as
 * an ingestion error), so secrets that slip into a knowledge folder never reach the store.
 */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style API key', /\bsk-[A-Za-z0-9]{32,}/],
  ['Google OAuth access token', /\bya29\.[A-Za-z0-9_-]{20,}/],
  ['Google OAuth refresh token', /\b1\/\/0[A-Za-z0-9_-]{30,}/],
  ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Twilio auth token assignment', /TWILIO_AUTH_TOKEN\s*[=:]\s*['"]?[a-f0-9]{32}/i],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['bearer credential', /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i],
  ['database URL with password', /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i],
  ['client secret JSON', /"client_secret"\s*:\s*"[^"]{8,}"/],
  ['refresh token JSON', /"refresh_token"\s*:\s*"[^"]{8,}"/],
];

export function findSecretLikeContent(text: string): string | null {
  for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) return label;
  return null;
}
