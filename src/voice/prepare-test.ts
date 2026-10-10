import 'dotenv/config';
import { getAuthenticatedClient, getExpectedAccount, getAuthenticatedEmail } from '../auth.js';
import { createDraft, getReplyDraft } from '../gmail.js';
import { defaultActionStore } from '../actions/store.js';

export async function prepareVoiceSendTest(): Promise<{
  actionId: string;
  title: string;
  state: string;
  draftId: string;
  threadId: string;
  recipientBound: boolean;
  draftBindingPassed: boolean;
}> {
  // 1. Authenticate with business Gmail profile
  const auth = await getAuthenticatedClient('business');
  const authenticatedEmail = await getAuthenticatedEmail(auth);
  const expectedEmail = getExpectedAccount('business');

  if (expectedEmail && authenticatedEmail.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new Error(
      `Account mismatch: Authenticated account does not match configured business account.`
    );
  }

  const subject = 'PHRO Voice Send Test';
  const bodyText =
    'This is a controlled Pacific Rising Ops voice approval test. If you received this message, the voice-to-Gmail execution pipeline completed successfully.';

  // 2. Check for pre-existing awaiting-approval test action
  const existingActions = defaultActionStore.listActions({ status: 'AWAITING_APPROVAL' });
  const existing = existingActions.find(
    (a) => a.subject === subject && a.from.toLowerCase().includes(authenticatedEmail.toLowerCase())
  );

  let draftId: string;
  let threadId: string;
  let messageId: string;
  let actionId: string;

  if (existing && existing.draftId) {
    // Verify existing draft still exists in Gmail
    const liveDraft = await getReplyDraft(auth, existing.draftId);
    if (liveDraft) {
      draftId = existing.draftId;
      threadId = existing.threadId;
      messageId = existing.messageId;
      actionId = existing.actionId;
    } else {
      // Draft expired/removed in Gmail, create fresh draft
      const created = await createDraft(auth, {
        to: authenticatedEmail,
        subject,
        bodyText,
      });
      draftId = created.draftId;
      threadId = created.threadId || `thread_${Date.now()}`;
      messageId = created.messageId || `msg_${Date.now()}`;

      const { action } = defaultActionStore.createDraftAction({
        messageId,
        threadId,
        draftId,
        subject,
        from: authenticatedEmail,
        classificationCategory: 'voice_test',
        confidence: 1.0,
        draftReply: bodyText,
      });
      actionId = action.actionId;
    }
  } else {
    // 3. Create harmless Gmail draft addressed ONLY to owner's business email
    const created = await createDraft(auth, {
      to: authenticatedEmail,
      subject,
      bodyText,
    });
    draftId = created.draftId;
    threadId = created.threadId || `thread_${Date.now()}`;
    messageId = created.messageId || `msg_${Date.now()}`;

    // 4. Register action in ActionStore
    const { action } = defaultActionStore.createDraftAction({
      messageId,
      threadId,
      draftId,
      subject,
      from: authenticatedEmail,
      classificationCategory: 'voice_test',
      confidence: 1.0,
      draftReply: bodyText,
    });
    actionId = action.actionId;
  }

  // 5. Verify draft binding and properties without sending
  const verifiedAction = defaultActionStore.getAction(actionId);
  if (!verifiedAction) {
    throw new Error(`Failed to retrieve action ${actionId} from store.`);
  }

  if (verifiedAction.status !== 'AWAITING_APPROVAL') {
    throw new Error(`Action is in status ${verifiedAction.status}, expected AWAITING_APPROVAL.`);
  }

  const liveDraft = await getReplyDraft(auth, draftId);
  if (!liveDraft) {
    throw new Error(`Gmail draft ${draftId} does not exist in Gmail.`);
  }

  const recipientMatch =
    liveDraft.to.toLowerCase().includes(authenticatedEmail.toLowerCase()) &&
    verifiedAction.from.toLowerCase().includes(authenticatedEmail.toLowerCase());

  const subjectMatch = liveDraft.subject.trim() === subject && verifiedAction.subject === subject;
  const draftIdMatch = verifiedAction.draftId === draftId && liveDraft.draftId === draftId;

  const draftBindingPassed = recipientMatch && subjectMatch && draftIdMatch;

  return {
    actionId: verifiedAction.actionId,
    title: verifiedAction.subject,
    state: verifiedAction.status,
    draftId,
    threadId,
    recipientBound: recipientMatch,
    draftBindingPassed,
  };
}

if (process.argv[1]?.endsWith('prepare-test.ts') || process.argv[1]?.endsWith('prepare-test.js')) {
  prepareVoiceSendTest()
    .then((result) => {
      console.log('\n==============================================');
      console.log('   PHRO LIVE SEND TEST ACTION PREPARED       ');
      console.log('==============================================');
      console.log(`Action Title:          ${result.title}`);
      console.log(`Action ID:             ${result.actionId}`);
      console.log(`State:                 ${result.state}`);
      console.log(`Recipient:             OWNER_BUSINESS_EMAIL`);
      console.log(`Draft Binding:         ${result.draftBindingPassed ? 'PASS' : 'FAIL'}`);
      console.log('==============================================\n');
    })
    .catch((err) => {
      console.error('Failed to prepare voice send test:', err);
      process.exit(1);
    });
}
