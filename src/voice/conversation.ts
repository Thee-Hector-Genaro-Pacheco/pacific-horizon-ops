import { type ActionRecord } from '../actions/types.js';
import { isTerminalStatus } from '../actions/transitions.js';
import { type ActionStore, defaultActionStore } from '../actions/store.js';
import { type ActionExecutor, defaultActionExecutor } from '../actions/executor.js';
import { type VoiceSession, type VoiceConversationState, VoiceConversationStateSchema } from './types.js';
import { type VoiceStore, defaultVoiceStore } from './store.js';
import { classifyVoiceIntent } from './intents.js';
import {
  type EligibleInboxMessage,
  parseMessageSelection,
  generateDraftReply,
  classifyInboxMessage,
  type MessageClassificationResult,
} from './mailbox.js';
import { createReplyDraft, type EmailMessage } from '../gmail.js';
import { getAuthenticatedClient, getExpectedAccount } from '../auth.js';
import {
  PHOTO_BOOTH_MAILBOX_COMMAND_GUIDANCE,
  PHOTO_BOOTH_PROGRESS_TEXT,
  PHOTO_BOOTH_VOICE_HELP,
  askPhotoBoothForVoice,
  isMailboxActionCommand,
  isReturnToInboxRequest,
  normalizeUtterance,
  type PhotoBoothVoiceContext,
  type PhotoBoothVoiceDeps,
} from './analytics.js';
import {
  CALENDAR_MAILBOX_COMMAND_GUIDANCE,
  CALENDAR_PROGRESS_TEXT,
  CALENDAR_VOICE_HELP,
  answerCalendarQuestion,
  routeReadDomain,
  type CalendarVoiceContext,
  type CalendarVoiceDeps,
} from './calendar.js';
import {
  EMAIL_MAILBOX_COMMAND_GUIDANCE,
  EMAIL_PROGRESS_TEXT,
  EMAIL_READ_HELP,
  READ_ONLY_DRAFT_TEXT,
  answerEmailQuestion,
  draftRefusalFor,
  emailProfiles,
  isDraftCommand,
  isEmailReadRequest,
  type EmailVoiceContext,
  type EmailVoiceDeps,
} from './email.js';
import {
  KNOWLEDGE_MAILBOX_COMMAND_GUIDANCE,
  KNOWLEDGE_PROGRESS_TEXT,
  KNOWLEDGE_VOICE_HELP,
  answerKnowledgeForVoice,
  isKnowledgeRequest,
  type KnowledgeVoiceDeps,
} from './knowledge.js';

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
/** Phrases asking Pacific Ops to say its last line again. Never matches approval words. */
export function isRepeatRequest(norm: string): boolean {
  return (
    norm === 'repeat' ||
    norm === 'again' ||
    norm === 'repeat that' ||
    norm === 'repeat it' ||
    norm === 'say that again' ||
    norm === 'say it again' ||
    norm === 'one more time' ||
    norm === 'come again' ||
    norm === 'what did you say' ||
    norm === 'pardon' ||
    norm === 'sorry' ||
    norm.startsWith('can you repeat') ||
    norm.startsWith('could you repeat') ||
    norm.startsWith('please repeat')
  );
}

