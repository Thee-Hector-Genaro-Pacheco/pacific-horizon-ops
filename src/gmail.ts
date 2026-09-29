import fs from 'node:fs';
import path from 'node:path';
import { google, type gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export interface EmailMessage {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  messageIdHeader: string;
  references: string;
  body: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PROCESSED_PATH = path.join(DATA_DIR, 'processed.json');

/**
 * Ensures data directory exists
 */
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Reads list of previously processed Gmail message IDs
 */
export function getProcessedMessageIds(): Set<string> {
  ensureDataDir();
  if (!fs.existsSync(PROCESSED_PATH)) {
    return new Set<string>();
  }
  try {
    const raw = fs.readFileSync(PROCESSED_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set<string>(parsed);
    }
    return new Set<string>();
  } catch {
    return new Set<string>();
  }
}

/**
 * Adds a message ID to data/processed.json
 */
export function markMessageProcessed(messageId: string): void {
  ensureDataDir();
  const currentSet = getProcessedMessageIds();
  currentSet.add(messageId);
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify(Array.from(currentSet), null, 2), 'utf-8');
}

/**
 * Strips HTML tags and unescapes basic HTML entities
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Recursively extracts plain text and HTML parts from Gmail payload
 */
function extractBodyParts(
  part: gmail_v1.Schema$MessagePart,
  plainParts: string[],
  htmlParts: string[]
): void {
  if (part.mimeType === 'text/plain' && part.body?.data) {
    plainParts.push(Buffer.from(part.body.data, 'base64url').toString('utf-8'));
  } else if (part.mimeType === 'text/html' && part.body?.data) {
    htmlParts.push(Buffer.from(part.body.data, 'base64url').toString('utf-8'));
  }

  if (part.parts && part.parts.length > 0) {
    for (const subPart of part.parts) {
      extractBodyParts(subPart, plainParts, htmlParts);
    }
  }
}

/**
 * Extracts a readable plain-text body up to 8,000 characters
 */
function extractBody(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return '';

  const plainParts: string[] = [];
  const htmlParts: string[] = [];

  extractBodyParts(payload, plainParts, htmlParts);

  let body = '';
  if (plainParts.length > 0) {
    body = plainParts.join('\n\n');
  } else if (htmlParts.length > 0) {
    body = stripHtml(htmlParts.join('\n\n'));
  } else if (payload.body?.data) {
    const raw = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    body = payload.mimeType === 'text/html' ? stripHtml(raw) : raw;
  }

  return body.trim().slice(0, 8000);
}

/**
 * Fetches recent threads and extracts the latest message from each
 */
export async function fetchRecentInboxMessages(
  auth: OAuth2Client,
  query: string = process.env.GMAIL_QUERY || 'in:inbox newer_than:7d',
  maxResults = 25
): Promise<EmailMessage[]> {
  const gmail = google.gmail({ version: 'v1', auth });

  console.log(`Listing threads with query: "${query}" (max ${maxResults})...`);
  const listRes = await gmail.users.threads.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  const threads = listRes.data.threads || [];
  if (threads.length === 0) {
    console.log('No threads found matching query.');
    return [];
  }

  console.log(`Found ${threads.length} thread(s). Fetching details...`);
  const messages: EmailMessage[] = [];

  for (const t of threads) {
    if (!t.id) continue;

    const threadRes = await gmail.users.threads.get({
      userId: 'me',
      id: t.id,
      format: 'full',
    });

    const threadMessages = threadRes.data.messages;
    if (!threadMessages || threadMessages.length === 0) continue;

    // Get the latest message in the thread
    const latestMsg = threadMessages[threadMessages.length - 1];
    if (!latestMsg.id) continue;

    const headers = latestMsg.payload?.headers || [];
    const getHeader = (name: string): string => {
      const match = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
      return match?.value || '';
    };

    const from = getHeader('from');
    const to = getHeader('to');
    const subject = getHeader('subject');
    const date = getHeader('date');
    const messageIdHeader = getHeader('message-id');
    const references = getHeader('references');
    const body = extractBody(latestMsg.payload);

    messages.push({
      messageId: latestMsg.id,
      threadId: latestMsg.threadId || t.id,
      from,
      to,
      subject,
      date,
      messageIdHeader,
      references,
      body,
    });
  }

  return messages;
}

/**
 * Builds an RFC 2822 email and creates a reply draft in Gmail.
 * Note: Never sends an email; strictly invokes users.drafts.create.
 */
export async function createReplyDraft(
  auth: OAuth2Client,
  email: EmailMessage,
  draftReplyText: string
): Promise<string> {
  const gmail = google.gmail({ version: 'v1', auth });

  // Format Subject with single Re:
  const normalizedSubject = email.subject.trim().toLowerCase().startsWith('re:')
    ? email.subject.trim()
    : `Re: ${email.subject.trim()}`;

  // Build In-Reply-To and References
  const inReplyTo = email.messageIdHeader.trim();
  let references = email.references.trim();
  if (inReplyTo) {
    references = references ? `${references} ${inReplyTo}` : inReplyTo;
  }

  // Construct RFC 2822 message headers and body
  const lines: string[] = [
    `To: ${email.from}`,
    `Subject: ${normalizedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
  ];

  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
  }
  if (references) {
    lines.push(`References: ${references}`);
  }

  lines.push(''); // Blank line separating headers and body
  lines.push(draftReplyText);

  const rawRfc2822 = lines.join('\r\n');
  const encodedRaw = Buffer.from(rawRfc2822, 'utf-8').toString('base64url');

  const draftRes = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw: encodedRaw,
        threadId: email.threadId,
      },
    },
  });

  const createdDraftId = draftRes.data.id;
  if (!createdDraftId) {
    throw new Error('Draft creation succeeded but no draft ID was returned by Gmail API.');
  }

  return createdDraftId;
}
