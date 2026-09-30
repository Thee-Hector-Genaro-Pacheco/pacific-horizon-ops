import 'dotenv/config';
import { getAuthenticatedClient } from '../auth.js';
import { defaultMailboxStore, type MailboxStore } from './store.js';
import { resolveQuery, QUERY_PRESETS } from './queries.js';
import { scanMailbox } from './scanner.js';
import { createCleanupPlan } from './planner.js';
import { executeCleanupPlan } from './executor.js';

function printHelp(): void {
  console.log(`
Pacific Rising Ops - Safe Mailbox Cleanup CLI (PHRO-MAIL-001)

Commands:
  scan       Scan Gmail and create a reviewable cleanup plan (Never mutates Gmail)
             Options:
               --preset <preset>   Use a safe preset: ${Object.keys(QUERY_PRESETS).join(', ')}
               --query "<query>"   Use custom query (must include safe category filter)
               --max <number>      Maximum messages to inspect (default: 50)

  plans      List all persisted cleanup plans

  plan       View details and candidates of a specific plan
             Usage: npm run mailbox:plan -- <planId>

  approve    Approve a cleanup plan for execution (Never mutates Gmail)
             Usage: npm run mailbox:approve -- <planId>

  execute    Execute an approved cleanup plan (Moves messages to Gmail Trash)
             Usage: npm run mailbox:execute -- <planId> [--dry-run]
`);
}

async function handleScan(args: string[]): Promise<void> {
  const presetIndex = args.indexOf('--preset');
  const queryIndex = args.indexOf('--query');
  const maxIndex = args.indexOf('--max');

  const preset = presetIndex !== -1 ? args[presetIndex + 1] : undefined;
  const customQuery = queryIndex !== -1 ? args[queryIndex + 1] : undefined;
  const maxResults = maxIndex !== -1 ? Number.parseInt(args[maxIndex + 1], 10) : 50;

  const query = resolveQuery(preset, customQuery);

  console.log('\n==============================================');
  console.log('       Scanning Mailbox for Cleanup           ');
  console.log('==============================================');
  console.log(`Resolved Query: "${query}"`);
  console.log('[SAFETY] Scan mode is strictly read-only. Zero messages will be trashed.\n');

  const auth = await getAuthenticatedClient();
  const scanResult = await scanMailbox(auth, { query, maxResults });

  const plan = createCleanupPlan(scanResult);

  console.log('\n==============================================');
  console.log('          CLEANUP PLAN CREATED                ');
  console.log('==============================================');
  console.log(`Plan ID:     ${plan.id}`);
  console.log(`Status:      ${plan.status}`);
  console.log(`Candidates:  ${plan.candidateCount} (Recommended for Trash)`);
  console.log(`Protected:   ${plan.excludedCount} (Excluded / Safe)`);
  if (plan.totalEstimatedBytes !== null) {
    const mb = (plan.totalEstimatedBytes / (1024 * 1024)).toFixed(2);
    console.log(`Total Size:  ~${mb} MB`);
  } else {
    console.log(`Total Size:  Unavailable from Gmail metadata`);
  }

  if (plan.candidates.length > 0) {
    console.log('\nTop Cleanup Candidates Preview:');
    const previewRows = plan.candidates.slice(0, 10).map((c) => ({
      Subject: c.subject.slice(0, 32),
      Sender: c.sender.slice(0, 24),
      Category: c.category,
      Confidence: c.confidence.toFixed(2),
      Action: c.recommendedAction,
    }));
    console.table(previewRows);
    if (plan.candidates.length > 10) {
      console.log(`... and ${plan.candidates.length - 10} more candidates.`);
    }
  }

  const profilePrefix = `PHRO_GMAIL_PROFILE=${plan.gmailProfile || 'business'}`;
  console.log(`\nNext Steps:`);
  console.log(`  1. Inspect full plan: ${profilePrefix} npm run mailbox:plan -- ${plan.id}`);
  console.log(`  2. Approve plan:      ${profilePrefix} npm run mailbox:approve -- ${plan.id}`);
  console.log(`  3. Dry-run execute:   ${profilePrefix} npm run mailbox:execute -- ${plan.id} --dry-run`);
  console.log(`  4. Live execute:      ${profilePrefix} npm run mailbox:execute -- ${plan.id}\n`);
}

function handlePlans(): void {
  const plans = defaultMailboxStore.listPlans();

  console.log('\n==============================================');
  console.log('           MAILBOX CLEANUP PLANS              ');
  console.log('==============================================\n');

  if (plans.length === 0) {
    console.log('No cleanup plans found. Run `npm run mailbox:scan` to create one.\n');
    return;
  }

  const rows = plans.map((p) => ({
    Profile: p.gmailProfile || '(unbound)',
    Account: p.gmailAccount,
    'Plan ID': p.id,
    Status: p.status,
    Candidates: p.candidateCount,
    Protected: p.excludedCount,
    Query: p.query.length > 25 ? `${p.query.slice(0, 22)}...` : p.query,
    Created: new Date(p.createdAt).toLocaleDateString(),
  }));

  console.table(rows);
  console.log(`Total: ${plans.length} plan(s)\n`);
}