/** What the owner can do next with the selected message, depending on whether a draft exists. */
function mailboxNextSteps(hasDraft: boolean): string {
  return hasDraft
    ? 'You can say approve, read the draft again, summarize the email again, or go back.'
    : 'You can say draft a response, read more, or go back.';
}

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
  executor?: ActionExecutor;
  /** Speaks text before the turn finishes. `stillWorking` means the request is still being handled. */
  onProgress?: (text: string, opts?: { stillWorking?: boolean }) => void;
  /** Read-only Photo Booth analytics dependencies (mocked in tests). */
  photoBooth?: PhotoBoothVoiceDeps;
  /** Read-only Google Calendar dependencies (mocked in tests). */
  calendar?: CalendarVoiceDeps;
  /** Read-only multi-inbox dependencies (mocked in tests). */
  email?: EmailVoiceDeps;
  /** Read-only company-knowledge dependencies (mocked in tests). */
  knowledge?: KnowledgeVoiceDeps;
  draftCreator?: (params: {
    to: string;
    subject: string;
    bodyText: string;
    threadId?: string;
  }) => Promise<{ draftId: string; messageId?: string; threadId?: string }>;
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

  // Photo Booth analytics and Calendar are separate read-only domains. Neither is ever
  // entered from a pending approval/rejection confirmation, so two-step confirmation stays strict.
  const domain: DomainTurnArgs = {
    session,
    utterance,
    voiceStore,
    actionStore,
    onProgress: params.onProgress,
    photoBooth: params.photoBooth,
    calendar: params.calendar,
    email: params.email,
    knowledge: params.knowledge,
  };
  if (READ_DOMAIN_STATES.has(session.conversationState)) {
    return handleReadDomainTurn(domain);
  }
  if (!ANALYTICS_BLOCKED_STATES.has(session.conversationState)) {
    // Company-knowledge questions ("what is our policy...") first: they may mention the booth or events.
    if (isKnowledgeRequest(normalizeUtterance(utterance))) return askKnowledgeDomain(domain);
    if (isEmailReadRequest(normalizeUtterance(utterance), emailProfiles(params.email))) return askEmail(domain);
    const route = routeReadDomain(normalizeUtterance(utterance));
    if (route === 'calendar') return askCalendar(domain);
    if (route === 'photo_booth') return askPhotoBooth(domain);
  }

  const isMailboxMode =
    session.actionId === 'mailbox' ||
    session.conversationState === 'MAILBOX_SELECTING' ||
    session.metadata?.mode === 'mailbox';

  if (isMailboxMode) {
    const availableMessages = (session.metadata?.availableMessages as EligibleInboxMessage[]) || [];
    const selectedMessage = session.metadata?.selectedMessage as EligibleInboxMessage | undefined;
    const norm = utterance.toLowerCase().trim().replace(/[.,!?;:]/g, '');

    // 1. If currently in MAILBOX_SELECTING
    if (session.conversationState === 'MAILBOX_SELECTING') {
      if (norm === 'bye' || norm === 'goodbye' || norm === 'hang up' || norm === 'end call') {
        const responseText = 'Understood. Goodbye!';
        voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
          lastSpokenText: responseText,
          reason: 'Caller ended call',
        });
        return { responseText, endCall: true };
      }

      if (isRepeatRequest(norm) && session.lastSpokenText) {
        const responseText = session.lastSpokenText;
        voiceStore.updateConversationState(session.sessionId, 'MAILBOX_SELECTING', {
          lastSpokenText: responseText,
          reason: 'Repeated last response at owner request',
        });
        return { responseText, endCall: false };
      }

      const selection = parseMessageSelection(utterance);
      if (selection !== null) {
        const chosen = availableMessages.find((m) => m.index === selection);
        if (chosen) {
          const classification = classifyInboxMessage(chosen);
          const summary = chosen.snippet || chosen.body.slice(0, 150).replace(/\s+/g, ' ');
          const automatedNote = classification.isAutomatedNoise
            ? ` Note: this appears to be an automated ${classification.category === 'newsletter_promo' ? 'newsletter' : 'system notification'}.`
            : '';
          const responseText = `Selected message ${chosen.index} from ${chosen.senderName} about "${chosen.subject}".${automatedNote} Summary: ${summary}. What would you like to do? You can say draft a response, read more, or go back.`;
          voiceStore.updateSessionMetadata(session.sessionId, {
            ...session.metadata,
            mode: 'mailbox',
            selectedMessage: chosen,
            selectedMessageIndex: chosen.index,
            selectedMessageClassification: classification,
            boundActionId: null,
            draftReply: null,
            draftId: null,
          });
          voiceStore.updateConversationState(session.sessionId, 'READY', {
            lastSpokenText: responseText,
            reason: `Selected message ${chosen.index}`,
          });
          return { responseText, endCall: false };
        } else {
          const countWords = ['zero', 'one', 'two', 'three'];
          const countStr = countWords[availableMessages.length] || String(availableMessages.length);
          const responseText = `I only found ${countStr} messages. Please choose message one${availableMessages.length > 1 ? ` or message two${availableMessages.length > 2 ? ' or message three' : ''}` : ''}.`;
          voiceStore.updateConversationState(session.sessionId, 'MAILBOX_SELECTING', {
            lastSpokenText: responseText,
          });
          return { responseText, endCall: false };
        }
      }

      if (norm === 'help' || norm.includes('options') || norm.includes('what can i say')) {
        const responseText =
          'You can say "message one", "message two", or "message three" to select an email to review, or say "hang up" to end the call.';
        voiceStore.updateConversationState(session.sessionId, 'MAILBOX_SELECTING', {
          lastSpokenText: responseText,
        });
        return { responseText, endCall: false };
      }

      const responseText =
        'Please choose which message you would like to review: message one, message two, or message three.';
      voiceStore.updateConversationState(session.sessionId, 'MAILBOX_SELECTING', {
        lastSpokenText: responseText,
      });
      return { responseText, endCall: false };
    }

    // 2. A message IS selected (session.conversationState !== 'MAILBOX_SELECTING')
    // Check if in AWAITING_APPROVAL_CONFIRMATION
    if (session.conversationState === 'AWAITING_APPROVAL_CONFIRMATION') {
      const boundActionId = (session.metadata?.boundActionId as string) || (session.actionId !== 'mailbox' ? session.actionId : null);
      const boundAction = boundActionId ? actionStore.getAction(boundActionId) : null;

      if (!boundAction) {
        const responseText = 'Error: The draft action for this message could not be found. Ending call.';
        voiceStore.updateSessionStatus(session.sessionId, 'FAILED', {
          error: 'Bound action not found during confirmation',
        });
        return { responseText, endCall: true };
      }

      if (isConfirmationPhrase(utterance, 'approval')) {
        if (boundAction.status !== 'AWAITING_APPROVAL') {
          const responseText = `Action state changed to ${boundAction.status} during this call. Approval was not applied. Ending call.`;
          voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
            lastSpokenText: responseText,
            reason: 'Action status conflict',
          });
          return { responseText, endCall: true };
        }

        const confirmCheck = checkBoundDraft(session, actionStore);
        if (!confirmCheck.ok) {
          return refuseIneligibleDraft(session, voiceStore, 'confirm approval', confirmCheck);
        }

        actionStore.approveAction(boundAction.actionId, {
          decision: 'approved',
          approvedBy: 'owner_voice',
          approvedAt: new Date().toISOString(),
          approvalSource: 'voice',
          notes: 'Confirmed and approved via Twilio voice call',
        });

        if (params.executor) {
          if (params.onProgress) {
            params.onProgress('Approval confirmed. Sending the email now.');
          }

          const execResult = await params.executor.executeApprovedAction(boundAction.actionId, {
            actor: 'voice:owner_voice',
            approvalSource: 'voice',
            actionStore,
          });

          if (execResult.success) {
            const responseText = 'Approval confirmed. The email has been sent successfully. Goodbye!';
            voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
              lastSpokenText: responseText,
              reason: 'Voice approval confirmed and email sent successfully',
            });
            return { responseText, endCall: true };
          } else {
            const responseText =
              "Your approval was recorded, but I wasn't able to send the email. The message has not been marked as sent. Goodbye!";
            voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
              lastSpokenText: responseText,
              reason: `Voice approval confirmed but email send failed: ${execResult.error}`,
            });
            return { responseText, endCall: true };
          }
        }

        const responseText = 'Approval confirmed. The email has been sent successfully. Goodbye!';
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

      const responseText =
        'Approval was not confirmed. To confirm approval of this draft, please say "confirm approval", or say "cancel" to return.';
      voiceStore.updateConversationState(session.sessionId, 'AWAITING_APPROVAL_CONFIRMATION', {
        lastSpokenText: responseText,
        reason: 'Unconfirmed approval response',
      });
      return { responseText, endCall: false };
    }

    // 2b. "repeat" / "say that again": replay the last thing Pacific Ops said, unchanged.
    // (AWAITING_APPROVAL_CONFIRMATION is handled above and never reaches this point.)
    if (isRepeatRequest(norm) && session.lastSpokenText) {
      const responseText = session.lastSpokenText;
      voiceStore.updateConversationState(session.sessionId, session.conversationState, {
        lastSpokenText: responseText,
        reason: 'Repeated last response at owner request',
      });
      return { responseText, endCall: false };
    }

    // 3. User says "hang up" / "goodbye"
    if (norm === 'bye' || norm === 'goodbye' || norm === 'hang up' || norm === 'end call') {
      const responseText = 'Understood. Goodbye!';
      voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
        lastSpokenText: responseText,
        reason: 'Caller ended call',
      });
      return { responseText, endCall: true };
    }

    // 4. Switching message while reviewing (e.g. "message two")
    const switchSelection = parseMessageSelection(utterance);
    if (switchSelection !== null) {
      const newChosen = availableMessages.find((m) => m.index === switchSelection);
      if (newChosen) {
        const classification = classifyInboxMessage(newChosen);
        // Critical: unbind any previous draft/action so it cannot be accidentally sent!
        voiceStore.updateSessionActionId(session.sessionId, 'mailbox', {
          ...session.metadata,
          mode: 'mailbox',
          selectedMessage: newChosen,
          selectedMessageIndex: newChosen.index,
          selectedMessageClassification: classification,
          boundActionId: null,
          draftReply: null,
          draftId: null,
        });
        const summary = newChosen.snippet || newChosen.body.slice(0, 150).replace(/\s+/g, ' ');
        const automatedNote = classification.isAutomatedNoise
          ? ` Note: this appears to be an automated ${classification.category === 'newsletter_promo' ? 'newsletter' : 'system notification'}.`
          : '';
        const responseText = `Switched to message ${newChosen.index} from ${newChosen.senderName} about "${newChosen.subject}".${automatedNote} Summary: ${summary}. What would you like to do? You can say draft a response, read more, or go back.`;
        voiceStore.updateConversationState(session.sessionId, 'READY', {
          lastSpokenText: responseText,
          reason: `Switched to message ${newChosen.index}`,
        });
        return { responseText, endCall: false };
      }
    }

    // 5. "go back" / "next message"
    if (
      norm === 'go back' ||
      norm === 'back' ||
      norm === 'next message' ||
      norm === 'previous message' ||
      norm === 'messages' ||
      norm === 'return'
    ) {
      voiceStore.updateSessionActionId(session.sessionId, 'mailbox', {
        ...session.metadata,
        mode: 'mailbox',
        selectedMessage: null,
        selectedMessageIndex: null,
        boundActionId: null,
        draftReply: null,
        draftId: null,
      });
      const responseText =
        'Returning to your recent emails. You can choose message one, message two, or message three.';
      voiceStore.updateConversationState(session.sessionId, 'MAILBOX_SELECTING', {
        lastSpokenText: responseText,
        reason: 'Returned to message selection',
      });
      return { responseText, endCall: false };
    }

    if (!selectedMessage) {
      const responseText = 'Please select a message first: message one, message two, or message three.';
      voiceStore.updateConversationState(session.sessionId, 'MAILBOX_SELECTING', {
        lastSpokenText: responseText,
      });
      return { responseText, endCall: false };
    }

    // 6. "draft a response" / "draft reply" / "draft response" / "reply"
    if (
      norm.includes('draft a response') ||
      norm.includes('draft response') ||
      norm.includes('draft reply') ||
      norm.includes('prepare a draft') ||
      norm === 'draft' ||
      norm === 'reply'
    ) {
      const classification =
        (session.metadata?.selectedMessageClassification as MessageClassificationResult) ||
        classifyInboxMessage(selectedMessage);

      if (classification && classification.canDraft === false) {
        const responseText = `This message appears to be an automated ${classification.category === 'newsletter_promo' ? 'newsletter' : 'system notification'}, so automated drafting is not supported. You can say 'read more' to hear the message, or say 'go back' to select another email.`;
        voiceStore.updateConversationState(session.sessionId, 'READY', {
          lastSpokenText: responseText,
          reason: 'Draft refused for automated noise message',
        });
        return { responseText, endCall: false };
      }

      // Only the business account drafts. A message from another profile is never drafted
      // here, so it can never bind to a business draft or Action.
      if (selectedMessage.profileId && selectedMessage.profileId !== 'business') {
        voiceStore.updateConversationState(session.sessionId, 'READY', {
          lastSpokenText: READ_ONLY_DRAFT_TEXT,
          reason: `Draft refused: message belongs to read-only profile ${selectedMessage.profileId}`,
        });
        return { responseText: READ_ONLY_DRAFT_TEXT, endCall: false };
      }

      // One open approval lifecycle per email: reuse it rather than creating a second Gmail draft.
      // Terminal actions (SENT, REJECTED, EXECUTION_FAILED, ...) are history and never reused.
      const sessionBound = session.metadata?.boundActionId
        ? actionStore.getAction(session.metadata.boundActionId as string)
        : undefined;
      const open =
        (sessionBound && !isTerminalStatus(sessionBound.status) ? sessionBound : undefined) ??
        actionStore.findOpenActionByMessageAndType(selectedMessage.messageId, 'CREATE_EMAIL_DRAFT');
      if (open) {
        const openDraftId = open.draftId || (open.proposedAction.payload?.draftId as string | undefined);
        const openDraftReply = open.proposedAction.payload?.draftReply as string | undefined;
        if (open.status !== 'AWAITING_APPROVAL' || !openDraftId || typeof openDraftReply !== 'string') {
          console.warn(`[voice:conversation] [session:${session.sessionId}] draft refused: open action ${open.actionId} is ${open.status}`);
          const responseText =
            'A reply to this email is already being processed, so I won\'t create another draft right now. You can say "go back" to choose another message.';
          voiceStore.updateConversationState(session.sessionId, 'READY', {
            lastSpokenText: responseText,
            reason: `Draft refused: open action ${open.actionId} is ${open.status}`,
          });
          return { responseText, endCall: false };
        }
        voiceStore.updateSessionActionId(session.sessionId, open.actionId, {
          ...session.metadata,
          mode: 'mailbox',
          selectedMessage,
          boundActionId: open.actionId,
          draftReply: openDraftReply,
          draftId: openDraftId,
        });
        const responseText = `A draft reply is already waiting for your approval: "${openDraftReply}". ${mailboxNextSteps(true)}`;
        voiceStore.updateConversationState(session.sessionId, 'READY', {
          lastSpokenText: responseText,
          reason: `Bound existing open draft action ${open.actionId}`,
        });
        return { responseText, endCall: false };
      }

      const draftText = generateDraftReply(selectedMessage);
      let draftId = `draft_${Date.now()}`;
      let messageId = selectedMessage.messageId;
      let threadId = selectedMessage.threadId;

      if (params.draftCreator) {
        const res = await params.draftCreator({
          to: selectedMessage.from,
          subject: selectedMessage.subject,
          bodyText: draftText,
          threadId: selectedMessage.threadId,
        });
        draftId = res.draftId;
        messageId = res.messageId || messageId;
        threadId = res.threadId || threadId;
      } else {
        const auth = await getAuthenticatedClient('business');
        const emailMsg: EmailMessage = {
          messageId: selectedMessage.messageId,
          threadId: selectedMessage.threadId,
          from: selectedMessage.from,
          to: getExpectedAccount('business') || '',
          subject: selectedMessage.subject,
          date: selectedMessage.date,
          messageIdHeader: '',
          references: '',
          body: selectedMessage.body,
        };
        draftId = await createReplyDraft(auth, emailMsg, draftText);
      }

      const { action: createdAction, isNew } = actionStore.createDraftAction({
        messageId,
        threadId,
        draftId,
        subject: selectedMessage.subject,
        from: selectedMessage.from,
        classificationCategory: 'booking_inquiry',
        confidence: 1.0,
        draftReply: draftText,
      });

      // Fail closed unless the new Gmail draft is paired with a fresh, approvable action.
      if (!isNew || createdAction.status !== 'AWAITING_APPROVAL' || createdAction.draftId !== draftId) {
        console.error(
          `[voice:conversation] [session:${session.sessionId}] new draft ${draftId} not bound: action ${createdAction.actionId} (${createdAction.status}, isNew=${isNew}, draftId=${createdAction.draftId})`
        );
        voiceStore.updateSessionActionId(session.sessionId, 'mailbox', {
          ...session.metadata,
          mode: 'mailbox',
          selectedMessage,
          boundActionId: null,
          draftReply: null,
          draftId: null,
        });
        const responseText =
          "A Gmail draft was saved, but I couldn't register it for approval, so it can't be sent from this call. Please review it in Gmail.";
        voiceStore.updateConversationState(session.sessionId, 'READY', {
          lastSpokenText: responseText,
          reason: `Draft ${draftId} could not be bound to an approvable action`,
        });
        return { responseText, endCall: false };
      }

      voiceStore.updateSessionActionId(session.sessionId, createdAction.actionId, {
        ...session.metadata,
        mode: 'mailbox',
        selectedMessage,
        boundActionId: createdAction.actionId,
        draftReply: draftText,
        draftId,
      });

      const responseText = `I created a draft reply in Gmail: "${draftText}". ${mailboxNextSteps(true)}`;
      voiceStore.updateConversationState(session.sessionId, 'READY', {
        lastSpokenText: responseText,
        reason: 'Draft response created',
      });
      return { responseText, endCall: false };
    }

    // 7. "read the draft" / "read draft"
    if (
      norm.includes('read draft') ||
      norm.includes('read the draft') ||
      norm.includes('draft again') ||
      norm.includes('repeat the draft') ||
      norm.includes('what is the draft') ||
      norm === 'the draft'
    ) {
      const draftReply = (session.metadata?.draftReply as string) || null;
      if (draftReply) {
        const responseText = `The proposed draft reply is: "${draftReply}". ${mailboxNextSteps(true)}`;
        voiceStore.updateConversationState(session.sessionId, 'READING_DRAFT', {
          lastSpokenText: responseText,
        });
        return { responseText, endCall: false };
      } else {
        const responseText =
          'No draft has been created for this email yet. Say "draft a response" to create one.';
        voiceStore.updateConversationState(session.sessionId, 'READY', {
          lastSpokenText: responseText,
        });
        return { responseText, endCall: false };
      }
    }

    // 8. "summarize it" / "summary"
    if (
      norm === 'summary' ||
      norm.includes('summarize') ||
      norm.includes('what is it about') ||
      norm.includes('give me a summary')
    ) {
      const summary = selectedMessage.snippet || selectedMessage.body.slice(0, 150).replace(/\s+/g, ' ');
      const hasDraft = !!(session.metadata?.draftReply as string | null | undefined);
      const responseText = `Here is the summary for the email from ${selectedMessage.senderName} about "${selectedMessage.subject}": ${summary}. ${mailboxNextSteps(hasDraft)}`;
      voiceStore.updateConversationState(session.sessionId, 'READING_SUMMARY', {
        lastSpokenText: responseText,
      });
      return { responseText, endCall: false };
    }

    // 9. "read more" / "read email" / "read the email" / "read message"
    if (
      norm.includes('read more') ||
      norm.includes('read email') ||
      norm.includes('read the email') ||
      norm.includes('read message') ||
      norm.includes('full email')
    ) {
      const hasDraft = !!(session.metadata?.draftReply as string | null | undefined);
      const responseText = `Here is the email from ${selectedMessage.senderName}: "${selectedMessage.body}". ${mailboxNextSteps(hasDraft)}`;
      voiceStore.updateConversationState(session.sessionId, 'READY', {
        lastSpokenText: responseText,
      });
      return { responseText, endCall: false };
    }

    // 10. "approve"
    if (norm === 'approve' || norm === 'approve it' || norm === 'approve draft' || norm === 'i approve') {
      const check = checkBoundDraft(session, actionStore);
      if (!check.ok) {
        return refuseIneligibleDraft(
          session,
          voiceStore,
          'approve',
          check,
          'No draft has been created for this email yet. Please say "draft a response" first.'
        );
      }

      const responseText = `Are you sure you want to approve sending this draft to ${selectedMessage.senderName}? Please say "confirm approval" to send.`;
      voiceStore.updateConversationState(session.sessionId, 'AWAITING_APPROVAL_CONFIRMATION', {
        lastSpokenText: responseText,
        reason: 'Initiated approval confirmation',
      });
      return { responseText, endCall: false };
    }

    // 11. "confirm approval" outside of confirmation state
    if (isConfirmationPhrase(utterance, 'approval')) {
      const responseText =
        'Please say "approve" first to review the draft before confirming approval.';
      voiceStore.updateConversationState(session.sessionId, 'READY', {
        lastSpokenText: responseText,
      });
      return { responseText, endCall: false };
    }

    // 12. "reject"
    if (norm === 'reject' || norm === 'reject it' || norm === 'decline') {
      const check = checkBoundDraft(session, actionStore);
      if (!check.ok) {
        return refuseIneligibleDraft(
          session,
          voiceStore,
          'reject',
          check,
          'No draft has been created for this email yet. You can say "go back" to select another message.'
        );
      }

      const responseText =
        'To confirm rejection of this draft, please say "confirm rejection".';
      voiceStore.updateConversationState(session.sessionId, 'AWAITING_REJECTION_CONFIRMATION', {
        lastSpokenText: responseText,
        reason: 'Initiated rejection confirmation',
      });
      return { responseText, endCall: false };
    }

    // 13. "help"
    if (norm === 'help' || norm.includes('options') || norm.includes('what can i say')) {
      const draftReply = (session.metadata?.draftReply as string) || null;
      const responseText = `${mailboxNextSteps(!!draftReply)} You can also say repeat to hear my last answer again.`;
      voiceStore.updateConversationState(session.sessionId, 'READY', {
        lastSpokenText: responseText,
      });
      return { responseText, endCall: false };
    }

    // 14. Unknown: keep the owner in context instead of resetting to the generic menu.
    const responseText = `I didn't catch that. ${mailboxNextSteps(!!(session.metadata?.draftReply as string | null | undefined))}`;
    voiceStore.updateConversationState(session.sessionId, 'READY', {
      lastSpokenText: responseText,
    });
    return { responseText, endCall: false };
  }

  // Single-action Mode: Verify the action exists and fetch fresh state
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

      if (params.executor) {
        if (params.onProgress) {
          params.onProgress('Approval confirmed. Sending the email now.');
        }

        // Execute approved draft via executor
        const execResult = await params.executor.executeApprovedAction(action.actionId, {
          actor: 'voice:owner_voice',
          approvalSource: 'voice',
          actionStore,
        });

        if (execResult.success) {
          const responseText = 'Approval confirmed. The email has been sent successfully. Goodbye!';
          voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
            lastSpokenText: responseText,
            reason: 'Voice approval confirmed and email sent successfully',
          });
          return { responseText, endCall: true };
        } else {
          const responseText =
            "Your approval was recorded, but I wasn't able to send the email. The message has not been marked as sent. Goodbye!";
          voiceStore.updateConversationState(session.sessionId, 'COMPLETE', {
            lastSpokenText: responseText,
            reason: `Voice approval confirmed but email send failed: ${execResult.error}`,
          });
          return { responseText, endCall: true };
        }
      }

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

