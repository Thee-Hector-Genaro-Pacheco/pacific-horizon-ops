import { type ActionRecord } from '../actions/types.js';
import { type ActionStore, defaultActionStore } from '../actions/store.js';
import { type VoiceSession } from './types.js';
import { type VoiceStore, defaultVoiceStore } from './store.js';
import { classifyVoiceIntent } from './intents.js';

export interface ConversationTurnResult {
  responseText: string;
  endCall: boolean;
}

/**
 * Deterministic confirmation phrase matcher.
 * Permits strictly explicit phrases; NEVER accepts "yes", "sure", "okay", etc.
 */
export function isConfirmationPhrase(utterance: string, type: 'approval' | 'rejection'): boolean {
  const norm = utterance.toLowerCase().trim().replace(/[.,!?;:]/g, '');
  if (type === 'approval') {
    return norm === 'confirm approval' || norm === 'confirm the approval';
  } else {
    return norm === 'confirm rejection' || norm === 'confirm the rejection';
  }
}

/**
 * Checks for explicit cancellation during confirmation steps
 */
function isCancellationPhrase(utterance: string): boolean {
  const norm = utterance.toLowerCase().trim().replace(/[.,!?;:]/g, '');
  return (
    norm === 'cancel' ||
    norm === 'abort' ||
    norm === 'no' ||
    norm === 'stop' ||
    norm === 'go back' ||
    norm === 'never mind'
  );
}

/**
 * Generates the initial greeting when ConversationRelay connects
 */
export function getInitialGreeting(action: ActionRecord): string {
  return (
    `Hello! This is Horizon from Pacific Horizon Labs with an email draft awaiting your approval. ` +
    `It is from ${action.from}, subject: "${action.subject}". ` +
    `You can say: summary, read draft, approve, reject, or help.`
  );
}

/**
 * Formats the summary using persisted action and classification data
 */
export function getSummaryText(action: ActionRecord): string {
  const confidencePct = (action.confidence * 100).toFixed(0);
  return (
    `Here is the summary. Incoming message from ${action.from}. ` +
    `Subject: "${action.subject}". ` +
    `Category: ${action.classificationCategory} (${confidencePct}% confidence). ` +
    `Would you like to hear the draft reply, approve, or reject?`
  );
}

/**
 * Reads the exact persisted draftReply without regenerating or altering text
 */
export function getDraftText(action: ActionRecord): string {
  const draftReply =
    (action.proposedAction.payload?.draftReply as string) ||
    '(No draft reply content found on record)';
  return `Here is the proposed draft reply: ${draftReply}. Would you like to approve, reject, or hear the summary again?`;
}

/**
 * Handles a caller's spoken utterance within a VoiceSession
 */