export function handlePlanDetail(
  planId?: string,
  store: MailboxStore = defaultMailboxStore
): void {
  if (!planId) {
    console.error('Error: Missing planId argument.');
    console.error('Usage: npm run mailbox:plan -- <planId>');
    if (process.env.NODE_ENV !== 'test') {
      process.exit(1);
    }
    return;
  }

  const plan = store.getPlan(planId);
  if (!plan) {
    console.error(`Error: Cleanup plan "${planId}" not found.`);
    if (process.env.NODE_ENV !== 'test') {
      process.exit(1);
    }
    return;
  }

  console.log('\n==============================================');
  console.log(`           PLAN DETAILS: ${plan.id}           `);
  console.log('==============================================');
  console.log(`Profile:     ${plan.gmailProfile || '(unbound)'}`);
  console.log(`Account:     ${plan.gmailAccount}`);
  console.log(`Status:      ${plan.status}`);
  console.log(`Query:       "${plan.query}"`);
  console.log(`Created:     ${new Date(plan.createdAt).toLocaleString()}`);
  if (plan.approvedAt) console.log(`Approved At: ${plan.approvedAt} by ${plan.approvedBy}`);
  if (plan.executedAt) console.log(`Executed At: ${plan.executedAt}`);

  console.log(`\nCandidates (${plan.candidates.length}):`);
  if (plan.candidates.length === 0) {
    console.log('No candidates in this plan.');
  } else {
    const candidateRows = plan.candidates.map((c) => ({
      ID: c.messageId.slice(0, 10),
      Subject: c.subject.slice(0, 28),
      Sender: c.sender.slice(0, 22),
      Category: c.category,
      Flags: c.protectionFlags.join(', ') || 'NONE',
      Action: c.recommendedAction,
      ExecStatus: c.executionStatus || 'PENDING',
    }));
    console.table(candidateRows);
  }

  const excludedList = plan.excluded;
  console.log(`\nProtected / Excluded Messages (${plan.excludedCount}):`);
  if (!excludedList) {
    console.log('Protected message details were not recorded for this legacy plan (details unavailable for legacy plan).');
  } else if (excludedList.length === 0) {
    console.log('No protected or excluded messages recorded.');
  } else {
    const protectedRows = excludedList.map((p) => ({
      ID: p.messageId.slice(0, 10),
      Subject: p.subject.slice(0, 28),
      Sender: p.sender.slice(0, 22),
      Category: p.category,
      Flags: p.protectionFlags.join(', ') || 'NONE',
      Disposition: p.recommendedAction,
      Reason: p.reason,
    }));
    console.table(protectedRows);
  }
  console.log('');
}

function handleApprove(planId?: string): void {
  if (!planId) {
    console.error('Error: Missing planId argument.');
    console.error('Usage: npm run mailbox:approve -- <planId>');
    process.exit(1);
  }

  const actor = process.env.USER || process.env.LOGNAME || 'cli:user';
  try {
    const plan = defaultMailboxStore.approvePlan(planId, actor);
    const profilePrefix = `PHRO_GMAIL_PROFILE=${plan.gmailProfile || 'business'}`;
    console.log('\n==============================================');
    console.log('            CLEANUP PLAN APPROVED             ');
    console.log('==============================================');
    console.log(`Plan ID:     ${plan.id}`);
    console.log(`Profile:     ${plan.gmailProfile || '(unbound)'}`);
    console.log(`Account:     ${plan.gmailAccount}`);
    console.log(`Status:      ${plan.status}`);
    console.log(`Approved By: ${actor}`);
    console.log(`Candidates:  ${plan.candidateCount} messages authorized for Gmail Trash.\n`);
    console.log('[SAFEGUARD] Plan is now authorized. No messages have been modified yet.');
    console.log(`To simulate execution: ${profilePrefix} npm run mailbox:execute -- ${plan.id} --dry-run`);
    console.log(`To execute cleanup:    ${profilePrefix} npm run mailbox:execute -- ${plan.id}\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFailed to approve plan: ${msg}\n`);
    process.exit(1);
  }
}

async function handleExecute(args: string[]): Promise<void> {
  const isDryRun = args.includes('--dry-run');
  const planId = args.find((a) => !a.startsWith('--') && a !== 'execute');

  if (!planId) {
    console.error('Error: Missing planId argument.');
    console.error('Usage: npm run mailbox:execute -- <planId> [--dry-run]');
    process.exit(1);
  }

  const auth = await getAuthenticatedClient();
  await executeCleanupPlan(auth, planId, { dryRun: isDryRun });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'scan':
      await handleScan(args.slice(1));
      break;
    case 'plans':
      handlePlans();
      break;
    case 'plan':
      handlePlanDetail(args[1]);
      break;
    case 'approve':
      handleApprove(args[1]);
      break;
    case 'execute':
      await handleExecute(args.slice(1));
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      if (!command) {
        printHelp();
      } else {
        console.error(`Unknown mailbox command: "${command}"`);
        printHelp();
        process.exit(1);
      }
      break;
  }
}

if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  main().catch((err) => {
    console.error('\nFatal Mailbox CLI Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
