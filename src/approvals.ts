import { defaultActionStore } from './actions/store.js';
import { type ApprovalRecord } from './actions/types.js';

function printHelp(): void {
  console.log(`
Pacific Rising Ops - Approval CLI

Usage:
  npm run approvals:list [--all]
  npm run approvals:approve -- <actionId>
  npm run approvals:reject -- <actionId>

Commands:
  list                 List actions awaiting approval (use --all to show all actions)
  approve <actionId>   Approve a pending action (transitions AWAITING_APPROVAL -> APPROVED)
  reject <actionId>    Reject a pending action (transitions AWAITING_APPROVAL -> REJECTED)
`);
}

async function handleList(args: string[]): Promise<void> {
  const showAll = args.includes('--all');
  const actions = defaultActionStore.listActions(
    showAll ? undefined : { status: 'AWAITING_APPROVAL' }
  );

  console.log('\n==============================================');
  console.log(
    showAll
      ? '               ALL ACTIONS RECORDED           '
      : '            ACTIONS AWAITING APPROVAL         '
  );
  console.log('==============================================\n');

  if (actions.length === 0) {
    console.log(
      showAll
        ? 'No actions found in store.'
        : 'No actions currently awaiting approval. (Use --all to view historical actions)'
    );
    console.log('');
    return;
  }

  const tableData = actions.map((a) => ({
    'Action ID': a.actionId,
    Status: a.status,
    From: a.from.length > 25 ? `${a.from.slice(0, 22)}...` : a.from,
    Subject: a.subject.length > 30 ? `${a.subject.slice(0, 27)}...` : a.subject,
    Category: a.classificationCategory,
    'Conf.': a.confidence.toFixed(2),
    'Draft ID': a.draftId || 'N/A',
    Created: new Date(a.createdAt).toLocaleString(),
  }));

  console.table(tableData);
  console.log(`Total: ${actions.length} action(s)\n`);
}

async function handleApprove(actionId?: string): Promise<void> {
  if (!actionId) {
    console.error('Error: Missing actionId argument.');
    console.error('Usage: npm run approvals:approve -- <actionId>');
    process.exit(1);
  }

  const action = defaultActionStore.getAction(actionId);
  if (!action) {
    console.error(`Error: Action with ID "${actionId}" was not found.`);
    process.exit(1);
  }

  const actor = process.env.USER || process.env.LOGNAME || 'cli';
  const approval: ApprovalRecord = {
    decision: 'approved',
    approvedBy: actor,
    approvedAt: new Date().toISOString(),
    approvalSource: 'cli',
    notes: 'Approved via CLI',
  };

  try {
    const updated = defaultActionStore.approveAction(actionId, approval);
    console.log('\n==============================================');
    console.log('               ACTION APPROVED                ');
    console.log('==============================================');
    console.log(`Action ID:   ${updated.actionId}`);
    console.log(`Status:      ${updated.status}`);
    console.log(`Subject:     ${updated.subject}`);
    console.log(`Approved By: ${actor} (via cli)`);
    console.log(`Draft ID:    ${updated.draftId || 'N/A'}`);
    console.log('\n[SAFEGUARD] Authorization recorded. No email sent.');
    console.log('Action is authorized for future execution.\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFailed to approve action: ${msg}\n`);
    process.exit(1);
  }
}

async function handleReject(actionId?: string): Promise<void> {
  if (!actionId) {
    console.error('Error: Missing actionId argument.');
    console.error('Usage: npm run approvals:reject -- <actionId>');
    process.exit(1);
  }

  const action = defaultActionStore.getAction(actionId);
  if (!action) {
    console.error(`Error: Action with ID "${actionId}" was not found.`);
    process.exit(1);
  }

  const actor = process.env.USER || process.env.LOGNAME || 'cli';
  const rejection: ApprovalRecord = {
    decision: 'rejected',
    approvedBy: actor,
    approvedAt: new Date().toISOString(),
    approvalSource: 'cli',
    notes: 'Rejected via CLI',
  };

  try {
    const updated = defaultActionStore.rejectAction(actionId, rejection);
    console.log('\n==============================================');
    console.log('               ACTION REJECTED                ');
    console.log('==============================================');
    console.log(`Action ID:   ${updated.actionId}`);
    console.log(`Status:      ${updated.status}`);
    console.log(`Subject:     ${updated.subject}`);
    console.log(`Rejected By: ${actor} (via cli)`);
    console.log('\nRejection recorded in persistent store and audit event log.\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFailed to reject action: ${msg}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'list':
      await handleList(args.slice(1));
      break;
    case 'approve':
      await handleApprove(args[1]);
      break;
    case 'reject':
      await handleReject(args[1]);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      if (!command) {
        await handleList([]);
      } else {
        console.error(`Unknown command: "${command}"`);
        printHelp();
        process.exit(1);
      }
      break;
  }
}

main().catch((err) => {
  console.error('Unexpected CLI error:', err);
  process.exit(1);
});
