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
import { handlePlanDetail } from '../src/mailbox/cli.js';
import { GMAIL_MODIFY_SCOPE } from '../src/auth.js';
import {
  type MailboxCleanupCandidate,
  type MailboxProtectedMessage,
  type MailboxCleanupPlan,
} from '../src/mailbox/types.js';

describe('Mailbox Cleanup Protected Message Audit Persistence & CLI Display', () => {
  let tempDir: string;
  let store: MailboxStore;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.PHRO_GMAIL_PROFILE = 'business';
    process.env.PHRO_GMAIL_BUSINESS_ACCOUNT = 'hector@pacifichorizonlabs.com';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-audit-test-'));
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

  const sampleCandidate: MailboxCleanupCandidate = {
    messageId: 'cand_promo_1',
    threadId: 'thd_promo_1',
    sender: 'deals@store.com',
    subject: 'Flash Sale: 50% Off Everything Today',
    date: 'Mon, 28 Sep 2026 10:00:00 -0700',
    category: 'PROMOTION',
    reason: 'Categorized under Gmail Promotions with no protection flags',
    confidence: 0.95,
    estimatedSize: 45000,
    protectionFlags: [],
    recommendedAction: 'RECOMMEND_TRASH',
    executionStatus: 'PENDING',
  };

  const sampleProtectedReceipt: MailboxProtectedMessage = {
    messageId: 'prot_receipt_1',
    threadId: 'thd_receipt_1',
    sender: 'orders@vendor.com',
    subject: 'Your Order Confirmation #98765',
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

  const sampleProtectedSecurity: MailboxProtectedMessage = {
    messageId: 'prot_sec_2',
    threadId: 'thd_sec_2',
    sender: 'security@cloud.com',
    subject: 'Security Alert: New Sign-in Detected',
    date: 'Sat, 26 Sep 2026 09:12:00 -0700',
    category: 'ACCOUNT_SECURITY',
    reason: 'Contains password reset, security alert, or login verification keywords',
    confidence: 0.95,
    estimatedSize: 22000,
    protectionFlags: ['SECURITY_LIKE'],
    recommendedAction: 'KEEP_REVIEW',
    executionStatus: 'SKIPPED',
    executionReason: 'Protected: Contains password reset, security alert, or login verification keywords',
  };

  it('1. New plan persists protected/excluded details with full audit metadata', () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'newer_than:30d',
        candidates: [sampleCandidate],
        excluded: [sampleProtectedReceipt, sampleProtectedSecurity],
        totalEstimatedBytes: 152000,
      },
      store
    );

    assert.ok(plan.excluded);
    assert.equal(plan.excluded.length, 2);

    // Verify in-memory plan structure
    const receipt = plan.excluded[0];
    assert.equal(receipt.messageId, 'prot_receipt_1');
    assert.equal(receipt.sender, 'orders@vendor.com');
    assert.equal(receipt.subject, 'Your Order Confirmation #98765');
    assert.equal(receipt.date, 'Sun, 27 Sep 2026 15:30:00 -0700');
    assert.equal(receipt.category, 'RECEIPT');
    assert.equal(receipt.reason, 'Contains receipt, order confirmation, invoice, or purchase keywords');
    assert.equal(receipt.confidence, 0.95);
    assert.equal(receipt.estimatedSize, 85000);
    assert.deepEqual(receipt.protectionFlags, ['RECEIPT_LIKE', 'PURCHASE_LIKE']);
    assert.equal(receipt.recommendedAction, 'KEEP_REVIEW');

    // Reload from disk using fresh store to ensure persisted serialization works
    const freshStore = new MailboxStore({ dataDir: tempDir });
    const loaded = freshStore.getPlan(plan.id);

    assert.ok(loaded);
    assert.ok(loaded.excluded);
    assert.equal(loaded.excluded.length, 2);
    assert.equal(loaded.excluded[0].messageId, 'prot_receipt_1');
    assert.equal(loaded.excluded[0].category, 'RECEIPT');
    assert.equal(loaded.excluded[1].messageId, 'prot_sec_2');
    assert.equal(loaded.excluded[1].category, 'ACCOUNT_SECURITY');
  });

  it('2. Candidate details remain unchanged when protected details are persisted', () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'newer_than:30d',
        candidates: [sampleCandidate],
        excluded: [sampleProtectedReceipt],
        totalEstimatedBytes: 130000,
      },
      store
    );

    const freshStore = new MailboxStore({ dataDir: tempDir });
    const loaded = freshStore.getPlan(plan.id);

    assert.ok(loaded);
    assert.equal(loaded.candidates.length, 1);
    const cand = loaded.candidates[0];
    assert.equal(cand.messageId, sampleCandidate.messageId);
    assert.equal(cand.threadId, sampleCandidate.threadId);
    assert.equal(cand.sender, sampleCandidate.sender);
    assert.equal(cand.subject, sampleCandidate.subject);
    assert.equal(cand.date, sampleCandidate.date);
    assert.equal(cand.category, sampleCandidate.category);
    assert.equal(cand.reason, sampleCandidate.reason);
    assert.equal(cand.confidence, sampleCandidate.confidence);
    assert.equal(cand.estimatedSize, sampleCandidate.estimatedSize);
    assert.deepEqual(cand.protectionFlags, sampleCandidate.protectionFlags);
    assert.equal(cand.recommendedAction, sampleCandidate.recommendedAction);
    assert.equal(cand.executionStatus, 'PENDING');
  });

  it('3. excludedCount matches the protected/excluded array length for new plans', () => {
    // Zero excluded
    const planZero = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'category:promotions',
        candidates: [sampleCandidate],
        excluded: [],
        totalEstimatedBytes: 45000,
      },
      store
    );
    assert.equal(planZero.excludedCount, 0);
    assert.equal(planZero.excluded?.length, 0);
    assert.equal(planZero.excludedCount, planZero.excluded?.length);

    // Two excluded
    const planTwo = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'newer_than:30d',
        candidates: [sampleCandidate],
        excluded: [sampleProtectedReceipt, sampleProtectedSecurity],
        totalEstimatedBytes: 152000,
      },
      store
    );
    assert.equal(planTwo.excludedCount, 2);
    assert.equal(planTwo.excluded?.length, 2);
    assert.equal(planTwo.excludedCount, planTwo.excluded?.length);
  });

  it('4. CLI plan view renders protected/excluded details table with category, flags, reason, and disposition', () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'newer_than:30d',
        candidates: [sampleCandidate],
        excluded: [sampleProtectedReceipt, sampleProtectedSecurity],
        totalEstimatedBytes: 152000,
      },
      store
    );

    const logged: string[] = [];
    const origLog = console.log;
    const origTable = console.table;

    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    console.table = (data: unknown) => {
      logged.push(JSON.stringify(data));
    };

    try {
      handlePlanDetail(plan.id, store);
    } finally {
      console.log = origLog;
      console.table = origTable;
    }

    const output = logged.join('\n');

    // Asserts headers
    assert.ok(output.includes(`PLAN DETAILS: ${plan.id}`));
    assert.ok(output.includes('Candidates (1)'));
    assert.ok(output.includes('Protected / Excluded Messages (2)'));

    // Asserts protected table contents
    assert.ok(output.includes('RECEIPT'));
    assert.ok(output.includes('RECEIPT_LIKE, PURCHASE_LIKE'));
    assert.ok(output.includes('KEEP_REVIEW'));
    assert.ok(output.includes('Contains receipt, order confirmation, invoice, or purchase keywords'));

    assert.ok(output.includes('ACCOUNT_SECURITY'));
    assert.ok(output.includes('SECURITY_LIKE'));
    assert.ok(output.includes('Contains password reset, security alert, or login verification keywords'));
  });

  it('5. Legacy plan without protected details still loads successfully', () => {
    // Write a legacy plan file directly to disk simulating historical plans in data/
    const plansFile = path.join(tempDir, 'mailbox-cleanup-plans.json');
    const legacyPlanJson = [
      {
        id: 'plan_legacy_1790736243729_b3697d40',
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        createdAt: '2026-09-30T02:44:03.729Z',
        query: 'newer_than:30d',
        status: 'REVIEW_REQUIRED',
        candidateCount: 1,
        totalEstimatedBytes: 329613,
        candidates: [sampleCandidate],
        excludedCount: 19,
        // Notice: NO "excluded" field exists
      },
    ];

    fs.writeFileSync(plansFile, JSON.stringify(legacyPlanJson, null, 2), 'utf-8');

    const freshStore = new MailboxStore({ dataDir: tempDir });
    const loadedMap = freshStore.loadPlans();
    assert.equal(loadedMap.size, 1);

    const loaded = freshStore.getPlan('plan_legacy_1790736243729_b3697d40');
    assert.ok(loaded);
    assert.equal(loaded.candidateCount, 1);
    assert.equal(loaded.excludedCount, 19);
    assert.equal(loaded.candidates.length, 1);
    assert.equal(loaded.excluded, undefined);
  });

  it('6. Legacy plan shows explicit “details unavailable for legacy plan” message in CLI', () => {
    const plansFile = path.join(tempDir, 'mailbox-cleanup-plans.json');
    const legacyPlanJson = [
      {
        id: 'plan_legacy_test_001',
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        createdAt: '2026-09-30T02:44:03.729Z',
        query: 'newer_than:30d',
        status: 'REVIEW_REQUIRED',
        candidateCount: 1,
        totalEstimatedBytes: 329613,
        candidates: [sampleCandidate],
        excludedCount: 19,
      },
    ];

    fs.writeFileSync(plansFile, JSON.stringify(legacyPlanJson, null, 2), 'utf-8');
    const freshStore = new MailboxStore({ dataDir: tempDir });

    const logged: string[] = [];
    const origLog = console.log;
    const origTable = console.table;

    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    console.table = (data: unknown) => {
      logged.push(JSON.stringify(data));
    };

    try {
      handlePlanDetail('plan_legacy_test_001', freshStore);
    } finally {
      console.log = origLog;
      console.table = origTable;
    }

    const output = logged.join('\n');
    assert.ok(output.includes('Protected / Excluded Messages (19):'));
    assert.ok(
      output.includes('details unavailable for legacy plan') ||
        output.includes('Protected message details were not recorded for this legacy plan'),
      `Output must explain that details are unavailable for legacy plan. Got:\n${output}`
    );
  });

  it('7. Approved/execution behavior is unchanged', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'newer_than:30d',
        candidates: [sampleCandidate],
        excluded: [sampleProtectedReceipt, sampleProtectedSecurity],
        totalEstimatedBytes: 152000,
      },
      store
    );

    // 1. Approve
    store.approvePlan(plan.id, 'tester');
    const approved = store.getPlan(plan.id);
    assert.equal(approved?.status, 'APPROVED');
    assert.equal(approved?.approvedBy, 'tester');

    // 2. Mock execute
    let trashedCount = 0;
    const originalGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        getProfile: async () => ({
          data: { emailAddress: 'hector@pacifichorizonlabs.com' },
        }),
        messages: {
          get: async () => ({
            data: {
              id: 'cand_promo_1',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [
                  { name: 'From', value: 'deals@store.com' },
                  { name: 'Subject', value: 'Flash Sale: 50% Off Everything Today' },
                ],
              },
            },
          }),
          trash: async () => {
            trashedCount++;
            return { data: {} };
          },
        },
      },
    });

    try {
      const summary = await executeCleanupPlan(createMockAuth(), plan.id, { store });
      assert.equal(summary.trashedCount, 1);
      assert.equal(trashedCount, 1);

      const executedPlan = store.getPlan(plan.id);
      assert.equal(executedPlan?.status, 'COMPLETED');
      assert.equal(executedPlan?.candidates[0].executionStatus, 'TRASHED');
      // Excluded messages remain preserved after execution
      assert.equal(executedPlan?.excluded?.length, 2);
    } finally {
      google.gmail = originalGmail;
    }
  });

  it('8. No protected/excluded message can become executable merely because it is persisted for audit', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'hector@pacifichorizonlabs.com',
        gmailProfile: 'business',
        query: 'newer_than:30d',
        candidates: [sampleCandidate],
        excluded: [sampleProtectedReceipt, sampleProtectedSecurity],
        totalEstimatedBytes: 152000,
      },
      store
    );

    store.approvePlan(plan.id, 'tester');

    const trashedMessageIds: string[] = [];
    const originalGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        getProfile: async () => ({
          data: { emailAddress: 'hector@pacifichorizonlabs.com' },
        }),
        messages: {
          get: async () => ({
            data: {
              id: 'cand_promo_1',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [
                  { name: 'From', value: 'deals@store.com' },
                  { name: 'Subject', value: 'Flash Sale: 50% Off Everything Today' },
                ],
              },
            },
          }),
          trash: async ({ id }: { id: string }) => {
            trashedMessageIds.push(id);
            return { data: {} };
          },
        },
      },
    });

    try {
      // 1. Dry run execution
      const drySummary = await executeCleanupPlan(createMockAuth(), plan.id, {
        dryRun: true,
        store,
      });
      assert.equal(drySummary.trashedCount, 1, 'Dry-run trashedCount must only count candidate');
      assert.equal(trashedMessageIds.length, 0, 'Dry-run must not trash any message');

      // 2. Live execution
      const liveSummary = await executeCleanupPlan(createMockAuth(), plan.id, { store });
      assert.equal(liveSummary.trashedCount, 1);

      // Verify ONLY cand_promo_1 was trashed
      assert.deepEqual(trashedMessageIds, ['cand_promo_1']);
      assert.ok(!trashedMessageIds.includes('prot_receipt_1'), 'Protected receipt must NEVER be trashed');
      assert.ok(!trashedMessageIds.includes('prot_sec_2'), 'Protected security alert must NEVER be trashed');

      const reloadedPlan = store.getPlan(plan.id);
      assert.ok(reloadedPlan);
      // Candidates have updated executionStatus
      assert.equal(reloadedPlan.candidates[0].executionStatus, 'TRASHED');
      // Excluded items retain SKIPPED executionStatus and were never executed
      assert.equal(reloadedPlan.excluded?.[0].executionStatus, 'SKIPPED');
      assert.equal(reloadedPlan.excluded?.[1].executionStatus, 'SKIPPED');
    } finally {
      google.gmail = originalGmail;
    }
  });
});
