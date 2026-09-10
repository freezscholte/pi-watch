import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { checkRuntimeSupport, createJobStore } from '../src/job-store.ts';
import {
  createSeededStore,
  type FaultOperation,
  runLimitedFault,
} from './fixtures/sqlite-fault.ts';

const runtimeOk = (() => {
  try {
    checkRuntimeSupport();
    return true;
  } catch {
    return false;
  }
})();
const runtimeSkip = runtimeOk
  ? false
  : 'requires Node 26 with linked SQLite >= 3.51.3';

function withSeed(
  operation: FaultOperation,
  check: (
    run: ReturnType<typeof runLimitedFault>,
    seeded: ReturnType<typeof createSeededStore>,
  ) => void,
): void {
  const seeded = createSeededStore(operation);
  try {
    const run = runLimitedFault(seeded, operation);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.signal, null);
    check(run, seeded);
    assert.equal(
      run.outcome.reopened?.jobsDigest,
      seeded.beforeJobsDigest,
      'failed operation must preserve all pre-existing job data',
    );
  } finally {
    seeded.store.close();
    rmSync(seeded.root, { recursive: true, force: true });
  }
}

function assertCommitIoerr(
  run: ReturnType<typeof runLimitedFault>,
  operation: FaultOperation,
  mappedCode = 'STORE_UNAVAILABLE',
): void {
  assert.equal(run.outcome.operation, operation);
  assert.equal(run.outcome.nativeFault?.code, 'ERR_SQLITE_ERROR');
  assert.equal(run.outcome.nativeFault?.stage, 'commit');
  assert.equal(run.outcome.nativeFault?.errcode, 778);
  assert.equal(run.outcome.nativeFault?.errcode & 0xff, 10);
  assert.equal(run.outcome.nativeFault?.inTransaction, false);
  assert.equal(run.outcome.mapped?.code, mappedCode);
  assert.equal(run.outcome.mapped?.commitOutcome, 'unknown');
  assert.deepEqual(run.outcome.writeAfterFault, {
    name: 'StoreError',
    code: 'STORE_UNAVAILABLE',
  });
}

test('statement FULL is a native SQLITE_FULL at reserve statement, not a commit I/O error', {
  skip: runtimeSkip,
}, () => {
  withSeed('statement_full', (run) => {
    assert.equal(run.outcome.operation, 'statement_full');
    assert.equal(run.outcome.nativeFault?.code, 'ERR_SQLITE_ERROR');
    assert.equal(run.outcome.nativeFault?.stage, 'statement');
    assert.equal(run.outcome.reopened?.targetPresent, false);
    assert.equal(run.outcome.nativeFault?.errcode, 13);
    assert.equal(run.outcome.nativeFault?.errcode & 0xff, 13);
    assert.equal(run.outcome.mapped?.code, 'STORE_UNAVAILABLE');
    assert.equal(run.outcome.reopened?.jobCount, 24);
    assert.equal(run.outcome.reopened?.resultCount, 0);
    assert.equal(run.outcome.reopened?.noticeCount, 0);
  });
});

test('native COMMIT IOERR at reserve preserves unknown acceptance and rollback evidence after reopen', {
  skip: runtimeSkip,
}, () => {
  withSeed('reserve', (run) => {
    assertCommitIoerr(run, 'reserve', 'ACCEPTANCE_UNCONFIRMED');
    assert.equal(run.outcome.reopened?.targetPresent, false);
    assert.equal(run.outcome.mapped?.name, 'AmbiguousAcceptanceError');
    assert.equal(run.outcome.mapped?.commitOutcome, 'unknown');
    assert.equal(
      run.outcome.mapped?.candidateJobId,
      '11111111-2222-4333-8444-555555555552',
    );
    assert.equal(run.outcome.reopened?.jobCount, 24);
    assert.equal(run.outcome.reopened?.resultCount, 0);
    assert.equal(run.outcome.reopened?.noticeCount, 0);
  });
});

test('native COMMIT IOERR at runner claim leaves the reservation claimable after reopen', {
  skip: runtimeSkip,
}, () => {
  withSeed('claim_runner', (run) => {
    assertCommitIoerr(run, 'claim_runner');
    assert.equal(run.outcome.mapped?.name, 'StoreWriteError');
    assert.equal(run.outcome.reopened?.jobCount, 25);
    assert.equal(run.outcome.reopened?.state, 'reserved');
    assert.equal(run.outcome.reopened?.claimId, null);
    assert.equal(run.outcome.reopened?.heartbeatCounter, 0);
    assert.equal(run.outcome.reopened?.latestRevision, 0);
    assert.equal(run.outcome.reopened?.resultCount, 0);
    assert.equal(run.outcome.reopened?.noticeCount, 0);
  });
});

