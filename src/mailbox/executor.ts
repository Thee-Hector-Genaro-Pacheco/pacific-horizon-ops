import crypto from 'node:crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { GMAIL_MODIFY_SCOPE, hasScope, getActiveProfile } from '../auth.js';
import { defaultMailboxStore, type MailboxStore } from './store.js';
import {
  classifyEmailForCleanup,
  type EmailMetadataForClassification,
} from './classifier.js';

export interface ExecuteOptions {
  dryRun?: boolean;
  store?: MailboxStore;
}

export interface ExecutionSummary {
  planId: string;
  totalCandidates: number;
  trashedCount: number;
  skippedCount: number;
  failedCount: number;
  dryRun: boolean;
}

/**
 * Safely executes an approved cleanup plan.
 * Strict Safeguards:
 * 1. Must be explicitly APPROVED before execution.
 * 2. Requires bound gmailProfile; legacy/unbound plans are strictly blocked.
 * 3. Enforces profile and authenticated account match active session.
 * 4. Requires gmail.modify OAuth scope.
 * 5. Dry-run performs zero mutations.
 * 6. Refetches live metadata and re-runs protection checks immediately prior to trashing.
 * 7. Uses ONLY gmail.users.messages.trash — permanent message deletion is strictly prohibited!
 */
