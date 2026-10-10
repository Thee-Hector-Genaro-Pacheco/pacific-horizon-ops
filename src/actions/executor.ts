import type { OAuth2Client } from 'google-auth-library';
import { type ActionStore, defaultActionStore } from './store.js';
import { getAuthenticatedClient } from '../auth.js';
import {
  getReplyDraft,
  sendReplyDraft,
  findSentMessageInThread,
} from '../gmail.js';

export interface ExecutionResult {
  success: boolean;
  status: 'SENT' | 'EXECUTION_FAILED' | 'BLOCKED_MODIFIED' | 'ALREADY_SENT';
  messageId?: string;
  threadId?: string;
  error?: string;
  alreadySent?: boolean;
}

export interface ActionExecutor {
  executeApprovedAction(
    actionId: string,
    options?: {
      auth?: OAuth2Client;
      actionStore?: ActionStore;
      actor?: string;
      approvalSource?: string;
    }
  ): Promise<ExecutionResult>;
}

function extractEmail(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

function normalizeSubject(s: string): string {
  return s.trim().toLowerCase().replace(/^re:\s*/i, '');
}

function normalizeBody(b: string): string {
  return b.trim().replace(/\r\n/g, '\n').replace(/\s+/g, ' ');
}

export interface GmailSendAdapter {
  getReplyDraft(auth: OAuth2Client, draftId: string): Promise<import('../gmail.js').GmailDraftDetails | null>;
  sendReplyDraft(auth: OAuth2Client, draftId: string): Promise<{ messageId: string; threadId: string }>;
  findSentMessageInThread?(
    auth: OAuth2Client,
    threadId: string,
    options: { to: string; subject: string }
  ): Promise<{ messageId: string; threadId: string } | null>;
}

export const defaultGmailAdapter: GmailSendAdapter = {
  getReplyDraft,
  sendReplyDraft,
  findSentMessageInThread,
};

export class DefaultActionExecutor implements ActionExecutor {
  constructor(private adapter: GmailSendAdapter = defaultGmailAdapter) {}

  public async executeApprovedAction(
    actionId: string,
    options: {
      auth?: OAuth2Client;
      actionStore?: ActionStore;
      actor?: string;
      approvalSource?: string;
    } = {}
  ): Promise<ExecutionResult> {
    const actionStore = options.actionStore || defaultActionStore;
    const actor = options.actor || 'system:executor';
    const action = actionStore.getAction(actionId);

    if (!action) {
      return {
        success: false,
        status: 'EXECUTION_FAILED',
        error: `Action "${actionId}" was not found.`,
      };
    }

    // 1. Idempotency check: Already sent
    if (action.status === 'SENT') {
      const existingMessageId = (action.executionMetadata?.result?.messageId as string) || undefined;
      return {
        success: true,
        status: 'ALREADY_SENT',
        alreadySent: true,
        messageId: existingMessageId,
        threadId: action.threadId,
      };
    }

    // 2. Action eligibility: must be strictly APPROVED
    if (action.status !== 'APPROVED') {
      return {
        success: false,
        status: 'EXECUTION_FAILED',
        error: `Action "${actionId}" is in status "${action.status}". Only APPROVED actions can be executed.`,
      };
    }

    // 3. Draft payload validation
    const draftId = action.draftId || (action.proposedAction.payload?.draftId as string);
    const expectedBody = (action.proposedAction.payload?.draftReply as string) || '';

    if (!draftId) {
      actionStore.transitionAction(action.actionId, 'EXECUTION_FAILED', {
        actor,
        failureReason: 'Missing draft ID on approved action record.',
        reason: 'Execution aborted: no draftId',
      });
      return {
        success: false,
        status: 'EXECUTION_FAILED',
        error: 'Missing draft ID on approved action record.',
      };
    }

    // 4. Resolve authenticated Gmail client
    let auth = options.auth;
    if (!auth) {
      try {
        auth = await getAuthenticatedClient();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        actionStore.transitionAction(action.actionId, 'EXECUTION_FAILED', {
          actor,
          failureReason: `Authentication failed: ${msg}`,
          reason: 'Execution aborted: Gmail auth error',
        });
        return {
          success: false,
          status: 'EXECUTION_FAILED',
          error: `Authentication failed: ${msg}`,
        };
      }
    }

    // 5. Verify live draft integrity in Gmail before sending
    let liveDraft;
    try {
      liveDraft = await this.adapter.getReplyDraft(auth, draftId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      actionStore.transitionAction(action.actionId, 'EXECUTION_FAILED', {
        actor,
        failureReason: `Failed to inspect draft in Gmail: ${msg}`,
        reason: 'Draft inspection error',
      });
      return {
        success: false,
        status: 'EXECUTION_FAILED',
        error: `Failed to inspect draft in Gmail: ${msg}`,
      };
    }

    if (!liveDraft) {
      actionStore.transitionAction(action.actionId, 'EXECUTION_FAILED', {
        actor,
        failureReason: `Draft "${draftId}" was not found in Gmail. It may have been deleted.`,
        reason: 'Draft not found in Gmail',
      });
      return {
        success: false,
        status: 'EXECUTION_FAILED',
        error: `Draft "${draftId}" was not found in Gmail.`,
      };
    }

    // 6. Immutability & Modification Guards
    // Recipient check
    const expectedRecipient = extractEmail(action.from);
    const actualRecipient = extractEmail(liveDraft.to);
    if (!actualRecipient.includes(expectedRecipient) && !expectedRecipient.includes(actualRecipient)) {
      const reason = `Draft recipient changed in Gmail (expected: ${expectedRecipient}, found: ${actualRecipient}). Send aborted for safety.`;
      actionStore.transitionAction(action.actionId, 'EXECUTION_FAILED', {
        actor,
        failureReason: reason,
        reason: 'Draft modified: recipient mismatch',
      });
      return {
        success: false,
        status: 'BLOCKED_MODIFIED',
        error: reason,
      };
    }

    // Subject check
    const expectedSubject = normalizeSubject(action.subject);
    const actualSubject = normalizeSubject(liveDraft.subject);
    if (expectedSubject !== actualSubject) {
      const reason = `Draft subject changed in Gmail (expected: ${expectedSubject}, found: ${actualSubject}). Send aborted for safety.`;
      actionStore.transitionAction(action.actionId, 'EXECUTION_FAILED', {
        actor,
        failureReason: reason,
        reason: 'Draft modified: subject mismatch',
      });
      return {
        success: false,
        status: 'BLOCKED_MODIFIED',
        error: reason,
      };
    }

    // Body content check
    if (expectedBody) {
      const normExpectedBody = normalizeBody(expectedBody);
      const normActualBody = normalizeBody(liveDraft.bodyText);
      if (normExpectedBody !== normActualBody) {
        const reason = 'Draft content in Gmail was modified after approval. Send aborted for safety.';
        actionStore.transitionAction(action.actionId, 'EXECUTION_FAILED', {
          actor,
          failureReason: reason,
          reason: 'Draft modified: body mismatch',
        });
        return {
          success: false,
          status: 'BLOCKED_MODIFIED',
          error: reason,
        };
      }
    }

    // 7. Transition to EXECUTING
    actionStore.transitionAction(action.actionId, 'EXECUTING', {
      actor,
      reason: 'Sending exact approved draft via Gmail API',
      metadata: { draftId },
    });

    // 8. Execute Send via Gmail
    try {
      const sendRes = await this.adapter.sendReplyDraft(auth, draftId);
      const now = new Date().toISOString();

      actionStore.transitionAction(action.actionId, 'SENT', {
        actor,
        reason: 'Draft sent successfully via Gmail API',
        metadata: {
          messageId: sendRes.messageId,
          threadId: sendRes.threadId,
          executedAt: now,
          approvalSource: options.approvalSource || action.approvalMetadata?.approvalSource,
        },
      });

      // Update in-memory action executionMetadata
      const finalAction = actionStore.getAction(actionId)!;
      finalAction.executionMetadata = {
        executedAt: now,
        executor: actor,
        result: {
          messageId: sendRes.messageId,
          threadId: sendRes.threadId,
        },
      };

      return {
        success: true,
        status: 'SENT',
        messageId: sendRes.messageId,
        threadId: sendRes.threadId,
      };
    } catch (sendErr: unknown) {
      // Reconcile before blindly failing: check if message was sent in thread despite error
      if (action.threadId && this.adapter.findSentMessageInThread) {
        try {
          const reconciled = await this.adapter.findSentMessageInThread(auth, action.threadId, {
            to: action.from,
            subject: action.subject,
          });
          if (reconciled) {
            const now = new Date().toISOString();
            actionStore.transitionAction(action.actionId, 'SENT', {
              actor,
              reason: 'Draft verified sent via thread reconciliation',
              metadata: {
                messageId: reconciled.messageId,
                threadId: reconciled.threadId,
                executedAt: now,
                approvalSource: options.approvalSource || action.approvalMetadata?.approvalSource,
              },
            });
            return {
              success: true,
              status: 'SENT',
              messageId: reconciled.messageId,
              threadId: reconciled.threadId,
            };
          }
        } catch {
          // Reconcile failed, proceed to fail-closed
        }
      }

      const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      actionStore.transitionAction(action.actionId, 'EXECUTION_FAILED', {
        actor,
        failureReason: `Gmail send failed: ${msg}`,
        reason: 'Gmail send failed',
      });

      return {
        success: false,
        status: 'EXECUTION_FAILED',
        error: msg,
      };
    }
  }
}

export const defaultActionExecutor = new DefaultActionExecutor();
