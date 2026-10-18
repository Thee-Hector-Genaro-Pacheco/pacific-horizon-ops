import 'dotenv/config';
import { PhotoBoothAnalyticsClient, isValidEventId } from './client.js';
import { answerPhotoBoothQuestion } from './agent.js';
import { describeEventSummary } from './semantics.js';

function printHelp(): void {
  console.log(`
Pacific Rising Ops - Photo Booth Analytics CLI (read-only)

Commands:
  ask        Ask the agent a natural-language Photo Booth question (uses Claude + analytics tools)
             Usage: npm run photobooth:ask -- "How did the latest photo booth event perform?"
             Options:
               --trace   Print which analytics tools were called

  report     Print the deterministic event summary report (no LLM involved)
             Usage: npm run photobooth:report [-- <eventId>]
             Defaults to the latest event when no eventId is given.

Requires PHOTO_BOOTH_REPORTING_API_KEY in .env. The key is never printed.
`);
}

async function handleAsk(args: string[]): Promise<void> {
  const trace = args.includes('--trace');
  const question = args.filter((a) => a !== '--trace').join(' ').trim();
  if (!question) {
    console.error('Please provide a question, e.g. npm run photobooth:ask -- "How did the latest event go?"');
    process.exit(1);
  }

  const analytics = PhotoBoothAnalyticsClient.fromEnv();
  const result = await answerPhotoBoothQuestion(question, { analytics });

  if (trace) {
    console.log('\nTool calls:');
    for (const call of result.toolCalls) {
      console.log(`  - ${call.name} ${JSON.stringify(call.input)} -> ${call.ok ? 'ok' : 'error'}${call.cached ? ' (cached)' : ''}`);
    }
    console.log(`Answer source: ${result.source}`);
    if (result.semanticViolations.length > 0) {
      console.log(`Semantic flags: ${result.semanticViolations.map((v) => `${v.rule} "${v.match}"`).join('; ')}`);
    }
  }
  console.log(`\n${result.answer}\n`);
}

async function handleReport(eventIdArg: string | undefined): Promise<void> {
  const analytics = PhotoBoothAnalyticsClient.fromEnv();

  let eventId = eventIdArg;
  if (!eventId) {
    const latest = await analytics.latestEvent();
    if (!latest.eventId) {
      console.log('\nNo booth activity has been recorded yet.\n');
      return;
    }
    eventId = latest.eventId;
  } else if (!isValidEventId(eventId)) {
    console.error('eventId must be a Photo Booth event UUID.');
    process.exit(1);
  }

  const summary = await analytics.eventSummary(eventId);
  console.log(`\n${describeEventSummary(summary)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'ask':
      await handleAsk(args.slice(1));
      break;
    case 'report':
      await handleReport(args[1]);
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
        console.error(`Unknown photobooth command: "${command}"`);
        printHelp();
        process.exit(1);
      }
      break;
  }
}

if (process.argv[1]?.endsWith('photobooth/cli.ts') || process.argv[1]?.endsWith('photobooth/cli.js')) {
  main().catch((err) => {
    console.error('\nPhoto Booth CLI Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