test('native COMMIT IOERR at heartbeat preserves the consumed claim and counter after reopen', {
  skip: runtimeSkip,
}, () => {
  withSeed('heartbeat', (run) => {
    assertCommitIoerr(run, 'heartbeat');
    assert.equal(run.outcome.replacementClaimCode, 'CLAIM_TAKEN');
    assert.equal(run.outcome.mapped?.name, 'StoreWriteError');
    assert.equal(run.outcome.reopened?.jobCount, 25);
    assert.equal(run.outcome.reopened?.state, 'claimed');
    assert.equal(run.outcome.reopened?.claimId, 'fault-claim-1');
    assert.equal(run.outcome.reopened?.heartbeatCounter, 0);
    assert.equal(run.outcome.reopened?.latestRevision, 0);
    assert.equal(run.outcome.reopened?.resultCount, 0);
    assert.equal(run.outcome.reopened?.noticeCount, 0);
  });
});

test('native COMMIT IOERR at result publication leaves result and pending notice atomic after reopen', {
  skip: runtimeSkip,
}, () => {
  withSeed('publish_result', (run) => {
    assertCommitIoerr(run, 'publish_result');
    assert.equal(run.outcome.replacementClaimCode, 'CLAIM_TAKEN');
    assert.equal(run.outcome.mapped?.name, 'StoreWriteError');
    assert.equal(run.outcome.reopened?.jobCount, 25);
    assert.equal(run.outcome.reopened?.state, 'claimed');
    assert.equal(run.outcome.reopened?.claimId, 'fault-claim-1');
    assert.equal(run.outcome.reopened?.latestRevision, 0);
    assert.equal(run.outcome.reopened?.finalized, false);
    assert.equal(run.outcome.reopened?.resultCount, 0);
    assert.equal(run.outcome.reopened?.noticeCount, 0);
  });
});

test('native COMMIT IOERR at uncertain publication rolls back result, notice, and consumed witness', {
  skip: runtimeSkip,
}, () => {
  withSeed('publish_uncertain', (run, seeded) => {
    assertCommitIoerr(run, 'publish_uncertain');
    assert.equal(run.outcome.mapped?.name, 'StoreWriteError');
    assert.equal(run.outcome.reopened?.state, 'reserved');
    assert.equal(run.outcome.reopened?.claimId, null);
    assert.equal(run.outcome.reopened?.heartbeatCounter, 0);
    assert.equal(run.outcome.reopened?.latestRevision, 0);
    assert.equal(run.outcome.reopened?.finalized, false);
    assert.equal(run.outcome.reopened?.resultCount, 0);
    assert.equal(run.outcome.reopened?.noticeCount, 0);
    assert.ok(seeded.job);

    // This fresh parent-process connection has no child file cap. Reusing the
    // exact witness proves rollback did not leave a consumed stale_witnesses row.
    const recovered = createJobStore(seeded.dbPath, {
      trustedRoot: seeded.root,
    });
    try {
      const { ownerUuid, jobId } = seeded.job;
      const result = recovered.publishUncertainResult(ownerUuid, jobId, {
        observedClaimId: null,
        observedCounter: 0,
        observedRevision: 0,
      });
      assert.equal(result.revision, 1);
      assert.equal(result.evidence.finalized, false);
      assert.equal(recovered.listResults(ownerUuid, jobId).length, 1);
      const notices = recovered.listNotices(ownerUuid, jobId);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.revision, 1);
      assert.equal(notices[0]?.pending, true);
      const observation = recovered.observeJob(ownerUuid, jobId);
      assert.equal(observation.claimId, null);
      assert.equal(observation.finalized, false);
    } finally {
      recovered.close();
    }
  });
});

test('fault sensitivity: raising the child file cap permits the same claim commit without a native fault', {
  skip: runtimeSkip,
}, () => {
  const seeded = createSeededStore('claim_runner');
  try {
    const run = runLimitedFault(seeded, 'claim_runner', 1024);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.outcome.nativeFault, null);
    assert.equal(run.outcome.mapped, null);
    assert.equal(run.outcome.reopened?.state, 'claimed');
    assert.equal(run.outcome.reopened?.claimId, 'fault-claim-1');
  } finally {
    seeded.store.close();
    rmSync(seeded.root, { recursive: true, force: true });
  }
});
