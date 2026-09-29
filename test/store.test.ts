import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ActionStore } from '../src/actions/store.js';
import { InvalidStateTransitionError } from '../src/actions/transitions.js';
import { type ApprovalRecord } from '../src/actions/types.js';

describe('ActionStore Persistence & Lifecycle', () => {
  let tempDir: string;
  let store: ActionStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-store-test-'));
    store = new ActionStore({ dataDir: tempDir });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates draft action and progresses to AWAITING_APPROVAL with audit events', () => {
    const result = store.createDraftAction({
      messageId: 'msg_001',
      threadId: 'thd_001',
      draftId: 'draft_001',
      subject: 'Inquiry for October 12',
      from: 'client@example.com',
      classificationCategory: 'booking_inquiry',
      confidence: 0.95,
      draftReply: 'Thanks for reaching out! We would love to host your event.',
    });

    assert.equal(result.isNew, true);
    assert.equal(result.action.status, 'AWAITING_APPROVAL');
    assert.equal(result.action.messageId, 'msg_001');
    assert.equal(result.action.draftId, 'draft_001');
    assert.equal(result.action.actionType, 'CREATE_EMAIL_DRAFT');

    // Verify events were appended
    const eventsPath = path.join(tempDir, 'action-events.jsonl');
    assert.ok(fs.existsSync(eventsPath));
    const lines = fs
      .readFileSync(eventsPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    assert.equal(lines.length, 4);
    assert.equal(lines[0].toStatus, 'RECEIVED');
    assert.equal(lines[1].toStatus, 'CLASSIFIED');
    assert.equal(lines[2].toStatus, 'DRAFTED');
    assert.equal(lines[3].toStatus, 'AWAITING_APPROVAL');
  });

  it('ensures idempotent action creation without duplicate pending actions', () => {
    const first = store.createDraftAction({
      messageId: 'msg_repeat',
      threadId: 'thd_repeat',
      draftId: 'draft_repeat',
      subject: 'Duplicate Test',
      from: 'client2@example.com',
      classificationCategory: 'booking_inquiry',
      confidence: 0.9,
      draftReply: 'Hello',
    });

    assert.equal(first.isNew, true);

    const second = store.createDraftAction({
      messageId: 'msg_repeat',
      threadId: 'thd_repeat',
      draftId: 'draft_repeat_different',
      subject: 'Duplicate Test',
      from: 'client2@example.com',
      classificationCategory: 'booking_inquiry',
      confidence: 0.9,
      draftReply: 'Hello again',
    });

    assert.equal(second.isNew, false);
    assert.equal(second.action.actionId, first.action.actionId);

    // List pending actions to confirm only 1 action exists
    const pending = store.listActions({ status: 'AWAITING_APPROVAL' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].actionId, first.action.actionId);
  });

  it('persists approval event and moves status to APPROVED', () => {
    const { action } = store.createDraftAction({
      messageId: 'msg_approve',
      threadId: 'thd_approve',
      draftId: 'draft_approve',
      subject: 'Booking Inquiry',
      from: 'approve@example.com',
      classificationCategory: 'booking_inquiry',
      confidence: 0.88,
      draftReply: 'Pricing details provided.',
    });

    const approval: ApprovalRecord = {
      decision: 'approved',
      approvedBy: 'hector',
      approvedAt: new Date().toISOString(),
      approvalSource: 'cli',
      notes: 'LGTM',
    };

    const approved = store.approveAction(action.actionId, approval);
    assert.equal(approved.status, 'APPROVED');
    assert.deepEqual(approved.approvalMetadata, approval);

    // Verify cannot re-approve or re-reject approved action
    assert.throws(() => store.approveAction(action.actionId, approval), (err: unknown) => {
      assert.ok(err instanceof InvalidStateTransitionError);
      return true;
    });

    assert.throws(() => store.rejectAction(action.actionId, approval), (err: unknown) => {
      assert.ok(err instanceof InvalidStateTransitionError);
      return true;
    });
  });

  it('persists rejection event and moves status to REJECTED', () => {
    const { action } = store.createDraftAction({
      messageId: 'msg_reject',
      threadId: 'thd_reject',
      draftId: 'draft_reject',
      subject: 'Inappropriate Inquiry',
      from: 'spam@example.com',
      classificationCategory: 'other',
      confidence: 0.75,
      draftReply: 'Not interested.',
    });

    const rejection: ApprovalRecord = {
      decision: 'rejected',
      approvedBy: 'hector',
      approvedAt: new Date().toISOString(),
      approvalSource: 'cli',
      notes: 'Customer outside service area',
    };

    const rejected = store.rejectAction(action.actionId, rejection);
    assert.equal(rejected.status, 'REJECTED');
    assert.deepEqual(rejected.approvalMetadata, rejection);

    // Verify cannot approve after rejection
    const approval: ApprovalRecord = {
      decision: 'approved',
      approvedBy: 'hector',
      approvedAt: new Date().toISOString(),
      approvalSource: 'cli',
    };

    assert.throws(() => store.approveAction(action.actionId, approval), (err: unknown) => {
      assert.ok(err instanceof InvalidStateTransitionError);
      return true;
    });
  });

  it('survives process restart with atomic file persistence', () => {
    const { action } = store.createDraftAction({
      messageId: 'msg_restart',
      threadId: 'thd_restart',
      draftId: 'draft_restart',
      subject: 'Restart Persistence Test',
      from: 'test@example.com',
      classificationCategory: 'booking_inquiry',
      confidence: 0.92,
      draftReply: 'Checking restart safety.',
    });

    // Create a new store instance pointing to the same dataDir (simulating process restart)
    const freshStore = new ActionStore({ dataDir: tempDir });
    const loadedAction = freshStore.getAction(action.actionId);

    assert.ok(loadedAction);
    assert.equal(loadedAction.actionId, action.actionId);
    assert.equal(loadedAction.status, 'AWAITING_APPROVAL');
    assert.equal(loadedAction.messageId, 'msg_restart');

    // Confirm no temp files remain
    const files = fs.readdirSync(tempDir);
    const tempFiles = files.filter((f) => f.includes('.tmp.'));
    assert.equal(tempFiles.length, 0);
  });
});
