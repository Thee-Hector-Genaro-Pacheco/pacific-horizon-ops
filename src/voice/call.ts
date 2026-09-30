import 'dotenv/config';
import { defaultActionStore } from '../actions/store.js';
import { defaultVoiceStore } from './store.js';
import { getTwilioClient, initiateTwilioCall, formatTwilioRestError } from './twilio.js';
import { maskPhoneNumber } from './types.js';

function printUsage(): void {
  console.log(`
Pacific Rising Ops - Voice Call CLI (PHRO-003)

Usage:
  npm run voice:call -- <actionId> [--dry-run]
  npm run voice:sessions [--all]

Options:
  --dry-run    Validates action and parameters without dialing Twilio
  --all        List all sessions regardless of status
`);
}

export async function executeVoiceCall(actionId: string, isDryRun: boolean): Promise<void> {
  console.log('\n==============================================');
  console.log('       PHRO Voice Operations Agent (Call)     ');
  console.log('==============================================');
  if (isDryRun) {
    console.log(' [MODE] DRY-RUN enabled (no actual call will be placed)\n');
  }

  // 1. Require valid actionId
  if (!actionId || actionId.startsWith('--')) {
    console.error('Error: You must provide a valid actionId.');
    printUsage();
    process.exit(1);
  }

  // 2. Fetch action and verify eligibility
  const action = defaultActionStore.getAction(actionId);
  if (!action) {
    console.error(`Error: Action with ID "${actionId}" was not found in actions.json.`);
    process.exit(1);
  }

  // 3. Only AWAITING_APPROVAL actions are eligible
  if (action.status !== 'AWAITING_APPROVAL') {
    console.error(
      `Error: Action "${actionId}" is in status "${action.status}". ` +
      'Only actions currently in "AWAITING_APPROVAL" can be called about.'
    );
    process.exit(1);
  }

  // 4. Strict phone number enforcement:
  // Destination MUST strictly come from PHRO_OWNER_PHONE_E164
  const toPhone = process.env.PHRO_OWNER_PHONE_E164;
  if (!toPhone) {
    console.error('Error: PHRO_OWNER_PHONE_E164 must be configured in environment.');
    process.exit(1);
  }

  // Caller ID MUST strictly come from TWILIO_PHONE_NUMBER_E164
  const fromPhone = process.env.TWILIO_PHONE_NUMBER_E164;
  if (!fromPhone) {
    console.error('Error: TWILIO_PHONE_NUMBER_E164 must be configured in environment.');
    process.exit(1);
  }

  console.log(`Target Action: ${action.actionId}`);
  console.log(`Subject:       "${action.subject}"`);
  console.log(`From:          ${action.from}`);
  console.log(`Category:      ${action.classificationCategory}`);
  console.log(`Destination:   ${maskPhoneNumber(toPhone)} (PHRO_OWNER_PHONE_E164)`);
  console.log(`Caller ID:     ${maskPhoneNumber(fromPhone)} (TWILIO_PHONE_NUMBER_E164)`);

  if (isDryRun) {
    console.log('\n[DRY-RUN VALIDATION SUCCESSFUL]');
    console.log('Action is eligible for voice call.');
    console.log('Safeguards confirmed:');
    console.log('  - Destination locked to PHRO_OWNER_PHONE_E164');
    console.log('  - Caller ID locked to TWILIO_PHONE_NUMBER_E164');
    console.log('  - No call placed to Twilio');
    console.log('  - No changes made to action or approval state.\n');
    return;
  }

  // Live call validation
  const publicBaseUrl = process.env.PHRO_PUBLIC_BASE_URL;
  if (!publicBaseUrl) {
    console.error(
      '\nError: PHRO_PUBLIC_BASE_URL must be defined for live Twilio webhook callbacks.'
    );
    console.error('Ensure your tunnel (e.g. ngrok) or public server is running and configured.');
    process.exit(1);
  }

  // Create voice session record
  const session = defaultVoiceStore.createSession({
    actionId: action.actionId,
    toPhone,
    fromPhone,
  });

  console.log(`\nCreated VoiceSession: ${session.sessionId}`);
  console.log('Initiating Twilio outbound call...');

  try {
    const twilioClient = getTwilioClient();
    const twimlUrl = `${publicBaseUrl.replace(/\/$/, '')}/voice/twiml?sessionId=${session.sessionId}`;
    const statusCallbackUrl = `${publicBaseUrl.replace(/\/$/, '')}/voice/status?sessionId=${session.sessionId}`;

    const callSid = await initiateTwilioCall({
      client: twilioClient,
      to: toPhone,
      from: fromPhone,
      twimlUrl,
      statusCallbackUrl,
    });

    defaultVoiceStore.updateSessionStatus(session.sessionId, 'CALL_REQUESTED', {
      callSid,
      reason: 'Twilio call successfully initiated',
    });

    console.log(`\nCall successfully requested!`);
    console.log(`Call SID:   ${callSid}`);
    console.log(`Session ID: ${session.sessionId}`);
    console.log('Awaiting connection via ConversationRelay...\n');
  } catch (err: unknown) {
    const twilioError = formatTwilioRestError(err);
    const failureMsg = twilioError
      ? twilioError.message
      : err instanceof Error
      ? err.message
      : String(err);

    defaultVoiceStore.updateSessionStatus(session.sessionId, 'FAILED', {
      error: failureMsg,
      reason: 'Twilio call creation failed',
    });

    console.error(`\nFailed to initiate Twilio call: ${failureMsg}`);
    if (twilioError) {
      console.error('Twilio Error Details:');
      if (twilioError.status !== undefined) console.error(`  Status:    ${twilioError.status}`);
      if (twilioError.code !== undefined) console.error(`  Code:      ${twilioError.code}`);
      console.error(`  Message:   ${twilioError.message}`);
      if (twilioError.moreInfo) console.error(`  More Info: ${twilioError.moreInfo}`);
    }
    console.error('');
    process.exit(1);
  }
}

export function listSessionsCLI(showAll: boolean): void {
  const sessions = defaultVoiceStore.listSessions(
    showAll ? undefined : { status: 'ACTIVE' }
  );

  console.log('\n==============================================');
  console.log(
    showAll
      ? '               ALL VOICE SESSIONS             '
      : '             ACTIVE VOICE SESSIONS            '
  );
  console.log('==============================================\n');

  if (sessions.length === 0) {
    console.log('No sessions found.\n');
    return;
  }

  const rows = sessions.map((s) => ({
    'Session ID': s.sessionId,
    'Action ID': s.actionId,
    Status: s.status,
    'Conv. State': s.conversationState,
    'Call SID': s.callSid || 'N/A',
    Created: new Date(s.createdAt).toLocaleTimeString(),
  }));

  console.table(rows);
  console.log(`Total: ${sessions.length} session(s)\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('sessions')) {
    const showAll = args.includes('--all');
    listSessionsCLI(showAll);
    return;
  }

  const isDryRun = args.includes('--dry-run');
  const actionId = args.find((a) => !a.startsWith('--') && a !== 'call');

  if (!actionId) {
    printUsage();
    process.exit(1);
  }

  await executeVoiceCall(actionId, isDryRun);
}

// Only execute directly when run from CLI
if (process.argv[1]?.endsWith('call.ts') || process.argv[1]?.endsWith('call.js')) {
  main().catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });
}