export async function executeCleanupPlan(
  auth: OAuth2Client,
  planId: string,
  options: ExecuteOptions = {}
): Promise<ExecutionSummary> {
  const store = options.store || defaultMailboxStore;
  const isDryRun = Boolean(options.dryRun);

  // 1. Plan must exist
  const plan = store.getPlan(planId);
  if (!plan) {
    throw new Error(`Cleanup plan "${planId}" was not found.`);
  }

  // 2. Plan must be in APPROVED state
  if (plan.status !== 'APPROVED') {
    throw new Error(
      `Cannot execute plan "${planId}": current status is "${plan.status}". ` +
      'Execution requires explicit prior approval (status "APPROVED").'
    );
  }

  // 3. Legacy/unbound plan guard: plans must have a bound gmailProfile
  if (!plan.gmailProfile) {
    store.appendEvent({
      eventId: `mbevt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      planId,
      timestamp: new Date().toISOString(),
      fromStatus: plan.status,
      toStatus: plan.status,
      actor: 'cli:executor',
      reason: 'Execution blocked: Plan lacks gmailProfile (legacy/unbound plan)',
      metadata: { planId, reason: 'LEGACY_UNBOUND_PLAN' },
    });
    throw new Error(
      `Cannot execute plan "${planId}": plan lacks a bound gmailProfile (legacy or unbound plan). ` +
      'Only plans created with explicit profile binding can be executed.'
    );
  }

  // 4. Profile match guard: active profile must match plan's bound profile
  const activeProfile = getActiveProfile();
  if (plan.gmailProfile !== activeProfile) {
    store.appendEvent({
      eventId: `mbevt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      planId,
      timestamp: new Date().toISOString(),
      fromStatus: plan.status,
      toStatus: plan.status,
      actor: 'cli:executor',
      reason: `Execution blocked: Profile mismatch (plan profile: "${plan.gmailProfile}", active profile: "${activeProfile}")`,
      metadata: { planId, planProfile: plan.gmailProfile, activeProfile },
    });
    throw new Error(
      `Profile mismatch: Plan "${planId}" belongs to profile "${plan.gmailProfile}", but active profile is "${activeProfile}".`
    );
  }

  const gmail = google.gmail({ version: 'v1', auth });

  // 5. Account match guard: authenticated Gmail account must match plan's bound account
  let authenticatedAccount: string | undefined;
  if (gmail.users?.getProfile) {
    try {
      const profileRes = await gmail.users.getProfile({ userId: 'me' });
      if (profileRes?.data?.emailAddress) {
        authenticatedAccount = profileRes.data.emailAddress.trim().toLowerCase();
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to verify authenticated Gmail identity: ${errMsg}`);
    }
  }

  if (authenticatedAccount && plan.gmailAccount) {
    if (authenticatedAccount.toLowerCase() !== plan.gmailAccount.trim().toLowerCase()) {
      store.appendEvent({
        eventId: `mbevt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        planId,
        timestamp: new Date().toISOString(),
        fromStatus: plan.status,
        toStatus: plan.status,
        actor: 'cli:executor',
        reason: `Execution blocked: Account mismatch (plan account: "${plan.gmailAccount}", authenticated: "${authenticatedAccount}")`,
        metadata: { planId, planAccount: plan.gmailAccount, authenticatedAccount },
      });
      throw new Error(
        `Account mismatch: Plan "${planId}" is bound to "${plan.gmailAccount}", but authenticated Gmail account is "${authenticatedAccount}".`
      );
    }
  }

  // 6. Verify gmail.modify scope is present (unless dry-run)
  if (!isDryRun && !hasScope(auth, GMAIL_MODIFY_SCOPE)) {
    throw new Error(
      `Missing required OAuth scope: "${GMAIL_MODIFY_SCOPE}".\n` +
      'Moving messages to Trash requires the gmail.modify scope. Please re-authenticate your Google account to grant this permission.'
    );
  }

  console.log(`\n==============================================`);
  console.log(`     Executing Mailbox Cleanup Plan           `);
  console.log(`==============================================`);
  console.log(`Plan ID:     ${plan.id}`);
  console.log(`Target:      ${plan.gmailAccount}`);
  console.log(`Query:       "${plan.query}"`);
  console.log(`Candidates:  ${plan.candidates.length}`);
  console.log(`Mode:        ${isDryRun ? 'DRY-RUN (no messages will be trashed)' : 'LIVE (moving to Trash)'}\n`);

  if (!isDryRun) {
    store.updatePlanStatus(planId, 'EXECUTING', {
      actor: 'cli:executor',
      reason: 'Live cleanup execution started',
    });
  }

  let trashedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const candidate of plan.candidates) {
    console.log(`Checking message ${candidate.messageId} ("${candidate.subject}")...`);

    // Refetch current Gmail metadata to detect recent state or label changes
    let currentMetadata: EmailMetadataForClassification | null = null;
    try {
      const getRes = await gmail.users.messages.get({
        userId: 'me',
        id: candidate.messageId,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date', 'List-Unsubscribe'],
      });

      const msg = getRes.data;
      const headers = msg.payload?.headers || [];
      const getHeader = (name: string): string => {
        const match = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
        return match?.value || '';
      };

      currentMetadata = {
        messageId: msg.id || candidate.messageId,
        sender: getHeader('from'),
        subject: getHeader('subject'),
        snippet: msg.snippet || '',
        labelIds: msg.labelIds || [],
        sizeEstimate: msg.sizeEstimate || null,
        hasListUnsubscribeHeader: Boolean(getHeader('list-unsubscribe')),
      };
    } catch (fetchErr: unknown) {
      const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      console.warn(`  [SKIP] Could not refetch message ${candidate.messageId}: ${errMsg}`);
      candidate.executionStatus = 'SKIPPED';
      candidate.executionReason = `Refetch failed: ${errMsg}`;
      skippedCount++;
      continue;
    }

    // Re-run real-time protection checks on refetched metadata
    const recheck = classifyEmailForCleanup(currentMetadata);
    if (recheck.recommendedAction !== 'RECOMMEND_TRASH') {
      console.warn(`  [SAFETY SKIP] Message newly protected upon recheck: ${recheck.reason}`);
      candidate.executionStatus = 'SKIPPED';
      candidate.executionReason = `Post-approval protection triggered: ${recheck.reason}`;
      skippedCount++;
      continue;
    }

    // Perform mutation or record dry-run
    if (isDryRun) {
      console.log(`  [DRY-RUN] Would move to Trash: "${candidate.subject}"`);
      candidate.executionStatus = 'PENDING';
      trashedCount++;
      continue;
    }

    try {
      // ONLY messages.trash — permanent message removal is strictly prohibited!
      await gmail.users.messages.trash({
        userId: 'me',
        id: candidate.messageId,
      });

      console.log(`  [TRASHED] Successfully moved to Gmail Trash.`);
      candidate.executionStatus = 'TRASHED';
      candidate.executionReason = 'Moved to Gmail Trash via approved plan';
      trashedCount++;
    } catch (trashErr: unknown) {
      const errMsg = trashErr instanceof Error ? trashErr.message : String(trashErr);
      console.error(`  [FAILED] Trash operation failed: ${errMsg}`);
      candidate.executionStatus = 'FAILED';
      candidate.executionReason = `Trash API call failed: ${errMsg}`;
      failedCount++;
    }
  }

  // Update plan in store if live execution occurred
  if (!isDryRun) {
    const finalStatus =
      failedCount === 0
        ? 'COMPLETED'
        : trashedCount > 0
        ? 'COMPLETED'
        : 'FAILED';

    store.savePlan(plan);
    store.updatePlanStatus(planId, finalStatus, {
      executedAt: new Date().toISOString(),
      actor: 'cli:executor',
      reason: `Execution finished: ${trashedCount} trashed, ${skippedCount} skipped, ${failedCount} failed`,
      metadata: {
        trashedCount,
        skippedCount,
        failedCount,
      },
    });
  }

  console.log(`\n==============================================`);
  console.log(`              EXECUTION SUMMARY               `);
  console.log(`==============================================`);
  console.log(`Total Candidates: ${plan.candidates.length}`);
  console.log(`Trashed:          ${trashedCount}`);
  console.log(`Skipped (Safe):   ${skippedCount}`);
  console.log(`Failed:           ${failedCount}`);
  console.log(`Status:           ${isDryRun ? 'DRY-RUN (Plan remains APPROVED)' : 'UPDATED'}\n`);

  return {
    planId,
    totalCandidates: plan.candidates.length,
    trashedCount,
    skippedCount,
    failedCount,
    dryRun: isDryRun,
  };
}
