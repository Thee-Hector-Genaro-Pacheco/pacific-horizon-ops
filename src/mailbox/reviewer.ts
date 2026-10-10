import readline from 'node:readline/promises';
import crypto from 'node:crypto';
import { getActiveProfile, type GmailProfile } from '../auth.js';
import { defaultMailboxStore, type MailboxStore } from './store.js';
import {
  type MailboxCleanupPlan,
  type MailboxCleanupCandidate,
  type ReviewDecision,
} from './types.js';

export type ReviewChoice = 'approve' | 'keep' | 'skip' | 'quit';

export interface ReviewSummary {
  planId: string;
  totalCandidates: number;
  reviewedCount: number;
  approvedCount: number;
  keptCount: number;
  skippedCount: number;
  unreviewedCount: number;
  completed: boolean;
}

export interface ReviewOptions {
  store?: MailboxStore;
  activeProfile?: GmailProfile;
  actor?: string;
  decisionProvider?: (
    candidate: MailboxCleanupCandidate,
    index: number,
    total: number
  ) => Promise<ReviewChoice> | ReviewChoice;
}

/**
 * Validates that a plan is eligible for interactive review.
 * Enforces profile binding, plan existence, REVIEW_REQUIRED status, and presence of candidates.
 */
export function validatePlanForReview(
  plan: MailboxCleanupPlan | undefined,
  planId: string,
  activeProfile: GmailProfile
): asserts plan is MailboxCleanupPlan {
  if (!plan) {
    throw new Error(`Cleanup plan "${planId}" not found.`);
  }

  if (!plan.gmailProfile) {
    throw new Error(
      `Cannot review plan "${planId}": plan lacks a bound gmailProfile (legacy or unbound plan).`
    );
  }

  if (plan.gmailProfile !== activeProfile) {
    throw new Error(
      `Profile mismatch: Plan "${planId}" belongs to profile "${plan.gmailProfile}", but active profile is "${activeProfile}".`
    );
  }

  if (plan.status !== 'REVIEW_REQUIRED') {
    throw new Error(
      `Cannot review plan "${planId}": current status is "${plan.status}", expected "REVIEW_REQUIRED".`
    );
  }

  if (!plan.candidates || plan.candidates.length === 0) {
    throw new Error(`Plan "${planId}" has no candidates to review.`);
  }
}

/**
 * Formats a candidate for terminal review presentation.
 */