/* ------------------------------------------------------------------ */
/* Mailbox draft/approval eligibility                                   */
/* ------------------------------------------------------------------ */

export type BoundDraftCheck =
  | { ok: true; action: ActionRecord }
  | {
      ok: false;
      reason: 'no_draft' | 'action_missing' | 'action_not_approvable' | 'draft_mismatch';
      actionId?: string;
      status?: string;
    };

/**
 * Verifies that the session's bound action, its Gmail draft and the session's draft
 * all belong to one current approval lifecycle. Anything else fails closed.
 */
export function checkBoundDraft(session: VoiceSession, actionStore: ActionStore): BoundDraftCheck {
  const boundActionId =
    (session.metadata?.boundActionId as string | null | undefined) || (session.actionId !== 'mailbox' ? session.actionId : null);
  if (!boundActionId) return { ok: false, reason: 'no_draft' };
  const action = actionStore.getAction(boundActionId);
  if (!action) return { ok: false, reason: 'action_missing', actionId: boundActionId };
  if (action.status !== 'AWAITING_APPROVAL') {
    return { ok: false, reason: 'action_not_approvable', actionId: action.actionId, status: action.status };
  }
  const sessionDraftId = session.metadata?.draftId as string | null | undefined;
  const actionDraftId = action.draftId || (action.proposedAction.payload?.draftId as string | undefined);
  if (sessionDraftId && sessionDraftId !== actionDraftId) {
    return { ok: false, reason: 'draft_mismatch', actionId: action.actionId, status: action.status };
  }
  return { ok: true, action };
}