export async function handleVoiceUtterance(params: {
  session: VoiceSession;
  utterance: string;
  voiceStore?: VoiceStore;
  actionStore?: ActionStore;
}): Promise<ConversationTurnResult> {
  const voiceStore = params.voiceStore || defaultVoiceStore;
  const actionStore = params.actionStore || defaultActionStore;
  const { session, utterance } = params;

  // Record caller transcript
  voiceStore.appendTranscript(session.sessionId, {
    role: 'user',
    text: utterance,
    timestamp: new Date().toISOString(),
  });

  // Verify the action exists and fetch fresh state
  const action = actionStore.getAction(session.actionId);
  if (!action) {
    const responseText = 'Error: The associated action record could not be found. Ending call.';
    voiceStore.updateSessionStatus(session.sessionId, 'FAILED', {
      error: `Action ${session.actionId} not found during voice handling`,
      actor: 'voice:conversation',
    });
    return { responseText, endCall: true };
  }

  // Two-step Confirmation: AWAITING_APPROVAL_CONFIRMATION
  if (session.conversationState === 'AWAITING_APPROVAL_CONFIRMATION') {
    if (isConfirmationPhrase(utterance, 'approval')) {
      // Fail closed if state changed during call
      if (action.status !== 'AWAITING_APPROVAL') {
        const responseText = `Action state changed to ${action.status} during this call. Approval was not applied. Ending call.`;
        voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
          lastSpokenText: responseText,
          reason: 'Action status conflict',
        });
        return { responseText, endCall: true };
      }

      actionStore.approveAction(action.actionId, {
        decision: 'approved',
        approvedBy: 'owner_voice',
        approvedAt: new Date().toISOString(),
        approvalSource: 'voice',
        notes: 'Confirmed and approved via Twilio voice call',
      });

      const responseText = 'Approval confirmed. The action is now marked approved. No email has been sent. Goodbye!';
      voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
        lastSpokenText: responseText,
        reason: 'Voice approval confirmed',
      });
      return { responseText, endCall: true };
    }

    if (isCancellationPhrase(utterance)) {
      const responseText = 'Approval cancelled. The draft remains awaiting approval. What would you like to do next?';
      voiceStore.updateConversationState(session.sessionId, 'READY', {
        lastSpokenText: responseText,
        reason: 'Approval confirmation cancelled by user',
      });
      return { responseText, endCall: false };
    }

    // Explicit rejection of fuzzy approval words
    const responseText =
      'Approval was not confirmed. To confirm approval of this draft, please say "confirm approval", or say "cancel" to return.';
    voiceStore.updateConversationState(session.sessionId, 'AWAITING_APPROVAL_CONFIRMATION', {
      lastSpokenText: responseText,
      reason: 'Unconfirmed approval response',
    });
    return { responseText, endCall: false };
  }

  // Two-step Confirmation: AWAITING_REJECTION_CONFIRMATION
  if (session.conversationState === 'AWAITING_REJECTION_CONFIRMATION') {
    if (isConfirmationPhrase(utterance, 'rejection')) {
      // Fail closed if state changed during call
      if (action.status !== 'AWAITING_APPROVAL') {
        const responseText = `Action state changed to ${action.status} during this call. Rejection was not applied. Ending call.`;
        voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
          lastSpokenText: responseText,
          reason: 'Action status conflict',
        });
        return { responseText, endCall: true };
      }

      actionStore.rejectAction(action.actionId, {
        decision: 'rejected',
        approvedBy: 'owner_voice',
        approvedAt: new Date().toISOString(),
        approvalSource: 'voice',
        notes: 'Confirmed and rejected via Twilio voice call',
      });

      const responseText = 'Rejection confirmed. The action is now marked rejected. Goodbye!';
      voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
        lastSpokenText: responseText,
        reason: 'Voice rejection confirmed',
      });
      return { responseText, endCall: true };
    }

    if (isCancellationPhrase(utterance)) {
      const responseText = 'Rejection cancelled. The draft remains awaiting approval. What would you like to do next?';
      voiceStore.updateConversationState(session.sessionId, 'READY', {
        lastSpokenText: responseText,
        reason: 'Rejection confirmation cancelled by user',
      });
      return { responseText, endCall: false };
    }

    const responseText =
      'Rejection was not confirmed. To confirm rejection of this draft, please say "confirm rejection", or say "cancel" to return.';
    voiceStore.updateConversationState(session.sessionId, 'AWAITING_REJECTION_CONFIRMATION', {
      lastSpokenText: responseText,
      reason: 'Unconfirmed rejection response',
    });
    return { responseText, endCall: false };
  }

  // Classify intent for normal states
  const { intent } = await classifyVoiceIntent(utterance, session.conversationState);

  switch (intent) {
    case 'SUMMARY': {
      const responseText = getSummaryText(action);
      voiceStore.updateConversationState(session.sessionId, 'READING_SUMMARY', {
        lastSpokenText: responseText,
        reason: 'Reading action summary',
      });
      return { responseText, endCall: false };
    }

    case 'READ_DRAFT': {
      const responseText = getDraftText(action);
      voiceStore.updateConversationState(session.sessionId, 'READING_DRAFT', {
        lastSpokenText: responseText,
        reason: 'Reading stored draft text',
      });
      return { responseText, endCall: false };
    }

    case 'REPEAT': {
      const responseText = session.lastSpokenText || getInitialGreeting(action);
      return { responseText, endCall: false };
    }

    case 'APPROVE': {
      if (action.status !== 'AWAITING_APPROVAL') {
        const responseText = `This action is currently ${action.status} and cannot be approved.`;
        voiceStore.updateConversationState(session.sessionId, 'READY', {
          lastSpokenText: responseText,
        });
        return { responseText, endCall: false };
      }
      const responseText = 'To confirm approval of this draft, say "confirm approval".';
      voiceStore.updateConversationState(session.sessionId, 'AWAITING_APPROVAL_CONFIRMATION', {
        lastSpokenText: responseText,
        reason: 'Initiated two-step approval confirmation',
      });
      return { responseText, endCall: false };
    }

    case 'REJECT': {
      if (action.status !== 'AWAITING_APPROVAL') {
        const responseText = `This action is currently ${action.status} and cannot be rejected.`;
        voiceStore.updateConversationState(session.sessionId, 'READY', {
          lastSpokenText: responseText,
        });
        return { responseText, endCall: false };
      }
      const responseText = 'To confirm rejection of this draft, say "confirm rejection".';
      voiceStore.updateConversationState(session.sessionId, 'AWAITING_REJECTION_CONFIRMATION', {
        lastSpokenText: responseText,
        reason: 'Initiated two-step rejection confirmation',
      });
      return { responseText, endCall: false };
    }

    case 'HELP': {
      const responseText =
        'You can say: "summary" to hear email details, "read draft" to hear the draft reply, "approve" to approve, "reject" to reject, "repeat" to hear that again, or "end call" to hang up.';
      voiceStore.updateConversationState(session.sessionId, 'READY', {
        lastSpokenText: responseText,
      });
      return { responseText, endCall: false };
    }

    case 'END_CALL': {
      const responseText = 'Understood. Goodbye!';
      voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
        lastSpokenText: responseText,
        reason: 'Caller requested end of call',
      });
      return { responseText, endCall: true };
    }

    case 'UNKNOWN':
    default: {
      const responseText =
        'I did not understand that. You can ask for a summary, ask to read the draft, or say approve or reject.';
      voiceStore.updateConversationState(session.sessionId, 'READY', {
        lastSpokenText: responseText,
      });
      return { responseText, endCall: false };
    }
  }
}
