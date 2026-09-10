import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  checkRuntimeSupport,
  createJobStore,
  type ReservationInput,
} from '../src/job-store.ts';
import { StoreError, StoreWriteError } from '../src/job-types.ts';
import type { EvidenceInput } from '../src/store-evidence.ts';
import { createSchemaV1Fixture } from './fixtures/schema-v1.ts';

const OWNER = '11111111-2222-4333-8444-555555555555';
const OTHER_OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const runtimeSkip = (() => {
  try {
    checkRuntimeSupport();
    return false;
  } catch {
    return 'requires Node 26 with linked SQLite >= 3.51.3';
  }
})();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'u2-control-'));
  const store = createJobStore(join(root, 'watch', 'v1', 'jobs.sqlite'), {
    trustedRoot: root,
    now: () => 100,
  });
  return { root, store };
}

function input(overrides: Partial<ReservationInput> = {}): ReservationInput {
  return {
    ownerUuid: OWNER,
    sessionPath: '/sessions/owner.jsonl',
    namespace: 'tool_call',
    requestKey: `key-${Math.random().toString(36).slice(2)}`,
    command: 'echo hello',
    cwd: '/tmp',
    ...overrides,
  };
}

function closeFixture(root: string, store: { close(): void }): void {
  store.close();
  rmSync(root, { recursive: true, force: true });
}

test('a genuine schema-1 store is refused without modifying its persisted data', {
  skip: runtimeSkip,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'u2-schema-v1-'));
  const database = join(root, 'watch', 'v1', 'jobs.sqlite');
  createSchemaV1Fixture(database);
  const before = readFileSync(database);
  assert.throws(
    () => createJobStore(database, { trustedRoot: root }),
    (error: unknown) =>
      error instanceof StoreError && error.code === 'STORE_CORRUPT',
  );
  assert.deepEqual(readFileSync(database), before);
  rmSync(root, { recursive: true, force: true });
});

test('cancellation is owner-scoped, stable including timestamp zero, and has no result side effects', {
  skip: runtimeSkip,
}, () => {
  const { root, store } = fixture();
  try {
    const reserved = store.reserve(input({ requestKey: 'cancel' }));
    const zeroStore = createJobStore(join(root, 'watch', 'v1', 'jobs.sqlite'), {
      trustedRoot: root,
      now: () => 0,
    });
    try {
      assert.throws(
        () => zeroStore.requestCancellation(OTHER_OWNER, reserved.job.jobId),
        (error: unknown) =>
          error instanceof StoreError && error.code === 'NOT_FOUND',
      );
      const first = zeroStore.requestCancellation(OWNER, reserved.job.jobId);
      assert.deepEqual(first, {
        disposition: 'recorded',
        control: {
          cancellationRequestedAtMs: 0,
          launchDecision: null,
          decidedAtMs: null,
        },
      });
      const second = zeroStore.requestCancellation(OWNER, reserved.job.jobId);
      assert.equal(second.disposition, 'already_recorded');
      assert.equal(second.control.cancellationRequestedAtMs, 0);
      assert.deepEqual(zeroStore.listResults(OWNER, reserved.job.jobId), []);
      assert.deepEqual(zeroStore.listNotices(OWNER, reserved.job.jobId), []);
      assert.equal(
        zeroStore.observeJob(OWNER, reserved.job.jobId).control
          .cancellationRequestedAtMs,
        0,
      );
    } finally {
      zeroStore.close();
    }
  } finally {
    closeFixture(root, store);
  }
});