/** Spoken when the bound draft exists but its approval record is stale, missing or mismatched. */
export const STALE_DRAFT_TEXT =
  'This draft can no longer be approved from this call. Say "draft a response" to prepare a fresh draft.';

function refuseIneligibleDraft(
  session: VoiceSession,
  voiceStore: VoiceStore,
  command: string,
  check: Extract<BoundDraftCheck, { ok: false }>,
  noDraftText = 'No draft has been created for this email yet. Please say "draft a response" first.'
): ConversationTurnResult {
  const detail = `${check.reason}${check.actionId ? ` (action ${check.actionId}${check.status ? `, ${check.status}` : ''})` : ''}`;
  console.warn(`[voice:conversation] [session:${session.sessionId}] ${command} refused: ${detail}`);
  const responseText = check.reason === 'no_draft' ? noDraftText : STALE_DRAFT_TEXT;
  voiceStore.updateConversationState(session.sessionId, 'READY', {
    lastSpokenText: responseText,
    reason: `${command} refused: ${detail}`,
  });
  return { responseText, endCall: false };
}

/* ------------------------------------------------------------------ */
/* Photo Booth analytics domain (read-only)                             */
/* ------------------------------------------------------------------ */

const ANALYTICS_BLOCKED_STATES = new Set<VoiceConversationState>([
  'AWAITING_APPROVAL_CONFIRMATION',
  'AWAITING_REJECTION_CONFIRMATION',
  'COMPLETE',
]);

