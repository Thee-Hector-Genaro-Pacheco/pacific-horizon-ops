import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { extractBody } from '../gmail.js';

export interface EligibleInboxMessage {
  index: number;
  messageId: string;
  threadId: string;
  from: string;
  senderName: string;
  subject: string;
  date: string;
  internalDate: number;
  body: string;
  snippet?: string;
  /** Google profile this message was read from. Absent means the business mailbox. */
  profileId?: string;
}

/**
 * Extracts a friendly, safe display name from a sender string without exposing raw email address
 * e.g. "Hector Pacheco <hector@example.com>" -> "Hector Pacheco"
 * e.g. "client@gmail.com" -> "client"
 */
export function formatSafeSenderName(from: string): string {
  if (!from) return 'Unknown sender';
  const trimmed = from.trim();
  // Name <email> or "Name" <email>
  const match = trimmed.match(/^"?([^"<]+)"?\s*<.*>$/);
  if (match && match[1]?.trim()) {
    return match[1].trim();
  }
  // Bare email address: take username part before @
  const emailMatch = trimmed.match(/<([^>]+)>/) || [null, trimmed];
  const email = (emailMatch[1] || trimmed).trim();
  const username = email.split('@')[0];
  return username || 'Unknown sender';
}

function extractEmail(raw: string): string {
  if (!raw) return '';
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

// Patterns for automated system noise and newsletters
const NEWSLETTER_PROMO_PATTERNS =
  /\b(newsletter|unsubscribe|weekly\s+digest|daily\s+brief|deals?\s+of\s+the\s+week|limited\s+time\s+offer|clearance\s+sale|flash\s+sale|exclusive\s+discount|% off)\b/i;

const SENDER_NOISE_PATTERNS =
  /\b(no-?reply@|newsletter@|promotions?@|marketing@|updates@|info@news\.|notifications?@|alerts?@|mailer-daemon@|postmaster@)/i;

const SYSTEM_NOISE_SUBJECTS =
  /\b(security\s+alert|verification\s+code|password\s+reset|sign-in\s+attempt|one-time\s+passcode|otp|2fa|login\s+alert|delivery\s+status\s+notification)\b/i;

/**
 * Deterministically checks whether an inbox message is eligible for owner voice review
 */
export function isEligibleInboxMessage(
  msg: { from: string; subject: string; snippet?: string; body?: string },
  businessEmail?: string
): boolean {
  const fromEmail = extractEmail(msg.from);

  // 1. Exclude PHRO's own sent messages
  if (businessEmail) {
    const ownEmail = extractEmail(businessEmail);
    if (fromEmail === ownEmail) {
      return false;
    }
  }

  // 2. Exclude obvious system noise and sender noise
  if (SENDER_NOISE_PATTERNS.test(fromEmail) || SENDER_NOISE_PATTERNS.test(msg.from)) {
    return false;
  }

  if (SYSTEM_NOISE_SUBJECTS.test(msg.subject)) {
    return false;
  }

  // 3. Exclude obvious promotions and newsletters
  const text = `${msg.subject} ${msg.snippet || ''}`;
  if (NEWSLETTER_PROMO_PATTERNS.test(text)) {
    return false;
  }

  return true;
}

/**
 * Formats the initial mailbox greeting listing the available recent emails
 */
export function formatMailboxGreeting(messages: EligibleInboxMessage[]): string {
  if (messages.length === 0) {
    return 'I did not find any recent business emails in your inbox. Goodbye!';
  }

  const countWords = ['zero', 'one', 'two', 'three'];
  const countStr = countWords[messages.length] || String(messages.length);
  const emailNoun = messages.length === 1 ? 'business email' : 'recent business emails';

  const parts: string[] = [`I found ${countStr} ${emailNoun}.`];
  const ordinals = ['one', 'two', 'three'];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    parts.push(`Message ${ordinals[i]} is from ${m.senderName} about ${m.subject}.`);
  }

  parts.push('Which would you like to review?');
  return parts.join(' ');
}

/**
 * Parses user speech for message selection ("message one", "two", "the third one", etc.)
 */
