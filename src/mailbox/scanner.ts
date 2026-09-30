import { google, type gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { getActiveProfile, getExpectedAccount, type GmailProfile } from '../auth.js';
import {
  classifyEmailForCleanup,
  type EmailMetadataForClassification,
} from './classifier.js';
import { type MailboxCleanupCandidate } from './types.js';

export interface ScanOptions {
  query: string;
  maxResults?: number;
}

export interface ScanResult {
  gmailAccount: string;
  gmailProfile?: GmailProfile;
  query: string;
  candidates: MailboxCleanupCandidate[];
  excluded: MailboxCleanupCandidate[];
  totalEstimatedBytes: number | null;
}

/**
 * Scans a connected Gmail account using a safe search query.
 * Read-only operation: NEVER performs any mutation (no trash, no delete).
 */
export async function scanMailbox(
  auth: OAuth2Client,
  options: ScanOptions
): Promise<ScanResult> {
  const gmail = google.gmail({ version: 'v1', auth });
  const activeProfile = getActiveProfile();

  // 1. Fetch user profile to identify Gmail account
  let gmailAccount = 'me';
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    if (profile.data.emailAddress) {
      gmailAccount = profile.data.emailAddress.trim().toLowerCase();
    }
  } catch (err: unknown) {
    console.warn('[mailbox:scanner] Could not fetch profile emailAddress, defaulting to "me".');
  }

  // Goal 5: Ensure authenticated account matches expected account before querying or creating plan!
  const expected = getExpectedAccount(activeProfile);
  if (expected && gmailAccount.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Authenticated Gmail account does not match the configured account for profile ${activeProfile}.`
    );
  }

  // 2. Query messages matching safe query
  const maxResults = options.maxResults || 50;
  console.log(`Scanning Gmail for query: "${options.query}" (max ${maxResults} messages)...`);

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: options.query,
    maxResults,
  });

  const messageItems = listRes.data.messages || [];
  if (messageItems.length === 0) {
    console.log('No messages found matching search query.');
    return {
      gmailAccount,
      gmailProfile: activeProfile,
      query: options.query,
      candidates: [],
      excluded: [],
      totalEstimatedBytes: 0,
    };
  }

  console.log(`Found ${messageItems.length} message(s). Inspecting metadata...`);

  const candidates: MailboxCleanupCandidate[] = [];
  const excluded: MailboxCleanupCandidate[] = [];
  let totalEstimatedBytes: number | null = 0;
  let hasValidSizeEstimates = false;

  for (const item of messageItems) {
    if (!item.id) continue;

    const msgRes = await gmail.users.messages.get({
      userId: 'me',
      id: item.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date', 'List-Unsubscribe'],
    });

    const msg = msgRes.data;
    const headers = msg.payload?.headers || [];
    const getHeader = (name: string): string => {
      const match = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
      return match?.value || '';
    };

    const sender = getHeader('from');
    const subject = getHeader('subject');
    const date = getHeader('date');
    const hasListUnsubscribeHeader = Boolean(getHeader('list-unsubscribe'));
    const sizeEstimate = typeof msg.sizeEstimate === 'number' ? msg.sizeEstimate : null;

    if (sizeEstimate !== null) {
      totalEstimatedBytes = (totalEstimatedBytes || 0) + sizeEstimate;
      hasValidSizeEstimates = true;
    }

    const emailForClassification: EmailMetadataForClassification = {
      messageId: msg.id || item.id,
      sender,
      subject,
      snippet: msg.snippet || '',
      labelIds: msg.labelIds || [],
      sizeEstimate,
      hasListUnsubscribeHeader,
    };

    const classification = classifyEmailForCleanup(emailForClassification);

    const candidate: MailboxCleanupCandidate = {
      messageId: msg.id || item.id,
      threadId: msg.threadId || item.threadId || msg.id || item.id,
      sender,
      subject,
      date,
      category: classification.category,
      reason: classification.reason,
      confidence: classification.confidence,
      estimatedSize: sizeEstimate,
      protectionFlags: classification.protectionFlags,
      recommendedAction: classification.recommendedAction,
      executionStatus: 'PENDING',
    };

    if (classification.recommendedAction === 'RECOMMEND_TRASH') {
      candidates.push(candidate);
    } else {
      excluded.push({
        ...candidate,
        executionStatus: 'SKIPPED',
        executionReason: `Protected: ${classification.reason}`,
      });
    }
  }

  return {
    gmailAccount,
    gmailProfile: activeProfile,
    query: options.query,
    candidates,
    excluded,
    totalEstimatedBytes: hasValidSizeEstimates ? totalEstimatedBytes : null,
  };
}