function isSessionMailbox(session: VoiceSession): boolean {
  return session.actionId === 'mailbox' || session.metadata?.mode === 'mailbox';
}

function photoBoothContext(session: VoiceSession): PhotoBoothVoiceContext | null {
  const ctx = session.metadata?.photoBooth as PhotoBoothVoiceContext | null | undefined;
  return ctx && typeof ctx === 'object' ? ctx : null;
}

/** Read-only domains Pacific Ops can switch between without losing mailbox state. */
const READ_DOMAIN_STATES = new Set<VoiceConversationState>(['PHOTO_BOOTH_ANALYTICS', 'CALENDAR', 'EMAIL_READ', 'KNOWLEDGE']);

interface DomainTurnArgs {
  session: VoiceSession;
  utterance: string;
  voiceStore: VoiceStore;
  actionStore: ActionStore;
  onProgress?: (text: string, opts?: { stillWorking?: boolean }) => void;
  photoBooth?: PhotoBoothVoiceDeps;
  calendar?: CalendarVoiceDeps;
  email?: EmailVoiceDeps;
  knowledge?: KnowledgeVoiceDeps;
}

/** Enter (or stay in) a read domain. The mailbox resume point is saved only when leaving the mailbox. */
function enterReadDomain(session: VoiceSession, voiceStore: VoiceStore, state: VoiceConversationState, reason: string): void {
  if (!READ_DOMAIN_STATES.has(session.conversationState)) {
    // Mailbox metadata (messages, selection, bound draft) is left untouched.
    voiceStore.updateSessionMetadata(session.sessionId, { resumeConversationState: session.conversationState });
  }
  voiceStore.updateConversationState(session.sessionId, state, { reason });
}