export function parseMessageSelection(utterance: string): number | null {
  const norm = utterance.toLowerCase().trim().replace(/[.,!?;:]/g, '');

  if (/\b(3|three|third|number\s+three|message\s+three|the\s+third(\s+one)?)\b/.test(norm)) {
    return 3;
  }
  if (/\b(2|two|second|number\s+two|message\s+two|the\s+second(\s+one)?)\b/.test(norm)) {
    return 2;
  }
  if (
    /\b(1|first|number\s+one|message\s+one|the\s+first(\s+one)?)\b/.test(norm) ||
    (/\bone\b/.test(norm) && !/\b(second|third)\b/.test(norm))
  ) {
    return 1;
  }

  return null;
}

/**
 * Generates a polite, compliant draft reply adhering to business.md
 */
export function generateDraftReply(message: EligibleInboxMessage): string {
  const normSubject = message.subject.toLowerCase();
  const normBody = message.body.toLowerCase();

  if (
    normSubject.includes('photo booth') ||
    normSubject.includes('inquiry') ||
    normSubject.includes('quote') ||
    normBody.includes('quote') ||
    normBody.includes('photo booth')
  ) {
    return (
      `Hello,\n\n` +
      `Thank you for contacting Pacific Horizon Labs! We would love to help make your event special.\n\n` +
      `To provide an accurate quote and confirm availability, could you please share:\n` +
      `- The exact date and location of your event\n` +
      `- The start and end time you are planning\n` +
      `- Which package you are interested in (Standard Digital, Premium Print & Digital, or Luxe)\n\n` +
      `Once we have these details, we will follow up with a customized quote and availability.\n\n` +
      `Best regards,\nHector Pacheco\nPacific Horizon Labs`
    );
  }

  return (
    `Hello,\n\n` +
    `Thank you for contacting Pacific Horizon Labs. We received your message regarding "${message.subject}" and will follow up shortly.\n\n` +
    `Best regards,\nHector Pacheco\nPacific Horizon Labs`
  );
}

export interface RawInboxCandidate {
  messageId: string;
  threadId?: string;
  from: string;
  subject: string;
  date?: string;
  internalDate: number | string;
  body?: string;
  snippet?: string;
  labelIds?: string[];
}

export interface MessageClassificationResult {
  category: 'customer_inquiry' | 'system_notification' | 'newsletter_promo' | 'general';
  isAutomatedNoise: boolean;
  canDraft: boolean;
  warning?: string;
}

/**
 * Classifies an inbox message AFTER it has been selected by the caller.
 * Does NOT filter or alter which messages are presented in the initial top 3.
 */
export function classifyInboxMessage(msg: {
  from: string;
  subject: string;
  snippet?: string;
  body?: string;
}): MessageClassificationResult {
  const fromEmail = extractEmail(msg.from);
  const text = `${msg.subject} ${msg.snippet || ''} ${msg.body || ''}`;

  if (
    SYSTEM_NOISE_SUBJECTS.test(msg.subject) ||
    SENDER_NOISE_PATTERNS.test(fromEmail) ||
    SENDER_NOISE_PATTERNS.test(msg.from)
  ) {
    return {
      category: 'system_notification',
      isAutomatedNoise: true,
      canDraft: false,
      warning: 'This appears to be an automated system notification.',
    };
  }

  if (NEWSLETTER_PROMO_PATTERNS.test(text)) {
    return {
      category: 'newsletter_promo',
      isAutomatedNoise: true,
      canDraft: false,
      warning: 'This appears to be a newsletter or promotional email.',
    };
  }

  const normSubject = msg.subject.toLowerCase();
  const normBody = (msg.body || '').toLowerCase();
  if (
    normSubject.includes('photo booth') ||
    normSubject.includes('inquiry') ||
    normSubject.includes('booking') ||
    normSubject.includes('pricing') ||
    normSubject.includes('event') ||
    normBody.includes('photo booth') ||
    normBody.includes('quote')
  ) {
    return {
      category: 'customer_inquiry',
      isAutomatedNoise: false,
      canDraft: true,
    };
  }

  return {
    category: 'general',
    isAutomatedNoise: false,
    canDraft: true,
  };
}