test('cancellation wins an expired deadline and timestamp zero remains durable', {
  skip: runtimeSkip,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'u2-control-both-'));
  let clock = 100;
  const store = createJobStore(join(root, 'watch', 'v1', 'jobs.sqlite'), {
    trustedRoot: root,
    now: () => clock,
  });
  try {
    const reserved = store.reserve(
      input({ requestKey: 'both', deadlineMs: 10 }),
    );
    clock = 0;
    assert.equal(
      store.requestCancellation(OWNER, reserved.job.jobId).control
        .cancellationRequestedAtMs,
      0,
    );
    clock = reserved.job.deadlineAtMs;
    store.claimRunner(OWNER, reserved.job.jobId, 'both', reserved.runnerToken);
    const decision = store.decideLaunch(
      OWNER,
      reserved.job.jobId,
      'both',
      reserved.runnerToken,
    );
    assert.equal(decision.disposition, 'suppressed_now');
    assert.equal(decision.control.launchDecision, 'suppressed_cancelled');
    assert.equal(
      store.requestCancellation(OWNER, reserved.job.jobId).control
        .cancellationRequestedAtMs,
      0,
    );
  } finally {
    closeFixture(root, store);
  }
});

test('deadline-only exact boundary records deadline suppression', {
  skip: runtimeSkip,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'u2-control-deadline-only-'));
  let clock = 100;
  const store = createJobStore(join(root, 'watch', 'v1', 'jobs.sqlite'), {
    trustedRoot: root,
    now: () => clock,
  });
  try {
    const reserved = store.reserve(
      input({ requestKey: 'deadline-only', deadlineMs: 10 }),
    );
    store.claimRunner(
      OWNER,
      reserved.job.jobId,
      'deadline-only',
      reserved.runnerToken,
    );
    clock = reserved.job.deadlineAtMs;
    const decision = store.decideLaunch(
      OWNER,
      reserved.job.jobId,
      'deadline-only',
      reserved.runnerToken,
    );
    assert.equal(decision.disposition, 'suppressed_now');
    assert.equal(decision.control.launchDecision, 'suppressed_deadline');
  } finally {
    closeFixture(root, store);
  }
});

test('independent connections preserve both ordered cancellation/decision outcomes', {
  skip: runtimeSkip,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'u2-control-order-'));
  const database = join(root, 'watch', 'v1', 'jobs.sqlite');
  const seed = createJobStore(database, { trustedRoot: root, now: () => 100 });
  const before = seed.reserve(input({ requestKey: 'order-before' }));
  seed.close();
  const cancelCaller = createJobStore(database, {
    trustedRoot: root,
    now: () => 0,
  });
  const decideCaller = createJobStore(database, {
    trustedRoot: root,
    now: () => 100,
  });
  try {
    cancelCaller.requestCancellation(OWNER, before.job.jobId);
    decideCaller.claimRunner(
      OWNER,
      before.job.jobId,
      'order-before',
      before.runnerToken,
    );
    assert.equal(
      decideCaller.decideLaunch(
        OWNER,
        before.job.jobId,
        'order-before',
        before.runnerToken,
      ).control.launchDecision,
      'suppressed_cancelled',
    );
  } finally {
    cancelCaller.close();
    decideCaller.close();
  }
  const authCaller = createJobStore(database, {
    trustedRoot: root,
    now: () => 100,
  });
  const lateCancelCaller = createJobStore(database, {
    trustedRoot: root,
    now: () => 0,
  });
  const after = authCaller.reserve(input({ requestKey: 'order-after' }));
  try {
    authCaller.claimRunner(
      OWNER,
      after.job.jobId,
      'order-after',
      after.runnerToken,
    );
    assert.equal(
      authCaller.decideLaunch(
        OWNER,
        after.job.jobId,
        'order-after',
        after.runnerToken,
      ).disposition,
      'authorized_now',
    );
    assert.equal(
      lateCancelCaller.requestCancellation(OWNER, after.job.jobId).disposition,
      'recorded',
    );
    assert.equal(
      lateCancelCaller.observeJob(OWNER, after.job.jobId).control
        .launchDecision,
      'authorized',
    );
  } finally {
    authCaller.close();
    lateCancelCaller.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancellation suppression publishes one finalized result and notice', {
  skip: runtimeSkip,
}, () => {
  const { root, store } = fixture();
  try {
    const reserved = store.reserve(
      input({ requestKey: 'suppressed', deadlineMs: 10 }),
    );
    store.requestCancellation(OWNER, reserved.job.jobId);
    store.claimRunner(OWNER, reserved.job.jobId, 'claim', reserved.runnerToken);
    const decision = store.decideLaunch(
      OWNER,
      reserved.job.jobId,
      'claim',
      reserved.runnerToken,
    );
    assert.equal(decision.disposition, 'suppressed_now');
    assert.equal(decision.control.launchDecision, 'suppressed_cancelled');
    const [result] = store.listResults(OWNER, reserved.job.jobId);
    assert.equal(result?.revision, 1);
    assert.equal(result?.evidence.launch, 'suppressed_cancelled');
    assert.equal(result?.evidence.cleanupState, 'not_required');
    assert.equal(result?.evidence.finalized, true);
    assert.equal(store.listNotices(OWNER, reserved.job.jobId).length, 1);
    assert.equal(
      store.requestCancellation(OWNER, reserved.job.jobId).disposition,
      'already_terminal',
    );
    assert.equal(
      store.decideLaunch(
        OWNER,
        reserved.job.jobId,
        'claim',
        reserved.runnerToken,
      ).disposition,
      'already_decided',
    );
  } finally {
    closeFixture(root, store);
  }
});