/**
 * Answers one analytics question through the existing Photo Booth agent. Touches only
 * the voice session: no action store, executor, draft creator or Gmail access.
 */
async function askPhotoBooth(args: DomainTurnArgs): Promise<ConversationTurnResult> {
  const { session, utterance, voiceStore } = args;
  const entering = session.conversationState !== 'PHOTO_BOOTH_ANALYTICS';
  enterReadDomain(session, voiceStore, 'PHOTO_BOOTH_ANALYTICS', entering ? 'Switched to Photo Booth analytics' : 'Photo Booth analytics follow-up');
  args.onProgress?.(PHOTO_BOOTH_PROGRESS_TEXT, { stillWorking: true });

  const previous = photoBoothContext(session);
  const result = await askPhotoBoothForVoice(utterance, previous, args.photoBooth);

  if (result.ok) {
    const context: PhotoBoothVoiceContext = {
      eventId: result.eventId ?? previous?.eventId ?? null,
      lastQuestion: utterance,
      lastAnswer: result.text,
    };
    voiceStore.updateSessionMetadata(session.sessionId, { photoBooth: context });
  }
  const eventNote = result.eventId ? `; event ${result.eventId}` : '';
  console.log(`[voice:analytics] [session:${session.sessionId}] ${result.outcome} (tools: ${result.tools.join(', ') || 'none'}${eventNote})`);
  voiceStore.updateConversationState(session.sessionId, 'PHOTO_BOOTH_ANALYTICS', {
    lastSpokenText: result.text,
    reason: `Photo Booth analytics ${result.outcome} (tools: ${result.tools.join(', ') || 'none'}${eventNote})`,
  });
  return { responseText: result.text, endCall: false };
}

