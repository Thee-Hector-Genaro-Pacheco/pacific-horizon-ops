import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { getAuthenticatedClient } from './auth.js';
import {
  fetchRecentInboxMessages,
  getProcessedMessageIds,
  markMessageProcessed,
  createReplyDraft,
  type EmailMessage,
} from './gmail.js';
import { classifyEmail, type Classification } from './classify.js';
import { defaultActionStore } from './actions/store.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const RUNS_LOG_PATH = path.join(DATA_DIR, 'runs.jsonl');

interface RunLogEntry {
  timestamp: string;
  mode: 'dry-run' | 'live';
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  classification: Classification | null;
  decision: string;
  draftId?: string | null;
  actionId?: string | null;
}

interface SummaryRow {
  Subject: string;
  From: string;
  Category: string;
  Priority: string;
  Confidence: string;
  Decision: string;
}

/**
 * Appends a log entry to data/runs.jsonl
 */
function appendRunLog(entry: RunLogEntry): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.appendFileSync(RUNS_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf-8');
}

/**
 * Evaluates the policy rule in code:
 * Create draft ONLY if:
 *   requiresResponse === true
 *   AND category is not "system_notification" or "vendor_or_marketing"
 *   AND confidence >= 0.7
 */
function evaluatePolicy(classification: Classification): { eligible: boolean; reason: string } {
  if (!classification.requiresResponse) {
    return { eligible: false, reason: 'skipped (does not require response)' };
  }

  if (
    classification.category === 'system_notification' ||
    classification.category === 'vendor_or_marketing'
  ) {
    return { eligible: false, reason: `skipped (category: ${classification.category})` };
  }

  if (classification.confidence < 0.7) {
    return {
      eligible: false,
      reason: `skipped (low confidence: ${classification.confidence.toFixed(2)} < 0.70)`,
    };
  }

  return { eligible: true, reason: 'eligible for draft reply' };
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('==============================================');
  console.log('       Pacific Rising Ops (PHRO-001)         ');
  console.log('==============================================');
  if (isDryRun) {
    console.log(' [MODE] DRY-RUN enabled (no drafts will be created)');
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\nERROR: ANTHROPIC_API_KEY is not defined in your environment or .env file.');
    console.error('Please copy .env.example to .env and provide your API key.');
    process.exit(1);
  }

  // 1. Authenticate with Google Workspace Gmail
  let auth;
  try {
    auth = await getAuthenticatedClient();
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\nAuthentication Error: ${errorMsg}`);
    process.exit(1);
  }

  // 2. Fetch recent inbox messages
  const processedIds = getProcessedMessageIds();
  let messages: EmailMessage[] = [];
  try {
    messages = await fetchRecentInboxMessages(auth);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`\nFailed to fetch messages from Gmail: ${errorMsg}`);
    process.exit(1);
  }

  const unhandledMessages = messages.filter((m) => !processedIds.has(m.messageId));
  console.log(`Total messages in query: ${messages.length}`);
  console.log(`Already processed: ${messages.length - unhandledMessages.length}`);
  console.log(`New messages to process: ${unhandledMessages.length}\n`);

  if (unhandledMessages.length === 0) {
    console.log('No new messages to process. Inbox is up to date.');
    return;
  }

  const summaryRows: SummaryRow[] = [];

  // 3. Process each message: Classify -> Policy -> Act -> Log
  for (const message of unhandledMessages) {
    console.log(`----------------------------------------------`);
    console.log(`Processing: "${message.subject || '(no subject)'}" from <${message.from}>`);

    let classification: Classification | null = null;
    try {
      classification = await classifyEmail(message);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Classification error for message ${message.messageId}: ${errorMsg}`);
    }

    let decision = 'skipped (classification failed)';
    let draftId: string | null = null;
    let actionId: string | null = null;

    if (classification) {
      console.log(`  Category: ${classification.category} | Priority: ${classification.priority} | Confidence: ${classification.confidence}`);
      console.log(`  Summary: ${classification.summary}`);

      const policy = evaluatePolicy(classification);

      if (!policy.eligible) {
        decision = policy.reason;
        console.log(`  Policy: ${decision}`);
      } else if (isDryRun) {
        decision = 'skipped (dry run)';
        console.log(`  Policy: [DRY-RUN] Would create draft for "${message.subject}"`);
      } else {
        try {
          const draftBody =
            classification.draftReply ||
            'Hello,\n\nThank you for contacting Pacific Horizon Labs. We received your inquiry and will follow up shortly.\n\nBest regards,\nPacific Horizon Labs';

          console.log('  Policy: Creating Gmail draft reply...');
          draftId = await createReplyDraft(auth, message, draftBody);
          decision = 'drafted';
          console.log(`  Draft successfully created! Draft ID: ${draftId}`);

          const { action, isNew } = defaultActionStore.createDraftAction({
            messageId: message.messageId,
            threadId: message.threadId,
            draftId,
            subject: message.subject,
            from: message.from,
            classificationCategory: classification.category,
            confidence: classification.confidence,
            draftReply: draftBody,
          });
          actionId = action.actionId;
          console.log(
            `  Action ${isNew ? 'created' : 'retrieved'}: ${action.actionId} (Status: ${action.status})`
          );
        } catch (draftErr: unknown) {
          const draftErrorMsg = draftErr instanceof Error ? draftErr.message : String(draftErr);
          decision = `failed to create draft: ${draftErrorMsg}`;
          console.error(`  ${decision}`);
        }
      }
    }

    // Append to runs.jsonl
    appendRunLog({
      timestamp: new Date().toISOString(),
      mode: isDryRun ? 'dry-run' : 'live',
      messageId: message.messageId,
      threadId: message.threadId,
      from: message.from,
      subject: message.subject,
      classification,
      decision,
      draftId,
      actionId,
    });

    // Dry runs must never consume production deduplication state.
    // Failed live draft creation must remain retryable.
    if (!isDryRun && !decision.startsWith('failed to create draft')) {
      markMessageProcessed(message.messageId);
    }

    summaryRows.push({
      Subject: (message.subject || '(no subject)').slice(0, 30),
      From: message.from.slice(0, 25),
      Category: classification ? classification.category : 'N/A',
      Priority: classification ? classification.priority : 'N/A',
      Confidence: classification ? classification.confidence.toFixed(2) : 'N/A',
      Decision: decision,
    });
  }

  // 4. Print readable summary table to console
  console.log('\n==============================================');
  console.log('               RUN SUMMARY TABLE              ');
  console.log('==============================================');
  console.table(summaryRows);
  console.log(`Run complete. Detailed logs written to ${RUNS_LOG_PATH}\n`);
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
