import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import { MailboxStore } from '../src/mailbox/store.js';
import {
  classifyEmailForCleanup,
  detectProtectionFlags,
} from '../src/mailbox/classifier.js';
import { validateSafeQuery, resolveQuery } from '../src/mailbox/queries.js';
import { scanMailbox } from '../src/mailbox/scanner.js';
import { createCleanupPlan } from '../src/mailbox/planner.js';
import { executeCleanupPlan } from '../src/mailbox/executor.js';
import { GMAIL_MODIFY_SCOPE } from '../src/auth.js';
import { type MailboxCleanupCandidate } from '../src/mailbox/types.js';

describe('Safe Gmail Mailbox Cleanup (PHRO-MAIL-001)', () => {
  let tempDir: string;
  let store: MailboxStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-mailbox-test-'));
    store = new MailboxStore({ dataDir: tempDir });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Helper to create mock OAuth client
  function createMockAuth(grantedScopes: string[] = [GMAIL_MODIFY_SCOPE]): OAuth2Client {
    return {
      credentials: {
        scope: grantedScopes.join(' '),
      },
    } as unknown as OAuth2Client;
  }

  it('1. scan never mutates Gmail (read-only)', async () => {
    let trashCalled = false;
    let deleteCalled = false;

    // Spy on google.gmail
    const originalGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        getProfile: async () => ({ data: { emailAddress: 'test@pacifichorizonlabs.com' } }),
        messages: {
          list: async () => ({
            data: {
              messages: [{ id: 'msg_promo_1', threadId: 'thd_1' }],
            },
          }),
          get: async () => ({
            data: {
              id: 'msg_promo_1',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [
                  { name: 'From', value: 'sales@example.com' },
                  { name: 'Subject', value: '50% off summer sale!' },
                  { name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 GMT' },
                ],
              },
              sizeEstimate: 12000,
            },
          }),
          trash: async () => {
            trashCalled = true;
          },
          delete: async () => {
            deleteCalled = true;
          },
        },
      },
    });

    try {
      const mockAuth = createMockAuth();
      const result = await scanMailbox(mockAuth, {
        query: 'category:promotions older_than:1y',
      });

      assert.equal(trashCalled, false, 'scanMailbox must never call trash');
      assert.equal(deleteCalled, false, 'scanMailbox must never call delete');
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].category, 'PROMOTION');
      assert.equal(result.candidates[0].recommendedAction, 'RECOMMEND_TRASH');
    } finally {
      google.gmail = originalGmail;
    }
  });

  it('2. dry-run never mutates Gmail', async () => {
    let trashCalled = false;

    const candidate: MailboxCleanupCandidate = {
      messageId: 'msg_dry_1',
      threadId: 'thd_dry_1',
      sender: 'store@promo.com',
      subject: 'Flash Sale Deals',
      date: '2024-01-01',
      category: 'PROMOTION',
      reason: 'Promotional label',
      confidence: 0.95,
      estimatedSize: 5000,
      protectionFlags: [],
      recommendedAction: 'RECOMMEND_TRASH',
    };

    const plan = createCleanupPlan(
      {
        gmailAccount: 'test@pacifichorizonlabs.com',
        query: 'category:promotions older_than:1y',
        candidates: [candidate],
        excluded: [],
        totalEstimatedBytes: 5000,
      },
      store
    );

    // Approve plan first
    store.approvePlan(plan.id, 'tester');

    const originalGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        messages: {
          get: async () => ({
            data: {
              id: 'msg_dry_1',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [
                  { name: 'From', value: 'store@promo.com' },
                  { name: 'Subject', value: 'Flash Sale Deals' },
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
        dryRun: true,
        store,
      });

      assert.equal(trashCalled, false, 'Dry-run must never call trash');
      assert.equal(summary.dryRun, true);
      assert.equal(summary.trashedCount, 1); // simulated count

      const refreshed = store.getPlan(plan.id);
      assert.equal(refreshed?.status, 'APPROVED', 'Plan status must remain APPROVED after dry-run');
    } finally {
      google.gmail = originalGmail;
    }
  });

  it('3. unapproved plan cannot execute', async () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'test@pacifichorizonlabs.com',
        query: 'category:promotions older_than:1y',
        candidates: [],
        excluded: [],
        totalEstimatedBytes: 0,
      },
      store
    );

    assert.equal(plan.status, 'REVIEW_REQUIRED');

    await assert.rejects(
      () => executeCleanupPlan(createMockAuth(), plan.id, { store }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Execution requires explicit prior approval'));
        return true;
      }
    );
  });

  it('4. approved promotional message can be trashed via messages.trash', async () => {
    const trashedIds: string[] = [];

    const candidate: MailboxCleanupCandidate = {
      messageId: 'msg_live_promo_1',
      threadId: 'thd_1',
      sender: 'newsletter@brand.com',
      subject: 'Exclusive Weekly Promo',
      date: '2024-01-01',
      category: 'PROMOTION',
      reason: 'Promotional marketing content',
      confidence: 0.95,
      estimatedSize: 8000,
      protectionFlags: [],
      recommendedAction: 'RECOMMEND_TRASH',
    };

    const plan = createCleanupPlan(
      {
        gmailAccount: 'test@pacifichorizonlabs.com',
        query: 'category:promotions older_than:1y',
        candidates: [candidate],
        excluded: [],
        totalEstimatedBytes: 8000,
      },
      store
    );

    store.approvePlan(plan.id, 'hector');

    const originalGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        messages: {
          get: async () => ({
            data: {
              id: 'msg_live_promo_1',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [
                  { name: 'From', value: 'newsletter@brand.com' },
                  { name: 'Subject', value: 'Exclusive Weekly Promo' },
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
      assert.equal(trashedIds.length, 1);
      assert.equal(trashedIds[0], 'msg_live_promo_1');
      assert.equal(summary.trashedCount, 1);

      const refreshed = store.getPlan(plan.id);
      assert.equal(refreshed?.status, 'COMPLETED');
      assert.equal(refreshed?.candidates[0].executionStatus, 'TRASHED');
    } finally {
      google.gmail = originalGmail;
    }
  });

  it('5. receipt-like email is strictly blocked', () => {
    const result = classifyEmailForCleanup({
      messageId: 'msg_receipt_1',
      sender: 'orders@retailer.com',
      subject: 'Your electronic receipt for order #8841',
      snippet: 'Thank you for your purchase. Total billed: $59.99',
      labelIds: ['CATEGORY_PROMOTIONS'], // Even if labeled promotion by Gmail
    });

    assert.equal(result.recommendedAction, 'KEEP_REVIEW');
    assert.equal(result.category, 'RECEIPT');
    assert.ok(result.protectionFlags.includes('RECEIPT_LIKE'));
    assert.ok(result.protectionFlags.includes('PURCHASE_LIKE'));
  });

  it('6. order-confirmation email is strictly blocked', () => {
    const result = classifyEmailForCleanup({
      messageId: 'msg_order_1',
      sender: 'store@nike.com',
      subject: 'Order confirmation: Running Shoes',
      snippet: 'We have received your order and will notify you when it ships.',
      labelIds: ['CATEGORY_PROMOTIONS'],
    });

    assert.equal(result.recommendedAction, 'KEEP_REVIEW');
    assert.ok(result.protectionFlags.includes('PURCHASE_LIKE'));
  });

  it('7. security email is strictly blocked', () => {
    const result = classifyEmailForCleanup({
      messageId: 'msg_sec_1',
      sender: 'no-reply@accounts.google.com',
      subject: 'Security alert: new sign-in from Mac',
      snippet: 'Your Google Account was just accessed from a new device.',
      labelIds: ['CATEGORY_UPDATES'],
    });

    assert.equal(result.recommendedAction, 'KEEP_REVIEW');
    assert.equal(result.category, 'ACCOUNT_SECURITY');
    assert.ok(result.protectionFlags.includes('SECURITY_LIKE'));
  });

  it('8. financial email is strictly blocked', () => {
    const result = classifyEmailForCleanup({
      messageId: 'msg_fin_1',
      sender: 'alerts@chase.com',
      subject: 'Your monthly bank statement is now ready',
      snippet: 'View your checking account statement online.',
    });

    assert.equal(result.recommendedAction, 'KEEP_REVIEW');
    assert.equal(result.category, 'FINANCIAL');
    assert.ok(result.protectionFlags.includes('FINANCIAL_LIKE'));
  });

  it('9. unknown classification defaults to KEEP_REVIEW', () => {
    const result = classifyEmailForCleanup({
      messageId: 'msg_unknown_1',
      sender: 'person@somewhere.com',
      subject: 'Meeting notes from yesterday',
      snippet: 'Hey Hector, here are the talking points we discussed.',
    });

    assert.equal(result.category, 'UNKNOWN');
    assert.equal(result.recommendedAction, 'KEEP_REVIEW');
    assert.ok(result.protectionFlags.includes('UNKNOWN_CONTENT'));
  });

  it('10. sender-only rule cannot trash retailer email', () => {
    // 10a: validateSafeQuery rejects sender-only queries lacking category boundaries
    const validation = validateSafeQuery('from:nike.com older_than:180d');
    assert.equal(validation.safe, false);
    assert.ok(validation.reason?.includes('Sender alone is not sufficient'));

    // Safe bounded query is accepted
    const safeValidation = validateSafeQuery('category:promotions from:nike.com older_than:180d');
    assert.equal(safeValidation.safe, true);

    // 10b: Even inside category:promotions, receipt subject is protected
    const classified = classifyEmailForCleanup({
      messageId: 'msg_nike_receipt',
      sender: 'service@nike.com',
      subject: 'Nike Order Confirmation: Your Gear is on the Way',
      labelIds: ['CATEGORY_PROMOTIONS'],
    });

    assert.equal(classified.recommendedAction, 'KEEP_REVIEW');
  });

  it('11. candidate changed after plan creation is revalidated during execution', async () => {
    let trashAttempted = false;

    // Candidate originally marked as promo
    const candidate: MailboxCleanupCandidate = {
      messageId: 'msg_changed_1',
      threadId: 'thd_changed_1',
      sender: 'retailer@shop.com',
      subject: 'Weekend Special Announcement',
      date: '2024-01-01',
      category: 'PROMOTION',
      reason: 'Promotional marketing',
      confidence: 0.9,
      estimatedSize: 2000,
      protectionFlags: [],
      recommendedAction: 'RECOMMEND_TRASH',
    };

    const plan = createCleanupPlan(
      {
        gmailAccount: 'test@pacifichorizonlabs.com',
        query: 'category:promotions older_than:1y',
        candidates: [candidate],
        excluded: [],
        totalEstimatedBytes: 2000,
      },
      store
    );

    store.approvePlan(plan.id, 'tester');

    const originalGmail = google.gmail;
    // On refetch during execution, the subject or body changed to an invoice!
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        messages: {
          get: async () => ({
            data: {
              id: 'msg_changed_1',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [
                  { name: 'From', value: 'retailer@shop.com' },
                  { name: 'Subject', value: 'Invoice and receipt for payment' },
                ],
              },
            },
          }),
          trash: async () => {
            trashAttempted = true;
          },
        },
      },
    });

    try {
      const summary = await executeCleanupPlan(createMockAuth(), plan.id, { store });
      assert.equal(trashAttempted, false, 'Revalidated message must NOT be trashed');
      assert.equal(summary.trashedCount, 0);
      assert.equal(summary.skippedCount, 1);

      const refreshed = store.getPlan(plan.id);
      assert.equal(refreshed?.candidates[0].executionStatus, 'SKIPPED');
      assert.ok(refreshed?.candidates[0].executionReason?.includes('Post-approval protection triggered'));
    } finally {
      google.gmail = originalGmail;
    }
  });

  it('12. failed trash operation is audited and recorded', async () => {
    const candidate: MailboxCleanupCandidate = {
      messageId: 'msg_fail_1',
      threadId: 'thd_fail_1',
      sender: 'promo@store.com',
      subject: 'Clearance sale',
      date: '2024-01-01',
      category: 'PROMOTION',
      reason: 'Promo',
      confidence: 0.9,
      estimatedSize: 1000,
      protectionFlags: [],
      recommendedAction: 'RECOMMEND_TRASH',
    };

    const plan = createCleanupPlan(
      {
        gmailAccount: 'test@pacifichorizonlabs.com',
        query: 'category:promotions older_than:1y',
        candidates: [candidate],
        excluded: [],
        totalEstimatedBytes: 1000,
      },
      store
    );

    store.approvePlan(plan.id, 'tester');

    const originalGmail = google.gmail;
    // @ts-expect-error Mocking google.gmail
    google.gmail = () => ({
      users: {
        messages: {
          get: async () => ({
            data: {
              id: 'msg_fail_1',
              labelIds: ['CATEGORY_PROMOTIONS'],
              payload: {
                headers: [{ name: 'Subject', value: 'Clearance sale' }],
              },
            },
          }),
          trash: async () => {
            throw new Error('Simulated Gmail API Rate Limit Exceeded');
          },
        },
      },
    });

    try {
      const summary = await executeCleanupPlan(createMockAuth(), plan.id, { store });
      assert.equal(summary.failedCount, 1);
      assert.equal(summary.trashedCount, 0);

      const refreshed = store.getPlan(plan.id);
      assert.equal(refreshed?.status, 'FAILED');
      assert.equal(refreshed?.candidates[0].executionStatus, 'FAILED');
      assert.ok(refreshed?.candidates[0].executionReason?.includes('Simulated Gmail API Rate Limit'));
    } finally {
      google.gmail = originalGmail;
    }
  });

  it('13. cleanup plan persistence works across fresh store instance', () => {
    const candidate: MailboxCleanupCandidate = {
      messageId: 'msg_persist_1',
      threadId: 'thd_persist_1',
      sender: 'deals@store.com',
      subject: 'Daily Deals',
      date: '2024-01-01',
      category: 'PROMOTION',
      reason: 'Promo',
      confidence: 0.9,
      estimatedSize: 1024,
      protectionFlags: [],
      recommendedAction: 'RECOMMEND_TRASH',
    };

    const plan = createCleanupPlan(
      {
        gmailAccount: 'test@pacifichorizonlabs.com',
        query: 'category:promotions older_than:1y',
        candidates: [candidate],
        excluded: [],
        totalEstimatedBytes: 1024,
      },
      store
    );

    // Create a new store instance on same directory (simulating restart)
    const freshStore = new MailboxStore({ dataDir: tempDir });
    const loaded = freshStore.getPlan(plan.id);

    assert.ok(loaded);
    assert.equal(loaded.id, plan.id);
    assert.equal(loaded.candidateCount, 1);
    assert.equal(loaded.status, 'REVIEW_REQUIRED');
    assert.equal(loaded.candidates[0].subject, 'Daily Deals');
  });

  it('14. audit-event persistence works in JSONL log', () => {
    const plan = createCleanupPlan(
      {
        gmailAccount: 'test@pacifichorizonlabs.com',
        query: 'category:promotions older_than:1y',
        candidates: [],
        excluded: [],
        totalEstimatedBytes: 0,
      },
      store
    );

    store.approvePlan(plan.id, 'auditor_hector');

    const eventsPath = path.join(tempDir, 'mailbox-cleanup-events.jsonl');
    assert.ok(fs.existsSync(eventsPath));

    const lines = fs
      .readFileSync(eventsPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    assert.equal(lines.length, 2);
    assert.equal(lines[0].toStatus, 'REVIEW_REQUIRED');
    assert.equal(lines[1].toStatus, 'APPROVED');
    assert.equal(lines[1].actor, 'auditor_hector');
  });

  it('15. verifies NO permanent delete Gmail API call exists in src', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    function scanDir(dir: string): string[] {
      const results: string[] = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...scanDir(fullPath));
        } else if (file.endsWith('.ts') || file.endsWith('.js')) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const files = scanDir(srcDir);
    const forbiddenDeletePatterns = [
      /\bmessages\.delete\b/,
      /\bthreads\.delete\b/,
      /\busers\.messages\.delete\b/,
      /\busers\.threads\.delete\b/,
    ];

    for (const f of files) {
      const content = fs.readFileSync(f, 'utf-8');
      for (const pattern of forbiddenDeletePatterns) {
        assert.equal(
          pattern.test(content),
          false,
          `Forbidden permanent delete pattern ${pattern} found in ${f}`
        );
      }
    }
  });

  it('16. verifies NO Gmail send call exists anywhere in src', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    function scanDir(dir: string): string[] {
      const results: string[] = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...scanDir(fullPath));
        } else if (file.endsWith('.ts') || file.endsWith('.js')) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const files = scanDir(srcDir);
    const forbiddenSendPatterns = [
      /\bmessages\.send\b/,
      /\bdrafts\.send\b/,
      /\busers\.messages\.send\b/,
      /\busers\.drafts\.send\b/,
    ];

    for (const f of files) {
      const content = fs.readFileSync(f, 'utf-8');
      for (const pattern of forbiddenSendPatterns) {
        assert.equal(
          pattern.test(content),
          false,
          `Forbidden send pattern ${pattern} found in ${f}`
        );
      }
    }
  });
});