/**
 * Answers one Calendar question through the read-only CalendarService. Touches only the
 * voice session: no action store, executor, draft creator or Gmail access.
 */
async function askCalendar(args: DomainTurnArgs): Promise<ConversationTurnResult> {
  const { session, utterance, voiceStore } = args;
  const entering = session.conversationState !== 'CALENDAR';
  enterReadDomain(session, voiceStore, 'CALENDAR', entering ? 'Switched to Calendar' : 'Calendar follow-up');
  args.onProgress?.(CALENDAR_PROGRESS_TEXT, { stillWorking: true });

  const previous = calendarContext(session);
  const result = await answerCalendarQuestion(utterance, previous, args.calendar);
  // Display-safe scope for the Command Center (profile labels only).
  voiceStore.updateSessionMetadata(session.sessionId, {
    readTaskLabel: `Checking calendar · ${result.scopeLabel}`,
    ...(result.ok && result.context ? { calendar: result.context } : {}),
  });
  const audit = `Calendar ${result.outcome} (reads: ${result.calls.join(', ') || 'none'})`;
  console.log(`[voice:calendar] [session:${session.sessionId}] ${audit}`);
  voiceStore.updateConversationState(session.sessionId, 'CALENDAR', { lastSpokenText: result.text, reason: audit });
  return { responseText: result.text, endCall: false };
}

/** Read-only inbox check across profiles. Never drafts and never touches the action store. */
async function askEmail(args: DomainTurnArgs): Promise<ConversationTurnResult> {
  const { session, utterance, voiceStore } = args;
  const entering = session.conversationState !== 'EMAIL_READ';
  enterReadDomain(session, voiceStore, 'EMAIL_READ', entering ? 'Switched to inbox check' : 'Inbox check follow-up');
  const previous = emailContext(session);
  if (!/\b(first|second|third|1st|2nd|3rd|last)\b/.test(normalizeUtterance(utterance)) || !previous) {
    args.onProgress?.(EMAIL_PROGRESS_TEXT, { stillWorking: true });
  }
  const result = await answerEmailQuestion(utterance, previous, args.email);
  voiceStore.updateSessionMetadata(session.sessionId, {
    ...(result.scopeLabel ? { readTaskLabel: `Checking inboxes · ${result.scopeLabel}` } : {}),
    ...(result.ok && result.context ? { inboxRead: result.context } : {}),
  });
  const audit = `Inbox check ${result.outcome} (accounts read: ${result.reads})`;
  console.log(`[voice:email] [session:${session.sessionId}] ${audit}`);
  voiceStore.updateConversationState(session.sessionId, 'EMAIL_READ', { lastSpokenText: result.text, reason: audit });
  return { responseText: result.text, endCall: false };
}

/**
 * Company-knowledge question through the shared grounding contract. Touches only the
 * voice session; retrieved text is evidence, never instructions, and no tools exist here.
 */
async function askKnowledgeDomain(args: DomainTurnArgs): Promise<ConversationTurnResult> {
  const { session, utterance, voiceStore } = args;
  const entering = session.conversationState !== 'KNOWLEDGE';
  enterReadDomain(session, voiceStore, 'KNOWLEDGE', entering ? 'Switched to company knowledge' : 'Company knowledge follow-up');
  args.onProgress?.(KNOWLEDGE_PROGRESS_TEXT, { stillWorking: true });
  const result = await answerKnowledgeForVoice(utterance, args.knowledge);
  if (result.context) voiceStore.updateSessionMetadata(session.sessionId, { knowledge: result.context });
  const sources = result.context?.citations.map((c) => `${c.title}${c.section ? ` › ${c.section}` : ''}`).join('; ') || 'none';
  const audit = `Knowledge ${result.outcome} (evidence: ${sources})`;
  console.log(`[voice:knowledge] [session:${session.sessionId}] ${audit}`);
  voiceStore.updateConversationState(session.sessionId, 'KNOWLEDGE', { lastSpokenText: result.text, reason: audit });
  return { responseText: result.text, endCall: false };
}

function emailContext(session: VoiceSession): EmailVoiceContext | null {
  const ctx = session.metadata?.inboxRead as EmailVoiceContext | null | undefined;
  return ctx && typeof ctx === 'object' ? ctx : null;
}