test('initial facts remain eligible when revision uncertainty is cleared independently', {
  skip: runtimeSkip,
}, () => {
  const { root, store } = fixture();
  const reserved = store.reserve(input({ requestKey: 'raw-initial-facts' }));
  store.claimRunner(OWNER, reserved.job.jobId, 'raw', reserved.runnerToken);
  store.publishUncertainResult(OWNER, reserved.job.jobId, {
    observedClaimId: 'raw',
    observedCounter: 0,
    observedRevision: 0,
  });
  store.close();
  const db = new DatabaseSync(join(root, 'watch', 'v1', 'jobs.sqlite'));
  db.prepare(
    'UPDATE job_results SET uncertain = 0, finalized = 0 WHERE job_id = ?',
  ).run(reserved.job.jobId);
  db.close();
  const reopened = createJobStore(join(root, 'watch', 'v1', 'jobs.sqlite'), {
    trustedRoot: root,
    now: () => 100,
  });
  try {
    assert.equal(
      reopened.decideLaunch(
        OWNER,
        reserved.job.jobId,
        'raw',
        reserved.runnerToken,
      ).disposition,
      'authorized_now',
    );
  } finally {
    closeFixture(root, reopened);
  }
});

test('schema-1 fixture does not chmod an existing shared ancestor', {
  skip: runtimeSkip,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'u2-schema-v1-modes-'));
  const shared = join(root, 'shared');
  const database = join(shared, 'owned', 'jobs.sqlite');
  mkdirSync(shared, { mode: 0o755 });
  chmodSync(shared, 0o755);
  createSchemaV1Fixture(database);
  try {
    assert.equal(statSync(shared).mode & 0o777, 0o755);
    assert.equal(existsSync(database), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authorization is one-time, leaves evidence unknown, and later cancellation stays pending', {
  skip: runtimeSkip,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'u2-control-auth-'));
  let clock = 100;
  const database = join(root, 'watch', 'v1', 'jobs.sqlite');
  const store = createJobStore(database, {
    trustedRoot: root,
    now: () => clock,
  });
  const reserved = store.reserve(input({ requestKey: 'auth' }));
  store.claimRunner(OWNER, reserved.job.jobId, 'auth', reserved.runnerToken);
  const first = store.decideLaunch(
    OWNER,
    reserved.job.jobId,
    'auth',
    reserved.runnerToken,
  );
  assert.equal(first.disposition, 'authorized_now');
  assert.equal(store.listResults(OWNER, reserved.job.jobId).length, 0);
  assert.equal(store.listNotices(OWNER, reserved.job.jobId).length, 0);
  clock = 0;
  const cancellation = store.requestCancellation(OWNER, reserved.job.jobId);
  assert.equal(cancellation.disposition, 'recorded');
  assert.equal(cancellation.control.cancellationRequestedAtMs, 0);
  store.close();
  const reopened = createJobStore(database, {
    trustedRoot: root,
    now: () => 200,
  });
  try {
    const observation = reopened.observeJob(OWNER, reserved.job.jobId);
    assert.equal(observation.control.launchDecision, 'authorized');
    assert.equal(observation.control.cancellationRequestedAtMs, 0);
    assert.equal(
      reopened.decideLaunch(
        OWNER,
        reserved.job.jobId,
        'auth',
        reserved.runnerToken,
      ).disposition,
      'already_decided',
    );
    assert.equal(
      reopened.requestCancellation(OWNER, reserved.job.jobId).disposition,
      'already_recorded',
    );
  } finally {
    closeFixture(root, reopened);
  }
});