export function formatCandidateForReview(
  candidate: MailboxCleanupCandidate,
  index: number,
  total: number
): string {
  const sizeText =
    typeof candidate.estimatedSize === 'number'
      ? `${(candidate.estimatedSize / 1024).toFixed(1)} KB`
      : 'Unknown';
  const confidencePct = (candidate.confidence * 100).toFixed(0);
  const flagsText =
    candidate.protectionFlags.length > 0 ? candidate.protectionFlags.join(', ') : 'NONE';

  const lines = [
    `------------------------------------------------------------`,
    `Candidate [${index + 1} of ${total}]: ${candidate.messageId}`,
    `------------------------------------------------------------`,
    `Subject:            ${candidate.subject}`,
    `Sender:             ${candidate.sender}`,
    `Date:               ${candidate.date}`,
    `Category:           ${candidate.category}`,
    `Reason:             ${candidate.reason}`,
    `Confidence:         ${confidencePct}%`,
    `Estimated Size:     ${sizeText}`,
    `Protection Flags:   ${flagsText}`,
    `Recommended Action: ${candidate.recommendedAction}`,
    candidate.reviewDecision ? `Current Decision:   ${candidate.reviewDecision}` : null,
    `------------------------------------------------------------`,
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Normalizes user input into a deterministic ReviewChoice.
 */
export function parseReviewChoice(input: string): ReviewChoice | null {
  const norm = input.trim().toLowerCase();
  if (norm === 'a' || norm === 'approve') return 'approve';
  if (norm === 'k' || norm === 'keep') return 'keep';
  if (norm === 's' || norm === 'skip') return 'skip';
  if (norm === 'q' || norm === 'quit' || norm === 'exit') return 'quit';
  return null;
}

/**
 * Interactively reviews candidates in a cleanup plan and records decisions locally.
 * Read-only with respect to Gmail: NEVER mutates Gmail and NEVER transitions plan to APPROVED.
 */
export async function reviewPlan(
  planId: string,
  options: ReviewOptions = {}
): Promise<ReviewSummary> {
  const store = options.store || defaultMailboxStore;
  const activeProfile = options.activeProfile || getActiveProfile();
  const actor = options.actor || process.env.USER || process.env.LOGNAME || 'cli:user';

  const plan = store.getPlan(planId);
  validatePlanForReview(plan, planId, activeProfile);

  console.log('\n==============================================');
  console.log(`     INTERACTIVE MAILBOX REVIEW: ${plan.id}   `);
  console.log('==============================================');
  console.log(`Profile:    ${plan.gmailProfile}`);
  console.log(`Account:    ${plan.gmailAccount}`);
  console.log(`Query:      "${plan.query}"`);
  console.log(`Candidates: ${plan.candidates.length}`);
  console.log(`Protected:  ${plan.excludedCount} (Safe / Excluded)`);
  console.log('\n[SAFETY] Review is strictly local. Zero messages will be trashed.');
  console.log('Commands: [a] approve for trash  [k] keep message  [s] skip  [q] quit review\n');

  let approvedCount = 0;
  let keptCount = 0;
  let skippedCount = 0;
  let reviewedCount = 0;
  let stoppedEarly = false;

  let rl: readline.Interface | null = null;
  if (!options.decisionProvider) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  try {
    for (let i = 0; i < plan.candidates.length; i++) {
      const candidate = plan.candidates[i];

      console.log(formatCandidateForReview(candidate, i, plan.candidates.length));

      let choice: ReviewChoice | null = null;

      if (options.decisionProvider) {
        choice = await options.decisionProvider(candidate, i, plan.candidates.length);
      } else if (rl) {
        while (!choice) {
          const answer = await rl.question('Choice ([a]pprove, [k]eep, [s]kip, [q]uit): ');
          choice = parseReviewChoice(answer);
          if (!choice) {
            console.log('Invalid input. Please enter "a" to approve, "k" to keep, "s" to skip, or "q" to quit.');
          }
        }
      }

      if (choice === 'quit') {
        console.log('\nReview paused by operator. Saving progress...');
        stoppedEarly = true;
        break;
      }

      const now = new Date().toISOString();
      reviewedCount++;

      if (choice === 'approve') {
        candidate.reviewDecision = 'APPROVE';
        candidate.reviewedAt = now;
        approvedCount++;
        console.log(`  -> Marked [APPROVED] for cleanup.`);
      } else if (choice === 'keep') {
        candidate.reviewDecision = 'KEEP';
        candidate.reviewedAt = now;
        keptCount++;
        console.log(`  -> Marked [KEEP] (protected from cleanup).`);
      } else if (choice === 'skip') {
        candidate.reviewDecision = 'SKIP';
        candidate.reviewedAt = now;
        skippedCount++;
        console.log(`  -> Marked [SKIPPED].`);
      }
      console.log('');
    }
  } finally {
    if (rl) {
      rl.close();
    }
  }

  // Update plan in store
  const now = new Date().toISOString();
  plan.hasInteractiveReview = true;
  plan.reviewedAt = now;
  plan.reviewedBy = actor;

  store.savePlan(plan);

  const completed = !stoppedEarly;
  store.appendEvent({
    eventId: `mbevt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    planId: plan.id,
    timestamp: now,
    fromStatus: plan.status,
    toStatus: plan.status,
    actor,
    reason: `Interactive review ${completed ? 'completed' : 'stopped early'}: ${approvedCount} approved, ${keptCount} kept, ${skippedCount} skipped`,
    metadata: {
      planId: plan.id,
      totalCandidates: plan.candidates.length,
      reviewedCount,
      approvedCount,
      keptCount,
      skippedCount,
      completed,
    },
  });

  const unreviewedCount = plan.candidates.length - (approvedCount + keptCount + skippedCount);

  console.log('==============================================');
  console.log('               REVIEW SUMMARY                 ');
  console.log('==============================================');
  console.log(`Plan ID:              ${plan.id}`);
  console.log(`Total Candidates:     ${plan.candidates.length}`);
  console.log(`Reviewed:             ${reviewedCount}`);
  console.log(`Approved for cleanup: ${approvedCount}`);
  console.log(`Kept (Protected):     ${keptCount}`);
  console.log(`Skipped:              ${skippedCount}`);
  if (unreviewedCount > 0) {
    console.log(`Unreviewed:           ${unreviewedCount}`);
  }
  console.log(`Protected Messages:   ${plan.excludedCount} (Excluded by safety rules)`);
  console.log(`Plan Status:          ${plan.status} (Unchanged)`);

  const profilePrefix = `PHRO_GMAIL_PROFILE=${plan.gmailProfile}`;
  console.log('\n[NEXT STEPS]');
  console.log('Plan remains in REVIEW_REQUIRED. Candidate review does NOT authorize execution.');
  if (approvedCount > 0) {
    console.log(`To approve this plan for cleanup (${approvedCount} approved candidate(s)):`);
    console.log(`  ${profilePrefix} npm run mailbox:approve -- ${plan.id}\n`);
  } else {
    console.log('No candidates were approved for cleanup.');
    console.log(`You can run review again at any time:\n  ${profilePrefix} npm run mailbox:review -- ${plan.id}\n`);
  }

  return {
    planId: plan.id,
    totalCandidates: plan.candidates.length,
    reviewedCount,
    approvedCount,
    keptCount,
    skippedCount,
    unreviewedCount,
    completed,
  };
}
