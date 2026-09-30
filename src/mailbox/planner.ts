import crypto from 'node:crypto';
import { type ScanResult } from './scanner.js';
import { type MailboxCleanupPlan } from './types.js';
import { defaultMailboxStore, type MailboxStore } from './store.js';
import { getActiveProfile, type GmailProfile } from '../auth.js';

/**
 * Creates a persisted, reviewable cleanup plan from scan results.
 * Initial status is strictly REVIEW_REQUIRED.
 */
export function createCleanupPlan(
  scanResult: ScanResult,
  store: MailboxStore = defaultMailboxStore
): MailboxCleanupPlan {
  const planId = `plan_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  const gmailProfile: GmailProfile = scanResult.gmailProfile || getActiveProfile();

  const plan: MailboxCleanupPlan = {
    id: planId,
    gmailAccount: scanResult.gmailAccount,
    gmailProfile,
    createdAt: now,
    query: scanResult.query,
    status: 'REVIEW_REQUIRED',
    candidateCount: scanResult.candidates.length,
    totalEstimatedBytes: scanResult.totalEstimatedBytes,
    candidates: scanResult.candidates,
    excludedCount: scanResult.excluded ? scanResult.excluded.length : 0,
    excluded: scanResult.excluded || [],
  };

  store.savePlan(plan);

  store.appendEvent({
    eventId: `mbevt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    planId,
    timestamp: now,
    fromStatus: null,
    toStatus: 'REVIEW_REQUIRED',
    actor: 'system:planner',
    reason: `Cleanup plan created with ${plan.candidateCount} candidate(s) and ${plan.excludedCount} protected/excluded message(s)`,
    metadata: {
      candidateCount: plan.candidateCount,
      excludedCount: plan.excludedCount,
      query: plan.query,
      gmailProfile,
      gmailAccount: plan.gmailAccount,
    },
  });

  return plan;
}
