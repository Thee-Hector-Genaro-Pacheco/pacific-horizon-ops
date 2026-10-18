import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { formatSafeSenderName } from '../voice/mailbox.js';
import { getProfileClient, type ProfileClientOptions } from './clients.js';
import { GoogleProfileError, loadGoogleProfiles, type GoogleProfileRegistry } from './profiles.js';
import { toCalendarError } from '../calendar/service.js';

/**
 * Bounded, read-only Gmail reads across profiles. Only list + metadata get; never
 * bodies of whole mailboxes, never drafts or sends. Every item keeps its source profile.
 */

export const DEFAULT_PER_PROFILE = 5;
const MAX_PER_PROFILE = 10;

export interface InboxItem {
  profileId: string;
  profileLabel: string;
  /** Composite identity: Gmail IDs are only unique within one mailbox. */
  key: string;
  messageId: string;
  threadId: string;
  /** Display name only; the address is stripped. */
  senderName: string;
  subject: string;
  /** Gmail internalDate (ms). Used for ordering across accounts. */
  internalDate: number;
  snippet: string;
  unread: boolean;
  important: boolean;
}

export interface GmailReadTransport {
  listMessageIds(params: { q: string; maxResults: number }): Promise<unknown>;
  getMessageMetadata(id: string): Promise<unknown>;
}

export function googleGmailReadTransport(auth: OAuth2Client, timeoutMs = 10_000): GmailReadTransport {
  const gmail = google.gmail({ version: 'v1', auth });
  return {
    async listMessageIds({ q, maxResults }) {
      const res = await gmail.users.messages.list({ userId: 'me', q, maxResults, includeSpamTrash: false }, { timeout: timeoutMs });
      return res.data;
    },
    async getMessageMetadata(id) {
      const res = await gmail.users.messages.get(
        { userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] },
        { timeout: timeoutMs }
      );
      return res.data;
    },
  };
}

const ListSchema = z.object({ messages: z.array(z.object({ id: z.string() })).optional().nullable() });
const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional().nullable(),
  internalDate: z.string().regex(/^\d+$/),
  snippet: z.string().optional().nullable(),
  labelIds: z.array(z.string()).optional().nullable(),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional().nullable() }).optional().nullable(),
});

export class GmailReadError extends Error {
  constructor(readonly kind: 'malformed_response' | 'upstream_error', message: string) {
    super(message);
    this.name = 'GmailReadError';
  }
}

export interface InboxSource {
  profileId: string;
  label: string;
  getTransport(): Promise<GmailReadTransport>;
}

export async function readInbox(source: InboxSource, opts: { query?: string; max?: number } = {}): Promise<InboxItem[]> {
  const transport = await source.getTransport();
  const max = Math.min(Math.max(1, opts.max ?? DEFAULT_PER_PROFILE), MAX_PER_PROFILE);
  const list = ListSchema.safeParse(await transport.listMessageIds({ q: opts.query ?? 'in:inbox', maxResults: max }));
  if (!list.success) throw new GmailReadError('malformed_response', 'Gmail returned a message list in an unexpected shape.');
  const items: InboxItem[] = [];
  for (const { id } of (list.data.messages ?? []).slice(0, max)) {
    const parsed = MessageSchema.safeParse(await transport.getMessageMetadata(id));
    if (!parsed.success) throw new GmailReadError('malformed_response', 'Gmail returned a message in an unexpected shape.');
    const m = parsed.data;
    const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
    const labels = m.labelIds ?? [];
    items.push({
      profileId: source.profileId,
      profileLabel: source.label,
      key: `${source.profileId}:${m.id}`,
      messageId: m.id,
      threadId: m.threadId ?? m.id,
      senderName: formatSafeSenderName(header('from')),
      // Gmail metadata headers are already decoded UTF-8; do not decode again.
      subject: header('subject').trim() || '(No subject)',
      internalDate: Number(m.internalDate),
      snippet: (m.snippet ?? '').slice(0, 200),
      unread: labels.includes('UNREAD'),
      important: labels.includes('IMPORTANT'),
    });
  }
  return items;
}

export type InboxStatus = 'complete' | 'partial' | 'failed';

export interface InboxAggregate {
  items: InboxItem[];
  status: InboxStatus;
  checked: string[];
  failed: Array<{ profileId: string; label: string; kind: string }>;
}

/** Reads each inbox independently and merges by Gmail internalDate, newest first. */
export async function readInboxes(sources: InboxSource[], opts: { query?: string; max?: number } = {}): Promise<InboxAggregate> {
  const outcomes = await Promise.allSettled(sources.map((s) => readInbox(s, opts)));
  const failed: InboxAggregate['failed'] = [];
  const checked: string[] = [];
  outcomes.forEach((o, i) => {
    if (o.status === 'fulfilled') checked.push(sources[i].label);
    else {
      const e = o.reason as { kind?: string };
      const kind =
        e instanceof GoogleProfileError
          ? e.kind === 'not_connected' || e.kind === 'missing_scope'
            ? 'missing_scope'
            : e.kind === 'account_mismatch'
              ? 'unauthorized'
              : 'config'
          : e instanceof GmailReadError
            ? e.kind
            : toCalendarError(e).kind; // same googleapis/gaxios error mapping (401, timeout, network, ...)
      failed.push({ profileId: sources[i].profileId, label: sources[i].label, kind });
    }
  });
  const items = outcomes
    .flatMap((o) => (o.status === 'fulfilled' ? o.value : []))
    .sort((a, b) => b.internalDate - a.internalDate || a.key.localeCompare(b.key));
  return { items, status: failed.length === 0 ? 'complete' : checked.length > 0 ? 'partial' : 'failed', checked, failed };
}

/** Inbox sources for selected profiles (default: every enabled Gmail profile), each with its own token. */
export function inboxSourcesFromRegistry(
  selection: string[] | 'all',
  options: { registry?: GoogleProfileRegistry; client?: ProfileClientOptions } = {}
): InboxSource[] {
  const registry = options.registry ?? loadGoogleProfiles();
  const profiles = selection === 'all' ? registry.withCapability('gmail.read') : selection.map((id) => registry.get(id));
  return profiles.map((p) => ({
    profileId: p.id,
    label: p.label,
    getTransport: async () => googleGmailReadTransport(await getProfileClient(p.id, 'gmail.read', { registry, ...options.client })),
  }));
}
