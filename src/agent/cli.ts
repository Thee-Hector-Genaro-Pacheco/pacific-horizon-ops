import 'dotenv/config';
import { defaultActionStore } from '../actions/store.js';
import { DEFAULT_ORGANIZATION_ID } from '../knowledge/db.js';
import { GmailApprovalGateway } from './approval.js';
import { AgentHarness } from './harness.js';
import { emptySessionContext } from './session.js';
import { FUTURE_TOOL_CONTRACTS } from './tools.js';
import { MemoryTraceRecorder } from './trace.js';
import { createAgentRequest } from './types.js';

/**
 * Harness diagnostics. Never executes a tool and never prints context content:
 *
 *   npm run agent:inspect -- "Do I have any conflicts Saturday?"
 *   npm run agent:tools
 */
async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const harness = new AgentHarness({ approvals: [new GmailApprovalGateway(defaultActionStore)], recorder: new MemoryTraceRecorder() });

  if (command === 'tools') {
    console.log('\nRegistered tools:');
    for (const t of harness.registry.list()) {
      console.log(`  ${t.id.padEnd(24)} effect=${t.effect.padEnd(8)} risk=${t.risk.padEnd(8)} approval=${t.approvalPolicy.padEnd(22)} ${t.implementation ? 'executable' : 'legacy lifecycle'}`);
    }
    console.log('\nFuture contracts (documentation only, not registrable):');
    for (const c of FUTURE_TOOL_CONTRACTS) console.log(`  ${c.id.padEnd(24)} effect=${c.effect.padEnd(8)} risk=${c.risk.padEnd(8)} approval=${c.approvalPolicy}`);
    console.log('');
    return;
  }

  if (command === 'inspect') {
    const input = rest.join(' ').trim();
    if (!input) throw new Error('Usage: npm run agent:inspect -- "<question>"');
    const request = createAgentRequest({ sessionId: 'inspect', organizationId: DEFAULT_ORGANIZATION_ID, channel: 'api', actor: { kind: 'owner', id: 'owner' }, input });
    const report = await harness.inspect(request, emptySessionContext('inspect', DEFAULT_ORGANIZATION_ID, 'api'));
    console.log(`\nIntent:    ${report.intent.intent} (domain ${report.intent.domain}, ${report.intent.source}${report.intent.highRisk ? ', HIGH RISK' : ''})`);
    console.log(`Scope:     ${report.intent.requestedScope === null ? 'default' : JSON.stringify(report.intent.requestedScope)}`);
    console.log(`Providers: ${report.plan.providers.join(', ') || '(none)'} · completeness ${report.plan.requiredCompleteness}`);
    console.log(`Tools:     ${report.toolsConsidered.join(', ') || '(none)'}`);
    for (const p of report.policy) console.log(`  ${p.toolId}: effect=${p.effect} risk=${p.risk} -> ${p.decision} (${p.reason})`);
    console.log(`Executes via harness: ${report.executes ? 'yes (read-only)' : 'no (classified only; lifecycle stays with its domain flow)'}`);
    console.log('Dry run: nothing was executed.\n');
    return;
  }

  console.log('Commands: inspect "<question>" | tools');
}

if (process.argv[1]?.endsWith('agent/cli.ts') || process.argv[1]?.endsWith('agent/cli.js')) {
  main().catch((err) => {
    console.error(`\nAgent CLI Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