function calendarContext(session: VoiceSession): CalendarVoiceContext | null {
  const ctx = session.metadata?.calendar as CalendarVoiceContext | null | undefined;
  return ctx && typeof ctx === 'object' ? ctx : null;
}

/** One turn inside a read domain: shared controls first, then switch or follow up. */
async function handleReadDomainTurn(args: DomainTurnArgs): Promise<ConversationTurnResult> {
  const { session, voiceStore } = args;
  const current = session.conversationState;
  const isCalendar = current === 'CALENDAR';
  const isEmail = current === 'EMAIL_READ';
  const isKnowledge = current === 'KNOWLEDGE';
  const domainName = isKnowledge ? 'company knowledge' : isEmail ? 'inbox check' : isCalendar ? 'Calendar' : 'Photo Booth analytics';
  const norm = normalizeUtterance(args.utterance);
  const stay = (responseText: string, reason?: string): ConversationTurnResult => {
    voiceStore.updateConversationState(session.sessionId, current, { lastSpokenText: responseText, reason });
    return { responseText, endCall: false };
  };

  if (norm === 'bye' || norm === 'goodbye' || norm === 'hang up' || norm === 'end call') {
    const responseText = 'Understood. Goodbye!';
    voiceStore.updateConversationState(session.sessionId, 'COMPLETE', { lastSpokenText: responseText, reason: 'Caller ended call' });
    return { responseText, endCall: true };
  }

  // Repeat replays the stored spoken answer; it never re-queries analytics or Calendar.
  if (isRepeatRequest(norm) && session.lastSpokenText) {
    return stay(session.lastSpokenText, 'Repeated last response at owner request');
  }

  // Multi-inbox requests ("check my personal inbox", "all my inboxes") before the
  // business-mailbox return, which also matches inbox phrasing.
  if (isKnowledgeRequest(norm)) return askKnowledgeDomain(args);
  if (isEmailReadRequest(norm, emailProfiles(args.email))) return askEmail(args);

  if (isReturnToInboxRequest(norm)) {
    return returnToMailbox(session, voiceStore, args.actionStore, domainName);
  }

  if (norm === 'help' || norm.includes('options') || norm.includes('what can i say')) {
    return stay(isKnowledge ? KNOWLEDGE_VOICE_HELP : isEmail ? EMAIL_READ_HELP : isCalendar ? CALENDAR_VOICE_HELP : PHOTO_BOOTH_VOICE_HELP);
  }

  // Drafting is never done from a read-only check, and never silently from another account.
  if (isEmail && isDraftCommand(norm)) {
    return stay(draftRefusalFor(emailContext(session)), 'Draft refused in read-only inbox check');
  }

  if (isMailboxActionCommand(norm)) {
    return stay(
      isKnowledge
        ? KNOWLEDGE_MAILBOX_COMMAND_GUIDANCE
        : isEmail
          ? EMAIL_MAILBOX_COMMAND_GUIDANCE
          : isCalendar
            ? CALENDAR_MAILBOX_COMMAND_GUIDANCE
            : PHOTO_BOOTH_MAILBOX_COMMAND_GUIDANCE,
      `Mailbox command refused while in ${domainName}`
    );
  }

  // Explicit questions for another read domain switch; anything else is a follow-up here.
  const route = routeReadDomain(norm);
  if (route === 'calendar' && !isCalendar) return askCalendar(args);
  if (route === 'photo_booth' && current !== 'PHOTO_BOOTH_ANALYTICS') return askPhotoBooth(args);
  if (isKnowledge) return askKnowledgeDomain(args);
  if (isEmail) return askEmail(args);
  return isCalendar ? askCalendar(args) : askPhotoBooth(args);
}

function returnToMailbox(session: VoiceSession, voiceStore: VoiceStore, actionStore: ActionStore, from: string): ConversationTurnResult {
  const mailbox = isSessionMailbox(session);
  const selected = session.metadata?.selectedMessage as EligibleInboxMessage | null | undefined;
  const saved = VoiceConversationStateSchema.safeParse(session.metadata?.resumeConversationState);
  const savedUsable = saved.success && !ANALYTICS_BLOCKED_STATES.has(saved.data) && !READ_DOMAIN_STATES.has(saved.data);
  // A mailbox session with no selected message is always back at message selection.
  const resume: VoiceConversationState =
    mailbox && !selected ? 'MAILBOX_SELECTING' : savedUsable ? saved.data : 'READY';

  let responseText: string;
  if (mailbox && resume === 'MAILBOX_SELECTING') {
    responseText = 'Back to your inbox. You can choose message one, message two, or message three.';
  } else if (mailbox && selected) {
    const hasDraft = !!(session.metadata?.draftReply as string | null | undefined);
    responseText = `Back to the email from ${selected.senderName} about "${selected.subject}". ${mailboxNextSteps(hasDraft)}`;
  } else {
    const action = actionStore.getAction(session.actionId);
    responseText = action
      ? `Back to the email from ${action.from}, subject: "${action.subject}". You can say: summary, read draft, approve, reject, or help.`
      : 'Back to your email review. You can say summary, read draft, or help.';
  }

  voiceStore.updateSessionMetadata(session.sessionId, { resumeConversationState: null });
  voiceStore.updateConversationState(session.sessionId, resume, {
    lastSpokenText: responseText,
    reason: `Returned from ${from}`,
  });
  return { responseText, endCall: false };
}
