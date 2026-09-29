import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  assertValidTransition,
  InvalidStateTransitionError,
} from '../src/actions/transitions.js';
import { type ActionStatus } from '../src/actions/types.js';

describe('State Transitions Guard', () => {
  it('allows valid progressive transitions', () => {
    assert.equal(canTransition('RECEIVED', 'CLASSIFIED'), true);
    assert.equal(canTransition('CLASSIFIED', 'DRAFTED'), true);
    assert.equal(canTransition('DRAFTED', 'AWAITING_APPROVAL'), true);
    assert.equal(canTransition('AWAITING_APPROVAL', 'APPROVED'), true);
    assert.equal(canTransition('AWAITING_APPROVAL', 'REJECTED'), true);
    assert.equal(canTransition('AWAITING_APPROVAL', 'FAILED'), true);
    assert.equal(canTransition('APPROVED', 'EXECUTED'), true);
    assert.equal(canTransition('APPROVED', 'FAILED'), true);

    // assertValidTransition should not throw for valid transitions
    assert.doesNotThrow(() => assertValidTransition('RECEIVED', 'CLASSIFIED'));
    assert.doesNotThrow(() => assertValidTransition('DRAFTED', 'AWAITING_APPROVAL'));
    assert.doesNotThrow(() => assertValidTransition('AWAITING_APPROVAL', 'APPROVED'));
    assert.doesNotThrow(() => assertValidTransition('AWAITING_APPROVAL', 'REJECTED'));
  });

  it('rejects invalid state reversals or skips', () => {
    const invalidPairs: Array<[ActionStatus, ActionStatus]> = [
      ['APPROVED', 'AWAITING_APPROVAL'], // Reversals disallowed
      ['REJECTED', 'APPROVED'],          // Direct approval from rejected disallowed
      ['EXECUTED', 'APPROVED'],          // Execution is terminal
      ['EXECUTED', 'AWAITING_APPROVAL'],
      ['EXECUTED', 'FAILED'],
      ['FAILED', 'AWAITING_APPROVAL'],   // Terminal failure
      ['FAILED', 'APPROVED'],
      ['RECEIVED', 'APPROVED'],          // Skipping steps disallowed
      ['RECEIVED', 'DRAFTED'],
      ['CLASSIFIED', 'APPROVED'],
      ['DRAFTED', 'APPROVED'],           // Must pass through AWAITING_APPROVAL
    ];

    for (const [from, to] of invalidPairs) {
      assert.equal(
        canTransition(from, to),
        false,
        `Expected transition from ${from} to ${to} to be disallowed`
      );
      assert.throws(
        () => assertValidTransition(from, to, 'test_action_1'),
        (err: unknown) => {
          assert.ok(err instanceof InvalidStateTransitionError);
          assert.equal(err.currentStatus, from);
          assert.equal(err.targetStatus, to);
          assert.equal(err.actionId, 'test_action_1');
          return true;
        }
      );
    }
  });
});