/**
 * Selects the literal top 3 newest messages currently in Gmail Inbox.
 *
 * Rules:
 * - Scoped strictly to messages with labelIds containing 'INBOX'.
 * - Explicitly excludes 'TRASH' and 'SPAM'.
 * - Excludes Sent-only messages (must have 'INBOX').
 * - Ignores read/unread status.
 * - Does NOT pre-filter for promotions, newsletters, system notifications,
 *   Google Workspace, Twilio, or self-sent emails.
 * - Numerically sorts descending by internalDate.
 * - Deduplicates by threadId (keeping the latest message per thread in Inbox).
 * - Slices exactly top 3.
 * - Logs safe diagnostics.
 */
export function selectTop3InboxMessages(
  candidates: RawInboxCandidate[],
  options: { logDiagnostics?: boolean } = { logDiagnostics: true }
): EligibleInboxMessage[] {
  // 1. Filter to candidates that have INBOX label and are not TRASH or SPAM
  const eligible = candidates.filter((c) => {
    const labels = c.labelIds || ['INBOX']; // Default to INBOX if not specified in mock
    return labels.includes('INBOX') && !labels.includes('TRASH') && !labels.includes('SPAM');
  });

  // 2. Sort descending numerically by internalDate (newest first)
  eligible.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));

  // 3. Deduplicate by threadId (keeping newest message in each thread)
  const seenThreads = new Set<string>();
  const topCandidates: RawInboxCandidate[] = [];

  for (const c of eligible) {
    const key = c.threadId || c.messageId;
    if (seenThreads.has(key)) {
      continue;
    }
    seenThreads.add(key);
    topCandidates.push(c);
    if (topCandidates.length === 3) {
      break;
    }
  }

  // 4. Map to EligibleInboxMessage with 1-based index and safe sender name
  const result: EligibleInboxMessage[] = topCandidates.map((m, idx) => ({
    index: idx + 1,
    messageId: m.messageId,
    threadId: m.threadId || m.messageId,
    from: m.from,
    senderName: formatSafeSenderName(m.from),
    subject: m.subject || '(No Subject)',
    date: m.date || '',
    internalDate: Number(m.internalDate || 0),
    body: m.body || '',
    snippet: m.snippet || '',
  }));

  // 5. Safe diagnostics logging (Task 7)
  if (options.logDiagnostics !== false) {
    console.log('Mailbox top 3:');
    if (result.length === 0) {
      console.log('  (no inbox messages found)');
    } else {
      result.forEach((m) => {
        const isoTime = m.internalDate ? new Date(m.internalDate).toISOString() : 'unknown';
        console.log(`  ${m.index}. timestamp=${isoTime} sender=${m.senderName} subject=${m.subject}`);
      });
    }
  }

  return result;
}

/**
 * Fetches the newest inbox messages directly from Gmail, ordered by internalDate descending (max 3).
 * Does not pre-filter for promotions, newsletters, system notifications, or self-sent emails.
 */
export async function fetchEligibleInboxMessages(
  auth: OAuth2Client,
  options: {
    maxResults?: number;
    businessEmail?: string;
    query?: string;
  } = {}
): Promise<EligibleInboxMessage[]> {
  const gmail = google.gmail({ version: 'v1', auth });
  const query = options.query || 'in:inbox';
  const maxFetch = Math.max(options.maxResults || 20, 20);

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    includeSpamTrash: false,
    maxResults: maxFetch,
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) {
    console.log('Mailbox top 3:');
    console.log('  (no inbox messages found)');
    return [];
  }

  const rawCandidates: RawInboxCandidate[] = [];

  for (const m of messages) {
    if (!m.id) continue;
    try {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'full',
      });
      const data = msgRes.data;
      if (!data.id) continue;

      const headers = data.payload?.headers || [];
      const getHeader = (name: string): string => {
        const match = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
        return match?.value || '';
      };

      rawCandidates.push({
        messageId: data.id,
        threadId: data.threadId || data.id,
        from: getHeader('from') || 'Unknown sender',
        subject: getHeader('subject') || '(No Subject)',
        date: getHeader('date'),
        internalDate: Number(data.internalDate || 0),
        body: extractBody(data.payload),
        snippet: data.snippet || '',
        labelIds: data.labelIds || [],
      });
    } catch {
      // Continue on read error
    }
  }

  return selectTop3InboxMessages(rawCandidates, { logDiagnostics: true });
}