test('control operations preserve owner, claim, capability, and missing-control fences', {
  skip: runtimeSkip,
}, () => {
  const { root, store } = fixture();
  const reserved = store.reserve(input({ requestKey: 'fences' }));
  const missing = '99999999-9999-4999-8999-999999999999';
  const expectNotFound = (operation: () => unknown): void => {
    assert.throws(
      operation,
      (error: unknown) =>
        error instanceof StoreError && error.code === 'NOT_FOUND',
    );
  };
  try {
    expectNotFound(() =>
      store.requestCancellation(OTHER_OWNER, reserved.job.jobId),
    );
    expectNotFound(() => store.requestCancellation(OWNER, missing));
    expectNotFound(() =>
      store.decideLaunch(
        OTHER_OWNER,
        reserved.job.jobId,
        'fences',
        reserved.runnerToken,
      ),
    );
    expectNotFound(() =>
      store.decideLaunch(OWNER, missing, 'fences', reserved.runnerToken),
    );
    assert.throws(
      () =>
        store.decideLaunch(
          OWNER,
          reserved.job.jobId,
          'fences',
          reserved.runnerToken,
        ),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'CLAIM_TAKEN',
    );
    store.claimRunner(
      OWNER,
      reserved.job.jobId,
      'fences',
      reserved.runnerToken,
    );
    assert.throws(
      () =>
        store.decideLaunch(OWNER, reserved.job.jobId, 'fences', 'wrong-token'),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'CLAIM_TAKEN',
    );
    assert.throws(
      () => store.decideLaunch(OWNER, reserved.job.jobId, 'fences', null),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'CLAIM_TAKEN',
    );
    assert.throws(
      () =>
        store.decideLaunch(
          OWNER,
          reserved.job.jobId,
          'wrong',
          reserved.runnerToken,
        ),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'CLAIM_TAKEN',
    );
    assert.equal(
      store.observeJob(OWNER, reserved.job.jobId).control.launchDecision,
      null,
    );
    store.close();
    const raw = new DatabaseSync(join(root, 'watch', 'v1', 'jobs.sqlite'));
    raw
      .prepare('DELETE FROM job_control WHERE job_id = ?')
      .run(reserved.job.jobId);
    raw.close();
    const reopened = createJobStore(join(root, 'watch', 'v1', 'jobs.sqlite'), {
      trustedRoot: root,
    });
    try {
      assert.throws(
        () => reopened.requestCancellation(OWNER, reserved.job.jobId),
        (error: unknown) =>
          error instanceof StoreError && error.code === 'STORE_CORRUPT',
      );
      assert.throws(
        () =>
          reopened.decideLaunch(
            OWNER,
            reserved.job.jobId,
            'fences',
            reserved.runnerToken,
          ),
        (error: unknown) =>
          error instanceof StoreError && error.code === 'STORE_CORRUPT',
      );
    } finally {
      closeFixture(root, reopened);
    }
  } finally {
    // The store is closed above when the missing-control case is reached.
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('control write faults preserve rollback/commit receipts and disable uncertain writers', {
  skip: runtimeSkip,
}, () => {
  for (const { operation, suppression } of [
    { operation: 'request_cancellation', suppression: false },
    { operation: 'decide_launch', suppression: false },
    { operation: 'decide_launch', suppression: true },
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `u2-control-fault-${operation}-`));
    const database = join(root, 'watch', 'v1', 'jobs.sqlite');
    const seed = createJobStore(database, { trustedRoot: root });
    const reserved = seed.reserve(input({ requestKey: `fault-${operation}` }));
    if (operation === 'decide_launch') {
      seed.claimRunner(
        OWNER,
        reserved.job.jobId,
        'fault',
        reserved.runnerToken,
      );
    }
    if (suppression) {
      seed.publishUncertainResult(OWNER, reserved.job.jobId, {
        observedClaimId: 'fault',
        observedCounter: 0,
        observedRevision: 0,
      });
      seed.requestCancellation(OWNER, reserved.job.jobId);
    }
    const snapshot = (from: typeof seed) => ({
      observation: from.observeJob(OWNER, reserved.job.jobId),
      results: from.listResults(OWNER, reserved.job.jobId),
      notices: from.listNotices(OWNER, reserved.job.jobId),
    });
    const before = snapshot(seed);
    seed.close();
    let beforeHit = false;
    let afterHit = false;
    const rollback = createJobStore(database, {
      trustedRoot: root,
      hooks: {
        beforeCommit(op) {
          if (op === operation) {
            beforeHit = true;
            throw new Error('before commit');
          }
        },
      },
    });
    try {
      assert.throws(
        () => {
          if (operation === 'request_cancellation')
            rollback.requestCancellation(OWNER, reserved.job.jobId);
          else
            rollback.decideLaunch(
              OWNER,
              reserved.job.jobId,
              'fault',
              reserved.runnerToken,
            );
        },
        (error: unknown) =>
          error instanceof StoreError && error.code === 'STORE_UNAVAILABLE',
      );
      assert.equal(
        beforeHit,
        true,
        'operation must reach the injected boundary',
      );
    } finally {
      rollback.close();
    }
    const afterRollback = createJobStore(database, { trustedRoot: root });
    try {
      assert.deepEqual(
        snapshot(afterRollback),
        before,
        'all control/result/notice state must roll back',
      );
    } finally {
      afterRollback.close();
    }

    const committed = createJobStore(database, {
      trustedRoot: root,
      hooks: {
        afterCommit(op) {
          if (op === operation) {
            afterHit = true;
            throw new Error('after commit');
          }
        },
      },
    });
    try {
      assert.throws(
        () => {
          if (operation === 'request_cancellation')
            committed.requestCancellation(OWNER, reserved.job.jobId);
          else
            committed.decideLaunch(
              OWNER,
              reserved.job.jobId,
              'fault',
              reserved.runnerToken,
            );
        },
        (error: unknown) =>
          error instanceof StoreWriteError &&
          error.commitOutcome === 'committed' &&
          !('disposition' in error),
      );
      assert.equal(
        afterHit,
        true,
        'operation must reach post-commit injection',
      );
      assert.throws(
        () => committed.requestCancellation(OWNER, reserved.job.jobId),
        (error: unknown) =>
          error instanceof StoreError &&
          !(error instanceof StoreWriteError) &&
          error.code === 'STORE_UNAVAILABLE',
      );
    } finally {
      committed.close();
    }
    const reopened = createJobStore(database, { trustedRoot: root });
    try {
      const observation = reopened.observeJob(OWNER, reserved.job.jobId);
      if (operation === 'request_cancellation') {
        assert.equal(
          observation.control.cancellationRequestedAtMs !== null,
          true,
        );
      } else {
        assert.equal(
          observation.control.launchDecision,
          suppression ? 'suppressed_cancelled' : 'authorized',
        );
        if (suppression) {
          const after = snapshot(reopened);
          assert.equal(after.observation.job.state, 'settled');
          assert.equal(after.observation.finalized, true);
          assert.equal(
            after.observation.control.cancellationRequestedAtMs,
            before.observation.control.cancellationRequestedAtMs,
          );
          assert.deepEqual(
            after.results.slice(0, before.results.length),
            before.results,
          );
          assert.deepEqual(
            after.notices.slice(0, before.notices.length),
            before.notices,
          );
          assert.equal(after.results.length, before.results.length + 1);
          assert.equal(after.notices.length, before.notices.length + 1);
          assert.equal(
            after.results.at(-1)?.evidence.launch,
            'suppressed_cancelled',
          );
          assert.equal(after.notices.at(-1)?.pending, true);
        }
        assert.equal(
          reopened.decideLaunch(
            OWNER,
            reserved.job.jobId,
            'fault',
            reserved.runnerToken,
          ).disposition,
          'already_decided',
        );
      }
    } finally {
      closeFixture(root, reopened);
    }
  }
});

test('representative non-final execution facts veto launch decisions without mutation', {
  skip: runtimeSkip,
}, () => {
  const facts: EvidenceInput[] = [
    { launch: 'launched' },
    { launch: 'spawn_failed' },
    { shellCode: 0 },
    { shellSignal: 'SIGTERM' },
    { cleanupState: 'pending' },
    { cleanupTermObservation: 'returned' },
    { cleanupTermObservation: 'error' },
    { cleanupKillIntentObserved: true },
    { stdout: { available: true } },
    { stdout: { available: false } },
    { stdout: { truncated: true } },
    { stdout: { incomplete: true } },
    { stdout: { openAtCutover: true } },
    { stderr: { available: true } },
    { stderr: { available: false } },
    { stderr: { truncated: true } },
    { stderr: { incomplete: true } },
    { stderr: { openAtCutover: true } },
    { cancellationIntentObserved: true },
    { deadlineTriggerObserved: true },
  ];
  const { root, store } = fixture();
  try {
    for (const [index, evidence] of facts.entries()) {
      const reserved = store.reserve(input({ requestKey: `fact-${index}` }));
      store.claimRunner(
        OWNER,
        reserved.job.jobId,
        `fact-${index}`,
        reserved.runnerToken,
      );
      store.publishResult(
        OWNER,
        reserved.job.jobId,
        `fact-${index}`,
        null,
        evidence,
        reserved.runnerToken,
      );
      const before = store.listResults(OWNER, reserved.job.jobId);
      const decision = store.decideLaunch(
        OWNER,
        reserved.job.jobId,
        `fact-${index}`,
        reserved.runnerToken,
      );
      assert.equal(decision.disposition, 'precluded');
      assert.deepEqual(store.listResults(OWNER, reserved.job.jobId), before);
      assert.equal(decision.control.launchDecision, null);
    }
  } finally {
    closeFixture(root, store);
  }
});

test('suppression after initial uncertainty retains earlier revisions, notices, and witnesses', {
  skip: runtimeSkip,
}, () => {
  const { root, store } = fixture();
  const database = join(root, 'watch', 'v1', 'jobs.sqlite');
  try {
    const reserved = store.reserve(input({ requestKey: 'retain' }));
    store.claimRunner(
      OWNER,
      reserved.job.jobId,
      'retain',
      reserved.runnerToken,
    );
    store.publishUncertainResult(OWNER, reserved.job.jobId, {
      observedClaimId: 'retain',
      observedCounter: 0,
      observedRevision: 0,
    });
    const earlierResults = store.listResults(OWNER, reserved.job.jobId);
    const earlierNotices = store.listNotices(OWNER, reserved.job.jobId);
    const rawBefore = new DatabaseSync(database);
    const witnessesBefore = rawBefore
      .prepare('SELECT * FROM stale_witnesses WHERE job_id = ?')
      .all(reserved.job.jobId);
    rawBefore.close();
    store.heartbeat(
      OWNER,
      reserved.job.jobId,
      'retain',
      0,
      reserved.runnerToken,
    );
    store.requestCancellation(OWNER, reserved.job.jobId);
    const decision = store.decideLaunch(
      OWNER,
      reserved.job.jobId,
      'retain',
      reserved.runnerToken,
    );
    assert.equal(decision.disposition, 'suppressed_now');
    assert.deepEqual(
      store.listResults(OWNER, reserved.job.jobId)[0],
      earlierResults[0],
    );
    assert.deepEqual(
      store.listNotices(OWNER, reserved.job.jobId)[0],
      earlierNotices[0],
    );
    assert.equal(store.listResults(OWNER, reserved.job.jobId).length, 2);
    assert.equal(store.listNotices(OWNER, reserved.job.jobId).length, 2);
    const rawAfter = new DatabaseSync(database);
    const witnessesAfter = rawAfter
      .prepare('SELECT * FROM stale_witnesses WHERE job_id = ?')
      .all(reserved.job.jobId);
    rawAfter.close();
    assert.deepEqual(witnessesAfter, witnessesBefore);
  } finally {
    closeFixture(root, store);
  }
});

test('pure initial uncertainty remains eligible but established non-final facts preclude a decision', {
  skip: runtimeSkip,
}, () => {
  const { root, store } = fixture();
  try {
    const allowed = store.reserve(input({ requestKey: 'uncertain-allowed' }));
    store.claimRunner(OWNER, allowed.job.jobId, 'allowed', allowed.runnerToken);
    store.publishUncertainResult(OWNER, allowed.job.jobId, {
      observedClaimId: 'allowed',
      observedCounter: 0,
      observedRevision: 0,
    });
    assert.equal(
      store.decideLaunch(
        OWNER,
        allowed.job.jobId,
        'allowed',
        allowed.runnerToken,
      ).disposition,
      'authorized_now',
    );

    const precluded = store.reserve(input({ requestKey: 'uncertain-known' }));
    store.claimRunner(
      OWNER,
      precluded.job.jobId,
      'known',
      precluded.runnerToken,
    );
    store.publishResult(
      OWNER,
      precluded.job.jobId,
      'known',
      null,
      { cleanupState: 'pending' },
      precluded.runnerToken,
    );
    const decision = store.decideLaunch(
      OWNER,
      precluded.job.jobId,
      'known',
      precluded.runnerToken,
    );
    assert.equal(decision.disposition, 'precluded');
    assert.equal(decision.control.launchDecision, null);
    assert.equal(store.listResults(OWNER, precluded.job.jobId).length, 1);
  } finally {
    closeFixture(root, store);
  }
});

test('deadline comparison suppresses exactly at the immutable boundary', {
  skip: runtimeSkip,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'u2-control-boundary-'));
  let clock = 100;
  const store = createJobStore(join(root, 'watch', 'v1', 'jobs.sqlite'), {
    trustedRoot: root,
    now: () => clock,
  });
  try {
    const reserved = store.reserve(
      input({ requestKey: 'boundary', deadlineMs: 10 }),
    );
    store.claimRunner(
      OWNER,
      reserved.job.jobId,
      'boundary',
      reserved.runnerToken,
    );
    clock = reserved.job.deadlineAtMs;
    assert.equal(
      store.decideLaunch(
        OWNER,
        reserved.job.jobId,
        'boundary',
        reserved.runnerToken,
      ).disposition,
      'suppressed_now',
    );
  } finally {
    closeFixture(root, store);
  }
});
