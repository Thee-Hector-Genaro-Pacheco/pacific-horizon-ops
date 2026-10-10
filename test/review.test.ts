import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import { MailboxStore } from '../src/mailbox/store.js';
import { createCleanupPlan } from '../src/mailbox/planner.js';
import { executeCleanupPlan } from '../src/mailbox/executor.js';
import { reviewPlan, type ReviewChoice } from '../src/mailbox/reviewer.js';
import { GMAIL_MODIFY_SCOPE } from '../src/auth.js';
import {
  type MailboxCleanupCandidate,
  type MailboxProtectedMessage,
  type MailboxCleanupPlan,
} from '../src/mailbox/types.js';

describe('Interactive Mailbox Review (PHRO-MAIL-005A)', () => {
  let tempDir: string;
  let store: MailboxStore;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.PHRO_GMAIL_PROFILE = 'business';
    process.env.PHRO_GMAIL_BUSINESS_ACCOUNT = 'hector@pacifichorizonlabs.com';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-review-test-'));
    store = new MailboxStore({ dataDir: tempDir });
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.PHRO_GMAIL_PROFILE;
    delete process.env.PHRO_GMAIL_BUSINESS_ACCOUNT;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createMockAuth(): OAuth2Client {
    return {
      credentials: {
        scope: GMAIL_MODIFY_SCOPE,
      },
    } as unknown as OAuth2Client;
  }

  function makeCandidate(id: string, subject: string): MailboxCleanupCandidate {
    return {
      messageId: id,
      threadId: `thd_${id}`,
      sender: 'promo@store.com',
      subject,
      date: 'Mon, 28 Sep 2026 10:00:00 -0700',
      category: 'PROMOTION',
      reason: 'Categorized under Gmail Promotions with no protection flags',
      confidence: 0.95,
      estimatedSize: 50000,
      protectionFlags: [],
      recommendedAction: 'RECOMMEND_TRASH',
      executionStatus: 'PENDING',
    };
  }

  const sampleProtected: MailboxProtectedMessage = {
    messageId: 'prot_receipt_1',
    threadId: 'thd_receipt_1',
    sender: 'orders@vendor.com',
    subject: 'Your Order Confirmation #12345',
    date: 'Sun, 27 Sep 2026 15:30:00 -0700',
    category: 'RECEIPT',
    reason: 'Contains receipt, order confirmation, invoice, or purchase keywords',
    confidence: 0.95,
    estimatedSize: 85000,
    protectionFlags: ['RECEIPT_LIKE', 'PURCHASE_LIKE'],
    recommendedAction: 'KEEP_REVIEW',
    executionStatus: 'SKIPPED',
    executionReason: 'Protected: Contains receipt, order confirmation, invoice, or purchase keywords',
  };

  it('1. Review command loads correct plan and performs interactive review', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [makeCandidate('msg_1', 'Promo 1')],
        excluded: [sampleProtected],
        totalEstimatedBytes: 50000,
      },
      store
    );

    const summary = await reviewPlan(plan.id, {
      store,
      activeProfile: 'business',
      decisionProvider: () => 'approve',
    });

    assert.equal(summary.planId, plan.id);
    assert.equal(summary.totalCandidates, 1);
    assert.equal(summary.reviewedCount, 1);
    assert.equal(summary.approvedCount, 1);
    assert.equal(summary.keptCount, 0);
    assert.equal(summary.skippedCount, 0);
    assert.equal(summary.completed, true);
  });

  it('2. Profile mismatch fails closed', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'personal',
        query: 'category:promotions',
        candidates: [makeCandidate('msg_1', 'Personal Promo')],
        excluded: [],
        totalEstimatedBytes: 50000,
      },
      store
    );

    await assert.rejects(
      () =>
        reviewPlan(plan.id, {
          store,
          activeProfile: 'business',
          decisionProvider: () => 'approve',
        }),
      (err: Error) => {
        assert.match(err.message, /Profile mismatch/);
        assert.match(err.message, /personal/);
        assert.match(err.message, /business/);
        return true;
      }
    );
  });

  it('3. Legacy/unbound plan without gmailProfile fails closed', async () => {
    const legacyPlan: MailboxCleanupPlan = {
      id: 'plan_legacy_unbound_test',
      gmailAccount: 'hector@pacifichorizonlabs.com',
      // gmailProfile is undefined
      createdAt: new Date().toISOString(),
      query: 'category:promotions',
      status: 'REVIEW_REQUIRED',
      candidateCount: 1,
      totalEstimatedBytes: 50000,
      candidates: [makeCandidate('msg_1', 'Old Promo')],
      excludedCount: 0,
    };
    store.savePlan(legacyPlan);

    await assert.rejects(
      () =>
        reviewPlan(legacyPlan.id, {
          store,
          activeProfile: 'business',
          decisionProvider: () => 'approve',
        }),
      (err: Error) => {
        assert.match(err.message, /lacks a bound gmailProfile/);
        return true;
      }
    );
  });

  it('4. Candidate approve decision persists', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [makeCandidate('msg_appr_1', 'Approve Test')],
        excluded: [],
        totalEstimatedBytes: 50000,
      },
      store
    );

    await reviewPlan(plan.id, {
      store,
      activeProfile: 'business',
      decisionProvider: () => 'approve',
    });

    const refreshed = store.getPlan(plan.id);
    assert.ok(refreshed);
    assert.equal(refreshed.candidates[0].reviewDecision, 'APPROVE');
    assert.ok(refreshed.candidates[0].reviewedAt);
    assert.equal(refreshed.hasInteractiveReview, true);
  });

  it('5. Keep decision persists', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [makeCandidate('msg_keep_1', 'Keep Test')],
        excluded: [],
        totalEstimatedBytes: 50000,
      },
      store
    );

    await reviewPlan(plan.id, {
      store,
      activeProfile: 'business',
      decisionProvider: () => 'keep',
    });

    const refreshed = store.getPlan(plan.id);
    assert.ok(refreshed);
    assert.equal(refreshed.candidates[0].reviewDecision, 'KEEP');
    assert.ok(refreshed.candidates[0].reviewedAt);
    assert.equal(refreshed.hasInteractiveReview, true);
  });

  it('6. Skip decision persists', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [makeCandidate('msg_skip_1', 'Skip Test')],
        excluded: [],
        totalEstimatedBytes: 50000,
      },
      store
    );

    await reviewPlan(plan.id, {
      store,
      activeProfile: 'business',
      decisionProvider: () => 'skip',
    });

    const refreshed = store.getPlan(plan.id);
    assert.ok(refreshed);
    assert.equal(refreshed.candidates[0].reviewDecision, 'SKIP');
    assert.ok(refreshed.candidates[0].reviewedAt);
    assert.equal(refreshed.hasInteractiveReview, true);
  });

  it('7. Quit preserves partial progress safely', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [
          makeCandidate('cand_1', 'Cand 1'),
          makeCandidate('cand_2', 'Cand 2'),
          makeCandidate('cand_3', 'Cand 3'),
        ],
        excluded: [],
        totalEstimatedBytes: 150000,
      },
      store
    );

    const decisions: ReviewChoice[] = ['approve', 'keep', 'quit'];
    let callIndex = 0;

    const summary = await reviewPlan(plan.id, {
      store,
      activeProfile: 'business',
      decisionProvider: () => decisions[callIndex++],
    });

    assert.equal(summary.reviewedCount, 2);
    assert.equal(summary.approvedCount, 1);
    assert.equal(summary.keptCount, 1);
    assert.equal(summary.skippedCount, 0);
    assert.equal(summary.unreviewedCount, 1);
    assert.equal(summary.completed, false);

    const reloaded = store.getPlan(plan.id);
    assert.ok(reloaded);
    assert.equal(reloaded.candidates[0].reviewDecision, 'APPROVE');
    assert.equal(reloaded.candidates[1].reviewDecision, 'KEEP');
    assert.equal(reloaded.candidates[2].reviewDecision, undefined);
    assert.equal(reloaded.hasInteractiveReview, true);
  });

  it('8. Protected messages cannot be reviewed into executable state', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'newer_than:30d',
        candidates: [makeCandidate('msg_cand', 'Promo')],
        excluded: [sampleProtected],
        totalEstimatedBytes: 135000,
      },
      store
    );

    const reviewedCandidateIds: string[] = [];

    await reviewPlan(plan.id, {
      store,
      activeProfile: 'business',
      decisionProvider: (candidate) => {
        reviewedCandidateIds.push(candidate.messageId);
        return 'approve';
      },
    });

    // Only candidates were presented for review; excluded items were never prompted
    assert.deepEqual(reviewedCandidateIds, ['msg_cand']);
    assert.ok(!reviewedCandidateIds.includes('prot_receipt_1'));

    const reloaded = store.getPlan(plan.id);
    assert.ok(reloaded?.excluded);
    assert.equal(reloaded.excluded[0].recommendedAction, 'KEEP_REVIEW');
    assert.equal(reloaded.excluded[0].executionStatus, 'SKIPPED');
  });

  it('9. Review does not call Gmail', async () => {
    let gmailApiCalled = false;
    const origGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => {
      gmailApiCalled = true;
      return {};
    };

    try {
      const plan = createCleanupPlan(
        {
          gmailAccount: 'hector@pacifichorizonlabs.com',
          gmailProfile: 'business',
          query: 'category:promotions',
          candidates: [makeCandidate('msg_1', 'Promo')],
          excluded: [],
          totalEstimatedBytes: 50000,
        },
        store
      );

      await reviewPlan(plan.id, {
        store,
        activeProfile: 'business',
        decisionProvider: () => 'approve',
      });

      assert.equal(gmailApiCalled, false, 'reviewPlan must NEVER make any Gmail API calls');
    } finally {
      google.gmail = origGmail;
    }
  });

  it('10. Review does not change plan status to APPROVED', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [makeCandidate('msg_1', 'Promo 1'), makeCandidate('msg_2', 'Promo 2')],
        excluded: [],
        totalEstimatedBytes: 100000,
      },
      store
    );

    // Operator approves all candidates during review
    await reviewPlan(plan.id, {
      store,
      activeProfile: 'business',
      decisionProvider: () => 'approve',
    });

    const refreshed = store.getPlan(plan.id);
    assert.ok(refreshed);
    assert.equal(
      refreshed.status,
      'REVIEW_REQUIRED',
      'Plan status must remain REVIEW_REQUIRED after review; approve command is still required'
    );
    assert.equal(refreshed.approvedAt, undefined);
    assert.equal(refreshed.approvedBy, undefined);
  });

  it('11. Executor respects individual review decisions and only trashes operator-approved candidates', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [
          makeCandidate('cand_approved', 'Approved Promo'),
          makeCandidate('cand_kept', 'Kept Promo'),
          makeCandidate('cand_skipped', 'Skipped Promo'),
        ],
        excluded: [],
        totalEstimatedBytes: 150000,
      },
      store
    );

    // Perform review
    const decisions: Record<string, ReviewChoice> = {
      cand_approved: 'approve',
      cand_kept: 'keep',
      cand_skipped: 'skip',
    };

    await reviewPlan(plan.id, {
      store,
      activeProfile: 'business',
      decisionProvider: (candidate) => decisions[candidate.messageId],
    });

    // Explicitly approve the plan
    store.approvePlan(plan.id, 'owner');

    const trashedIds: string[] = [];
    const origGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        getProfile: async () => ({ data: { emailAddress: 'hector@pacifichorizonlabs.com' } }),
        messages: {
          get: async () => ({
            data: {
              id: 'cand_approved',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [
                  { name: 'From', value: 'promo@store.com' },
                  { name: 'Subject', value: 'Approved Promo' },
                ],
              },
            },
          }),
          trash: async ({ id }: { id: string }) => {
            trashedIds.push(id);
            return { data: {} };
          },
        },
      },
    });

    try {
      const summary = await executeCleanupPlan(createMockAuth(), plan.id, { store });

      assert.equal(summary.trashedCount, 1);
      assert.equal(summary.skippedCount, 2);
      assert.deepEqual(trashedIds, ['cand_approved']);
      assert.ok(!trashedIds.includes('cand_kept'), 'Kept candidate must NOT be trashed');
      assert.ok(!trashedIds.includes('cand_skipped'), 'Skipped candidate must NOT be trashed');

      const executedPlan = store.getPlan(plan.id);
      assert.equal(executedPlan?.candidates[0].executionStatus, 'TRASHED');
      assert.equal(executedPlan?.candidates[1].executionStatus, 'SKIPPED');
      assert.equal(executedPlan?.candidates[2].executionStatus, 'SKIPPED');
    } finally {
      google.gmail = origGmail;
    }
  });

  it('12. Legacy plan behavior remains compatible when interactive review was not performed', async () => {
    // Historical plan created without interactive review
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [makeCandidate('legacy_cand_1', 'Legacy Promo')],
        excluded: [],
        totalEstimatedBytes: 50000,
      },
      store
    );

    // Plan approved without running review
    store.approvePlan(plan.id, 'owner');

    const trashedIds: string[] = [];
    const origGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        getProfile: async () => ({ data: { emailAddress: 'hector@pacifichorizonlabs.com' } }),
        messages: {
          get: async () => ({
            data: {
              id: 'legacy_cand_1',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [
                  { name: 'From', value: 'promo@store.com' },
                  { name: 'Subject', value: 'Legacy Promo' },
                ],
              },
            },
          }),
          trash: async ({ id }: { id: string }) => {
            trashedIds.push(id);
            return { data: {} };
          },
        },
      },
    });

    try {
      const summary = await executeCleanupPlan(createMockAuth(), plan.id, { store });
      assert.equal(summary.trashedCount, 1);
      assert.deepEqual(trashedIds, ['legacy_cand_1']);
    } finally {
      google.gmail = origGmail;
    }
  });

  it('13. Completed or approved plans cannot be altered through review', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [makeCandidate('msg_1', 'Promo')],
        excluded: [],
        totalEstimatedBytes: 50000,
      },
      store
    );

    // 1. Approved status
    store.approvePlan(plan.id, 'owner');
    await assert.rejects(
      () =>
        reviewPlan(plan.id, {
          store,
          activeProfile: 'business',
          decisionProvider: () => 'approve',
        }),
      (err: Error) => {
        assert.match(err.message, /Cannot review plan/);
        assert.match(err.message, /expected "REVIEW_REQUIRED"/);
        return true;
      }
    );

    // 2. Completed status
    store.updatePlanStatus(plan.id, 'COMPLETED');
    await assert.rejects(
      () =>
        reviewPlan(plan.id, {
          store,
          activeProfile: 'business',
          decisionProvider: () => 'approve',
        }),
      (err: Error) => {
        assert.match(err.message, /Cannot review plan/);
        assert.match(err.message, /expected "REVIEW_REQUIRED"/);
        return true;
      }
    );
  });

  it('14. Unreviewed candidates in a partially reviewed plan are skipped by executor', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [
          makeCandidate('cand_reviewed', 'Reviewed and Approved'),
          makeCandidate('cand_unreviewed', 'Not Reviewed (Quit Early)'),
        ],
        excluded: [],
        totalEstimatedBytes: 100000,
      },
      store
    );

    // Operator approves first, then quits on second
    const choices: ReviewChoice[] = ['approve', 'quit'];
    let idx = 0;
    await reviewPlan(plan.id, {
      store,
      activeProfile: 'business',
      decisionProvider: () => choices[idx++],
    });

    store.approvePlan(plan.id, 'owner');

    const trashedIds: string[] = [];
    const origGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        getProfile: async () => ({ data: { emailAddress: 'hector@pacifichorizonlabs.com' } }),
        messages: {
          get: async () => ({
            data: {
              id: 'cand_reviewed',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [
                  { name: 'From', value: 'promo@store.com' },
                  { name: 'Subject', value: 'Reviewed and Approved' },
                ],
              },
            },
          }),
          trash: async ({ id }: { id: string }) => {
            trashedIds.push(id);
            return { data: {} };
          },
        },
      },
    });

    try {
      const summary = await executeCleanupPlan(createMockAuth(), plan.id, { store });
      assert.equal(summary.trashedCount, 1);
      assert.equal(summary.skippedCount, 1);
      assert.deepEqual(trashedIds, ['cand_reviewed']);
      assert.ok(!trashedIds.includes('cand_unreviewed'));

      const reloaded = store.getPlan(plan.id);
      assert.equal(reloaded?.candidates[1].executionStatus, 'SKIPPED');
      assert.equal(
        reloaded?.candidates[1].executionReason,
        'Candidate was not approved during interactive review'
      );
    } finally {
      google.gmail = origGmail;
    }
  });

  it('15. Dry-run executor respects review decisions', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [
          makeCandidate('cand_appr', 'Approved in Review'),
          makeCandidate('cand_kept', 'Kept in Review'),
        ],
        excluded: [],
        totalEstimatedBytes: 100000,
      },
      store
    );

    const choices: Record<string, ReviewChoice> = {
      cand_appr: 'approve',
      cand_kept: 'keep',
    };

    await reviewPlan(plan.id, {
      store,
      activeProfile: 'business',
      decisionProvider: (candidate) => choices[candidate.messageId],
    });

    store.approvePlan(plan.id, 'owner');

    let trashCalled = false;
    const origGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        getProfile: async () => ({ data: { emailAddress: 'hector@pacifichorizonlabs.com' } }),
        messages: {
          get: async () => ({
            data: {
              id: 'cand_appr',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [
                  { name: 'From', value: 'promo@store.com' },
                  { name: 'Subject', value: 'Approved in Review' },
                ],
              },
            },
          }),
          trash: async () => {
            trashCalled = true;
          },
        },
      },
    });

    try {
      const summary = await executeCleanupPlan(createMockAuth(), plan.id, {
        store,
        dryRun: true,
      });

      assert.equal(trashCalled, false, 'Dry run must never call trash');
      assert.equal(summary.dryRun, true);
      assert.equal(summary.trashedCount, 1, 'Simulated trashedCount reflects only approved candidate');
      assert.equal(summary.skippedCount, 1, 'Kept candidate was skipped');

      const reloaded = store.getPlan(plan.id);
      assert.equal(reloaded?.status, 'APPROVED', 'Plan status remains APPROVED after dry run');
    } finally {
      google.gmail = origGmail;
    }
  });
});
