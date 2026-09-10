import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveCwd,
  validateCommand,
  validateDeadlineMs,
  validateRequestKey,
} from '../src/job-types.ts';

test('command validation accepts only nonempty, NUL-free, well-formed Unicode strings', () => {
  assert.equal(validateCommand('echo hello'), 'echo hello');
  // Exact comparison: no trimming, no Unicode normalization.
  assert.equal(validateCommand(' echo hello '), ' echo hello ');
  assert.equal(validateCommand('echo ＨＥＬＬＯ'), 'echo ＨＥＬＬＯ');
  for (const bad of [
    '',
    '   ',
    'echo \u0000 hi',
    42,
    null,
    undefined,
    'lone \ud800 surrogate',
  ]) {
    assert.throws(
      () => validateCommand(bad),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'VALIDATION_FAILED',
      String(bad),
    );
  }
});

test('deadline validation defaults to 30 minutes and bounds 1..24h as integers', () => {
  assert.equal(validateDeadlineMs(undefined), 1_800_000);
  assert.equal(validateDeadlineMs(1), 1);
  assert.equal(validateDeadlineMs(86_400_000), 86_400_000);
  for (const bad of [
    0,
    -1,
    86_400_001,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '60000',
    null,
  ]) {
    assert.throws(
      () => validateDeadlineMs(bad),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'VALIDATION_FAILED',
      String(bad),
    );
  }
});

test('request key syntax: 1..128 ASCII, strict pattern, no trimming or case folding', () => {
  assert.equal(validateRequestKey('a'), 'a');
  assert.equal(validateRequestKey('Key_01.b:c-d'), 'Key_01.b:c-d');
  assert.equal(validateRequestKey('UPPER_ok'), 'UPPER_ok');
  assert.equal(validateRequestKey('x'.repeat(128)), 'x'.repeat(128));
  for (const bad of [
    '',
    '_starts-with-underscore',
    '.dot',
    '9'.repeat(129),
    'has space',
    'slash/key',
    'tab\tkey',
    'unicode-é',
  ]) {
    assert.throws(
      () => validateRequestKey(bad),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'VALIDATION_FAILED',
      String(bad),
    );
  }
});

test('cwd resolution is lexical, absolute, NUL-free, and never uses realpath', () => {
  const base = '/tmp/base';
  assert.equal(resolveCwd(undefined, base), '/tmp/base');
  assert.equal(resolveCwd('sub/dir', base), '/tmp/base/sub/dir');
  assert.equal(resolveCwd('/abs/cwd', base), '/abs/cwd');
  // Trailing-dot normalization is lexical, not filesystem realpath.
  assert.equal(resolveCwd('sub/../sub2', base), '/tmp/base/sub2');
  assert.throws(
    () => resolveCwd('bad\u0000cwd', base),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'VALIDATION_FAILED',
  );
  assert.throws(
    () => resolveCwd('', base),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'VALIDATION_FAILED',
  );
});

// ---------------------------------------------------------------------------
// Durable store (SQLite) — scenario slices below. All SQLite-backed tests are
// scoped to runtimes that pass the engine preflight (Node 26, SQLite>=3.51.3).
// ---------------------------------------------------------------------------
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  checkRuntimeSupport,
  createJobStore,
  type JobStore,
  type ReservationInput,
} from '../src/job-store.ts';
import { StoreError, StoreWriteError, toDiagnostic } from '../src/job-types.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function treeEntries(root: string): string[] {
  const entries: string[] = [];
  const visit = (current: string, relative: string): void => {
    for (const name of fs.readdirSync(current)) {
      const childRelative = relative === '' ? name : join(relative, name);
      entries.push(childRelative);
      if (fs.lstatSync(join(current, name)).isDirectory()) {
        visit(join(current, name), childRelative);
      }
    }
  };
  visit(root, '');
  return entries.sort();
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const OTHER_OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    assert.ok(
      error instanceof StoreError,
      `expected StoreError, got ${String(error)}`,
    );
    return error.code;
  }
  assert.fail('expected the operation to throw');
}

function expectStoreError(operation: () => unknown, code: string): void {
  assert.equal(errorCode(operation), code);
}

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

function dbPath(dir: string): string {
  return join(realpathSync(dir), 'watch', 'v1', 'jobs.sqlite');
}

function openStore(
  dir: string,
  options?: Partial<Parameters<typeof createJobStore>[1]>,
): JobStore {
  // Helpers always supply their disposable fixture root; per-call overrides
  // (e.g. hooks) are merged on top of the default trusted root.
  return createJobStore(join(dir, 'watch', 'v1', 'jobs.sqlite'), {
    trustedRoot: dir,
    ...options,
  });
}

function reservationInput(
  overrides: Partial<ReservationInput> = {},
): ReservationInput {
  return {
    ownerUuid: OWNER,
    sessionPath: '/sessions/owner-session.jsonl',
    namespace: 'tool_call',
    requestKey: 'call-1',
    command: 'echo hello',
    cwd: '/tmp/base',
    ...overrides,
  };
}

test('engine preflight rejects unsupported Node major and SQLite engines before disk use', () => {
  for (const bad of [
    ['v24.11.1', '3.50.4'],
    ['v24.11.1', '3.53.4'],
    ['v26.7.0', '3.51.2'],
    ['v26.7.0', '3.50.11'],
    ['v27.1.0', '3.53.4'],
  ] as const) {
    assert.throws(
      () => checkRuntimeSupport(bad[0], bad[1]),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'RUNTIME_UNSUPPORTED',
      `${bad[0]} / ${bad[1]}`,
    );
  }
  assert.doesNotThrow(() => checkRuntimeSupport('v26.0.0', '3.51.3'));
  assert.doesNotThrow(() => checkRuntimeSupport('v26.7.0', '3.53.4'));
});

test('an actual runtime preflight is enforced before the disk store is created', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-preflight-');
  if (checkRuntimeSupport === undefined) throw new Error('unreachable');
  const store = openStore(dir);
  try {
    assert.ok(
      existsSync(dbPath(dir)),
      'store file should exist on a supported runtime',
    );
  } finally {
    store.close();
  }
});

test('same owner/key/inputs return one reservation across independent connections', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-replay-');
  const first = openStore(dir);
  const second = openStore(dir);
  try {
    const created = first.reserve(reservationInput());
    assert.equal(created.created, true);
    const reused = second.reserve(reservationInput());
    assert.equal(reused.created, false);
    assert.equal(reused.job.jobId, created.job.jobId);
    assert.equal(reused.job.acceptedAtMs, created.job.acceptedAtMs);
    assert.equal(reused.job.deadlineAtMs, created.job.deadlineAtMs);
    assert.equal(reused.job.deadlineMs, created.job.deadlineMs);

    for (const conflict of [
      reservationInput({ command: 'echo changed' }),
      reservationInput({ cwd: '/tmp/other' }),
      reservationInput({ deadlineMs: 60_000 }),
    ]) {
      assert.equal(
        errorCode(() => second.reserve(conflict)),
        'REQUEST_KEY_CONFLICT',
      );
    }
  } finally {
    first.close();
    second.close();
  }
});

test('different owners, keys, and namespaces stay independent', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-independent-');
  const store = openStore(dir);
  try {
    const base = store.reserve(reservationInput());
    for (const independent of [
      reservationInput({ ownerUuid: OTHER_OWNER }),
      reservationInput({ requestKey: 'call-2' }),
      reservationInput({ namespace: 'explicit' }),
    ]) {
      const result = store.reserve(independent);
      assert.equal(result.created, true);
      assert.notEqual(result.job.jobId, base.job.jobId);
    }
  } finally {
    store.close();
  }
});

test('invalid input rejects before any reservation is written', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-invalid-');
  const store = openStore(dir);
  try {
    for (const bad of [
      reservationInput({ command: '' }),
      reservationInput({ command: 'echo \u0000' }),
      reservationInput({ requestKey: '_bad' }),
      reservationInput({ requestKey: '' }),
      reservationInput({ deadlineMs: 0 }),
      reservationInput({ deadlineMs: 1.5 }),
      reservationInput({ deadlineMs: 86_400_001 }),
      reservationInput({ namespace: 'weird' as never }),
      reservationInput({ ownerUuid: 'not-a-uuid' }),
      reservationInput({ cwd: '' }),
      reservationInput({ cwd: 'bad\u0000cwd' }),
    ]) {
      expectStoreError(() => store.reserve(bad), 'VALIDATION_FAILED');
    }
    assert.deepEqual(store.listJobs(OWNER), []);
    // Conflicting compared inputs never authorize launch and never mutate.
    store.reserve(reservationInput());
    assert.equal(
      errorCode(() => store.reserve(reservationInput({ command: 'other' }))),
      'REQUEST_KEY_CONFLICT',
    );
    assert.equal(store.listJobs(OWNER).length, 1);
  } finally {
    store.close();
  }
});

test('replay comparison is exact and cwd comparison is lexical; default deadlines are equivalent', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-lexical-');
  const store = openStore(dir);
  try {
    // Lexical cwd: the adapter resolves relative/absolute paths lexically
    // (resolveCwd) before reservation; the store compares the resulting
    // absolute lexical strings exactly.
    const first = store.reserve(
      reservationInput({ cwd: resolveCwd('sub2', '/tmp/base') }),
    );
    const sameLexical = store.reserve(
      reservationInput({ cwd: resolveCwd('sub/../sub2', '/tmp/base') }),
    );
    assert.equal(sameLexical.created, false);
    assert.equal(sameLexical.job.jobId, first.job.jobId);

    // Omitted deadline equals the explicit 30-minute default.
    const withDefault = store.reserve(
      reservationInput({ requestKey: 'call-d' }),
    );
    const explicitDefault = store.reserve(
      reservationInput({ requestKey: 'call-d', deadlineMs: 1_800_000 }),
    );
    assert.equal(explicitDefault.created, false);
    assert.equal(explicitDefault.job.jobId, withDefault.job.jobId);

    // Exact command comparison: whitespace differences are a different command.
    const spaced = store.reserve(
      reservationInput({ requestKey: 'call-w', command: 'echo  hello' }),
    );
    assert.equal(spaced.created, true);
    assert.equal(
      errorCode(() =>
        store.reserve(
          reservationInput({ requestKey: 'call-w', command: 'echo hello' }),
        ),
      ),
      'REQUEST_KEY_CONFLICT',
    );
    const reusedSpaced = store.reserve(
      reservationInput({ requestKey: 'call-w', command: 'echo  hello' }),
    );
    assert.equal(reusedSpaced.created, false);
    assert.equal(reusedSpaced.job.jobId, spaced.job.jobId);
  } finally {
    store.close();
  }
});

test('environment is never persisted: reservation reuse does not depend on it', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-env-');
  const store = openStore(dir);
  try {
    // Environment capture happens only at launch and is never a stored or
    // compared input; the store API has no environment field by construction.
    const first = store.reserve(reservationInput());
    const second = store.reserve(reservationInput());
    assert.equal(second.created, false);
    assert.equal(second.job.jobId, first.job.jobId);
    const serialized = JSON.stringify(store.listJobs(OWNER));
    assert.ok(
      !serialized.includes('PATH='),
      'no environment snapshot in job records',
    );
  } finally {
    store.close();
  }
});

test('job records are owner-scoped: foreign owners cannot read or list them', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-scoped-');
  const store = openStore(dir);
  try {
    const { job } = store.reserve(reservationInput());
    assert.deepEqual(store.listJobs(OTHER_OWNER), []);
    assert.equal(
      errorCode(() => store.getJob(OTHER_OWNER, job.jobId)),
      'NOT_FOUND',
    );
    assert.equal(store.getJob(OWNER, job.jobId).jobId, job.jobId);
    assert.equal(store.listJobs(OWNER).length, 1);
  } finally {
    store.close();
  }
});

test('a newer schema refuses safely without modifying the store', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-newer-');
  openStore(dir).close();
  const raw = new DatabaseSync(dbPath(dir));
  raw
    .prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'")
    .run();
  raw.close();
  assert.equal(
    errorCode(() => openStore(dir)),
    'SCHEMA_TOO_NEW',
  );
  // The store was not modified by the refusal attempt.
  const probe = new DatabaseSync(dbPath(dir));
  const version = probe
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  probe.close();
  assert.equal((version as { value: string }).value, '999');
});

test('JavaScript beforeCommit simulation at reservation rolls back completely and the store stays usable', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-full-');
  let failNextReserve = false;
  const store = openStore(dir, {
    hooks: {
      beforeCommit: (op: string) => {
        if (failNextReserve && op === 'reserve') {
          throw new Error('SQLITE_FULL: database or disk is full');
        }
      },
    },
  });
  try {
    const first = store.reserve(reservationInput());
    failNextReserve = true;
    // Simulated engine failure (controlled injection, not a real disk-full guarantee).
    assert.equal(
      errorCode(() =>
        store.reserve(reservationInput({ requestKey: 'call-2' })),
      ),
      'STORE_UNAVAILABLE',
    );
    failNextReserve = false;
    assert.equal(
      store.listJobs(OWNER).length,
      1,
      'failed reservation rolled back',
    );
    const retry = store.reserve(reservationInput({ requestKey: 'call-2' }));
    assert.equal(retry.created, true);
    // The rolled-back attempt never existed; the retry is a fresh job.
    assert.notEqual(retry.job.jobId, first.job.jobId);
  } finally {
    store.close();
  }
});

test('JavaScript beforeCommit simulation keeps terminal result and pending notice atomic', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-atomic-');
  let failNextPublish = false;
  const store = openStore(dir, {
    hooks: {
      beforeCommit: (op: string) => {
        if (failNextPublish && op === 'publish_result') {
          throw new Error('SQLITE_IOERR: simulated I/O failure');
        }
      },
    },
  });
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);

    failNextPublish = true;
    assert.equal(
      errorCode(() =>
        store.publishResult(
          OWNER,
          job.jobId,
          'claim-1',
          null,
          {
            launch: 'launched',
            shellCode: 0,
            stdout: { available: true, incomplete: false },
            stderr: { available: true, incomplete: false },
            finalized: true,
          },
          runnerToken,
        ),
      ),
      'STORE_UNAVAILABLE',
    );
    failNextPublish = false;
    assert.deepEqual(
      store.listResults(OWNER, job.jobId),
      [],
      'no result survives a failed commit',
    );
    assert.deepEqual(
      store.listNotices(OWNER, job.jobId),
      [],
      'no notice survives a failed commit',
    );

    store.publishResult(
      OWNER,
      job.jobId,
      'claim-1',
      null,
      {
        launch: 'launched',
        shellCode: 0,
        stdout: { available: true, incomplete: false },
        stderr: { available: true, incomplete: false },
        finalized: true,
      },
      runnerToken,
    );
    const results = store.listResults(OWNER, job.jobId);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.revision, 1);
    const notices = store.listNotices(OWNER, job.jobId);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.revision, 1);
    assert.equal(notices[0]?.pending, true);

    // No recovery path grants new launch authority: the claim stays consumed.
    assert.equal(
      errorCode(() =>
        store.claimRunner(OWNER, job.jobId, 'claim-2', runnerToken),
      ),
      'CLAIM_TAKEN',
    );
  } finally {
    store.close();
  }
});

test('private filesystem modes: 0700 directories, 0600 database and sidecars, umask untouched', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-modes-');
  const umaskBefore = process.umask();
  try {
    const store = openStore(dir);
    try {
      store.reserve(reservationInput());
      assert.equal(statSync(dirname(dbPath(dir))).mode & 0o777, 0o700);
      assert.equal(statSync(dbPath(dir)).mode & 0o777, 0o600);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = dbPath(dir) + suffix;
        if (existsSync(sidecar)) {
          assert.equal(statSync(sidecar).mode & 0o777, 0o600, sidecar);
        }
      }
    } finally {
      store.close();
    }
  } finally {
    process.umask(umaskBefore);
  }
  assert.equal(
    process.umask(),
    umaskBefore,
    'process-wide umask must not change',
  );
});

test('symlinked or wrong-type store components reject without touching outside targets', {
  skip: runtimeSkip,
}, () => {
  // Database path preseeded as a symlink to an outside file.
  const dir = tempDir('u1-store-symlink-');
  const outsideDir = tempDir('u1-store-outside-');
  const sentinel = join(outsideDir, 'sentinel.txt');
  writeFileSync(sentinel, 'untouched');
  const preseeded = join(dir, 'preseeded');
  mkdirSync(preseeded, { mode: 0o700 });
  symlinkSync(sentinel, join(preseeded, 'jobs.sqlite'));
  assert.equal(
    errorCode(() =>
      createJobStore(join(preseeded, 'jobs.sqlite'), { trustedRoot: dir }),
    ),
    'PATH_UNSAFE',
  );
  assert.equal(readFileSync(sentinel, 'utf8'), 'untouched');
  assert.ok(!existsSync(`${sentinel}-wal`), 'no sidecar created at the target');

  // Database path preseeded as a directory (wrong type).
  const dirDb = join(dir, 'dirdb');
  mkdirSync(dirDb, { mode: 0o700 });
  mkdirSync(join(dirDb, 'watch'), { mode: 0o700 });
  mkdirSync(join(dirDb, 'watch', 'v1'), { mode: 0o700 });
  mkdirSync(join(dirDb, 'watch', 'v1', 'jobs.sqlite'), { mode: 0o700 });
  assert.equal(
    errorCode(() => openStore(dirDb)),
    'PATH_UNSAFE',
  );

  // Parent directory preseeded as a symlink to an outside directory.
  const parentLink = join(dir, 'parentlink');
  symlinkSync(outsideDir, parentLink);
  const outsideBefore = treeEntries(outsideDir);
  const db = join(parentLink, 'jobs.sqlite');
  assert.equal(
    errorCode(() => createJobStore(db, { trustedRoot: dir })),
    'PATH_UNSAFE',
  );
  assert.deepEqual(
    treeEntries(outsideDir),
    outsideBefore,
    'the complete external target subtree must remain untouched',
  );
});

test('synthetic secrets never escape store diagnostics', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-secret-');
  const secretDb = join(dir, 'TOPSECRET', 'jobs.sqlite');
  const store = createJobStore(secretDb, { trustedRoot: dir });
  try {
    const conflict = (() => {
      try {
        store.reserve(
          reservationInput({
            sessionPath: '/sessions/SECRETPATH.jsonl',
            command: 'echo MYSECRETCOMMAND',
          }),
        );
        store.reserve(
          reservationInput({
            sessionPath: '/sessions/SECRETPATH.jsonl',
            command: 'echo changed',
          }),
        );
        return null;
      } catch (error) {
        return toDiagnostic(error);
      }
    })();
    assert.ok(conflict);
    const serialized = JSON.stringify(conflict);
    assert.equal(conflict.code, 'REQUEST_KEY_CONFLICT');
    assert.ok(!serialized.includes('TOPSECRET'), serialized);
    assert.ok(!serialized.includes('MYSECRETCOMMAND'), serialized);
    assert.ok(!serialized.includes('SECRETPATH'), serialized);
  } finally {
    store.close();
  }
  // Simulated raw engine failure collapses to a bare diagnostic. The path
  // is a synthetic marker, never a machine-specific filesystem path.
  const diag = toDiagnostic(new Error('SQLITE_FULL at TOPSECRET_STORE_PATH'));
  assert.equal(diag.code, 'UNKNOWN');
  assert.equal(diag.message, undefined);
});

test('runner claim is one-time and heartbeats advance only from the observed counter', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-claim-');
  const store = openStore(dir);
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    const claim = store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
    assert.equal(claim.claimId, 'claim-1');
    assert.equal(claim.heartbeatCounter, 0);
    assert.equal(
      errorCode(() =>
        store.claimRunner(OWNER, job.jobId, 'claim-2', runnerToken),
      ),
      'CLAIM_TAKEN',
    );
    // Foreign and missing owners are indistinguishable from missing jobs.
    assert.equal(
      errorCode(() =>
        store.claimRunner(OTHER_OWNER, 'missing-job', 'claim-x', null),
      ),
      'NOT_FOUND',
    );

    assert.equal(
      store.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken).counter,
      1,
    );
    assert.equal(
      store.heartbeat(OWNER, job.jobId, 'claim-1', 1, runnerToken).counter,
      2,
    );
    assert.equal(
      errorCode(() =>
        store.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken),
      ),
      'REVISION_STALE',
    );
    assert.equal(
      errorCode(() =>
        store.heartbeat(OWNER, job.jobId, 'claim-other', 2, runnerToken),
      ),
      'REVISION_STALE',
    );
    assert.equal(
      errorCode(() =>
        store.heartbeat(OWNER, job.jobId, 'claim-1', 99, runnerToken),
      ),
      'REVISION_STALE',
    );
  } finally {
    store.close();
  }
});

test('conditional publication preserves known shell evidence and defeats stale revisions', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-cas-');
  const store = openStore(dir);
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
    store.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken);
    store.heartbeat(OWNER, job.jobId, 'claim-1', 1, runnerToken);

    // Stale expected revision loses.
    assert.equal(
      errorCode(() =>
        store.publishResult(
          OWNER,
          job.jobId,
          'claim-1',
          3,
          {
            shellCode: 1,
            finalized: true,
          },
          runnerToken,
        ),
      ),
      'REVISION_STALE',
    );

    const published = store.publishResult(
      OWNER,
      job.jobId,
      'claim-1',
      null,
      {
        launch: 'launched',
        shellCode: 0,
        stdout: { available: true, incomplete: false },
        stderr: { available: true, incomplete: false },
        finalized: true,
      },
      runnerToken,
    );
    assert.equal(published.revision, 1);

    // Known shell outcome is preserved: later writers cannot overwrite it.
    for (const stale of [
      () =>
        store.publishResult(
          OWNER,
          job.jobId,
          'claim-1',
          1,
          {
            shellCode: 2,
            finalized: true,
          },
          runnerToken,
        ),
      () =>
        store.publishResult(
          OWNER,
          job.jobId,
          'claim-1',
          null,
          {
            shellCode: 2,
            finalized: true,
          },
          runnerToken,
        ),
      () =>
        store.publishUncertainResult(OWNER, job.jobId, {
          observedClaimId: 'claim-1',
          observedCounter: 2,
          observedRevision: 1,
        }),
    ]) {
      assert.equal(errorCode(stale), 'REVISION_STALE');
    }
    assert.equal(store.listResults(OWNER, job.jobId).length, 1);
    assert.equal(store.getJob(OWNER, job.jobId).state, 'settled');
  } finally {
    store.close();
  }
});

test('stale-witness CAS: a concurrent heartbeat or duplicate reconciler defeats the uncertain write', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-witness-');
  const store = openStore(dir);
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
    store.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken);
    store.heartbeat(OWNER, job.jobId, 'claim-1', 1, runnerToken); // counter now 2

    // Stale observation (counter already advanced) is defeated.
    assert.equal(
      errorCode(() =>
        store.publishUncertainResult(OWNER, job.jobId, {
          observedClaimId: 'claim-1',
          observedCounter: 1,
          observedRevision: 0,
        }),
      ),
      'REVISION_STALE',
    );

    const witness = store.publishUncertainResult(OWNER, job.jobId, {
      observedClaimId: 'claim-1',
      observedCounter: 2,
      observedRevision: 0,
    });
    assert.equal(witness.evidence.uncertain, true);
    assert.equal(witness.evidence.finalized, false);
    // Exactly one pending notice is paired with the uncertain revision.
    const notices = store.listNotices(OWNER, job.jobId);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.revision, witness.revision);
    assert.equal(notices[0]?.pending, true);

    // Duplicate reconciler with the same observation cannot repeat.
    assert.equal(
      errorCode(() =>
        store.publishUncertainResult(OWNER, job.jobId, {
          observedClaimId: 'claim-1',
          observedCounter: 2,
          observedRevision: witness.revision - 1,
        }),
      ),
      'REVISION_STALE',
    );

    // Missing heartbeat cannot establish non-execution of a known outcome:
    // the resumed runner refines with fresh activity, preserving known facts.
    store.heartbeat(OWNER, job.jobId, 'claim-1', 2, runnerToken);
    const fresh = store.publishUncertainResult(OWNER, job.jobId, {
      observedClaimId: 'claim-1',
      observedCounter: 3,
      observedRevision: witness.revision,
    });
    assert.notEqual(fresh.revision, witness.revision);
    assert.equal(
      errorCode(() =>
        store.publishUncertainResult(OWNER, job.jobId, {
          observedClaimId: 'claim-2',
          observedCounter: 0,
          observedRevision: fresh.revision,
        }),
      ),
      'REVISION_STALE',
    );
  } finally {
    store.close();
  }
});

test('an unclaimed reservation may gain an uncertain revision; an arriving claim defeats a stale witness', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-unclaimed-');
  const store = openStore(dir);
  try {
    const { job } = store.reserve(reservationInput());
    const witness = store.publishUncertainResult(OWNER, job.jobId, {
      observedClaimId: null,
      observedCounter: 0,
      observedRevision: 0,
    });
    assert.equal(witness.evidence.uncertain, true);
    assert.equal(
      errorCode(() =>
        store.publishUncertainResult(OWNER, job.jobId, {
          observedClaimId: null,
          observedCounter: 0,
          observedRevision: 0,
        }),
      ),
      'REVISION_STALE',
    );
  } finally {
    store.close();
  }
});

test('notice acknowledgement is owner-predicated', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-ack-');
  const store = openStore(dir);
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
    store.publishResult(
      OWNER,
      job.jobId,
      'claim-1',
      null,
      {
        launch: 'launched',
        shellCode: 0,
        stdout: { available: true, incomplete: false },
        stderr: { available: true, incomplete: false },
        finalized: true,
      },
      runnerToken,
    );
    assert.equal(
      errorCode(() => store.acknowledgeNotice(OTHER_OWNER, job.jobId, 1)),
      'NOT_FOUND',
    );
    store.acknowledgeNotice(OWNER, job.jobId, 1);
    const notices = store.listNotices(OWNER, job.jobId);
    assert.equal(notices[0]?.pending, false);
    assert.notEqual(notices[0]?.acknowledgedAtMs, null);
    assert.deepEqual(store.listPendingNotices(OWNER), []);
  } finally {
    store.close();
  }
});

test('JavaScript beforeCommit simulation at runner claim or heartbeat rolls back and preserves claim state', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-claim-fail-');
  let failOp: string | null = null;
  const store = openStore(dir, {
    hooks: {
      beforeCommit: (op: string) => {
        if (failOp === op)
          throw new Error('SQLITE_IOERR: simulated I/O failure');
      },
    },
  });
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    failOp = 'claim_runner';
    assert.equal(
      errorCode(() =>
        store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken),
      ),
      'STORE_UNAVAILABLE',
    );
    failOp = null;
    // The failed claim committed nothing; the reservation is still claimable.
    const claim = store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
    assert.equal(claim.heartbeatCounter, 0);
    failOp = 'heartbeat';
    assert.equal(
      errorCode(() =>
        store.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken),
      ),
      'STORE_UNAVAILABLE',
    );
    failOp = null;
    // The failed heartbeat left the counter untouched.
    assert.equal(
      store.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken).counter,
      1,
    );
    // Reopen: complete evidence only.
    const reopened = openStore(dir);
    try {
      assert.equal(
        errorCode(() =>
          reopened.claimRunner(OWNER, job.jobId, 'claim-2', runnerToken),
        ),
        'CLAIM_TAKEN',
      );
      // Counter is 1 after the successful heartbeat; the pre-failure counter 0 is stale.
      assert.equal(
        errorCode(() =>
          reopened.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken),
        ),
        'REVISION_STALE',
      );
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});

test('a truncated schema (missing tables) refuses safely as STORE_CORRUPT without modification', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-corrupt-');
  openStore(dir).close();
  const raw = new DatabaseSync(dbPath(dir));
  raw.prepare('DROP TABLE stale_witnesses').run();
  raw.close();
  assert.equal(
    errorCode(() => openStore(dir)),
    'STORE_CORRUPT',
  );
});

test('an arriving claim between observation and commit defeats the stale witness write', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-witness-claim-');
  const store = openStore(dir);
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    // The reconciler observes an unclaimed reservation (null, 0)...
    // ...but a claim commits before the witness transaction.
    store.claimRunner(OWNER, job.jobId, 'claim-late', runnerToken);
    assert.equal(
      errorCode(() =>
        store.publishUncertainResult(OWNER, job.jobId, {
          observedClaimId: null,
          observedCounter: 0,
          observedRevision: 0,
        }),
      ),
      'REVISION_STALE',
    );
    // No revision, no notice from the defeated witness.
    assert.deepEqual(store.listResults(OWNER, job.jobId), []);
    assert.deepEqual(store.listNotices(OWNER, job.jobId), []);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// U1 correction slice: findings #1, #2, #6, #7, #8. Tests written first
// against the corrected seam shape (owner-threaded, claim-fenced,
// observation read, candidate identity, monotonic evidence).
// ---------------------------------------------------------------------------

test('observeJob exposes the claim identity, heartbeat counter and evidence revision per owner', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-observe-');
  const store = openStore(dir);
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    // Unclaimed.
    const unclaimed = store.observeJob(OWNER, job.jobId);
    assert.equal(unclaimed.claimId, null);
    assert.equal(unclaimed.heartbeatCounter, 0);
    assert.equal(unclaimed.latestRevision, 0);
    assert.equal(unclaimed.finalized, false);
    assert.equal(unclaimed.job.jobId, job.jobId);
    assert.equal(unclaimed.job.state, 'reserved');

    // Claimed with advancing heartbeat.
    store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
    store.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken);
    store.heartbeat(OWNER, job.jobId, 'claim-1', 1, runnerToken);
    const claimed = store.observeJob(OWNER, job.jobId);
    assert.equal(claimed.claimId, 'claim-1');
    assert.equal(claimed.heartbeatCounter, 2);
    assert.equal(claimed.job.state, 'claimed');

    // Final state.
    store.publishResult(
      OWNER,
      job.jobId,
      'claim-1',
      0,
      {
        launch: 'launched',
        shellCode: 0,
        cleanupState: 'unconfirmed',
        finalized: true,
      },
      runnerToken,
    );
    const settled = store.observeJob(OWNER, job.jobId);
    assert.equal(settled.finalized, true);
    assert.equal(settled.job.state, 'settled');
    assert.equal(settled.evidence.launch, 'launched');
    assert.equal(settled.evidence.shellCode, 0);
    assert.equal(settled.evidence.cleanupState, 'unconfirmed');
  } finally {
    store.close();
  }
});

test('a fresh owner constructs a stale-witness CAS from the reopened observation snapshot', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-observe-cas-');
  const first = openStore(dir);
  const { job, runnerToken } = first.reserve(reservationInput());
  first.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
  first.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken);
  first.close();

  // Reopen: the owner must not guess claim/counter/revision values.
  const reopened = openStore(dir);
  try {
    const snapshot = reopened.observeJob(OWNER, job.jobId);
    const witness = reopened.publishUncertainResult(OWNER, job.jobId, {
      observedClaimId: snapshot.claimId,
      observedCounter: snapshot.heartbeatCounter,
      observedRevision: snapshot.latestRevision,
    });
    assert.equal(witness.evidence.uncertain, true);
    assert.equal(witness.revision, snapshot.latestRevision + 1);
  } finally {
    reopened.close();
  }
});

test('observation grants no execution authority and hides foreign owners', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-observe-foreign-');
  const store = openStore(dir);
  try {
    const { job } = store.reserve(reservationInput());
    assert.equal(
      errorCode(() => store.observeJob(OTHER_OWNER, job.jobId)),
      'NOT_FOUND',
    );
    assert.equal(
      errorCode(() => store.observeJob(OWNER, 'missing-job')),
      'NOT_FOUND',
    );
    // The read is observation only: no claim is consumed, no heartbeat moves.
    const before = store.observeJob(OWNER, job.jobId);
    const after = store.observeJob(OWNER, job.jobId);
    assert.equal(after.claimId, before.claimId);
    assert.equal(after.heartbeatCounter, before.heartbeatCounter);
  } finally {
    store.close();
  }
});

test('job operations predicate on the trusted owner UUID', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-owner-fence-');
  const store = openStore(dir);
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
    expectStoreError(
      () => store.claimRunner(OTHER_OWNER, job.jobId, 'claim-x', runnerToken),
      'NOT_FOUND',
    );
    expectStoreError(
      () => store.heartbeat(OTHER_OWNER, job.jobId, 'claim-1', 0, runnerToken),
      'NOT_FOUND',
    );
    expectStoreError(
      () =>
        store.publishResult(
          OTHER_OWNER,
          job.jobId,
          'claim-1',
          0,
          {
            shellCode: 0,
            finalized: true,
          },
          runnerToken,
        ),
      'NOT_FOUND',
    );
    expectStoreError(
      () =>
        store.publishUncertainResult(OTHER_OWNER, job.jobId, {
          observedClaimId: 'claim-1',
          observedCounter: 0,
          observedRevision: 0,
        }),
      'NOT_FOUND',
    );
    expectStoreError(() => store.getJob(OTHER_OWNER, job.jobId), 'NOT_FOUND');
  } finally {
    store.close();
  }
});

test('runner-originated mutations verify the original durable claim in the same transaction', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-claim-fence-');
  const store = openStore(dir);
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    // No durable claim yet: no runner-authored mutation may write.
    expectStoreError(
      () =>
        store.publishResult(
          OWNER,
          job.jobId,
          'claim-1',
          0,
          {
            launch: 'launched',
            shellCode: 0,
            finalized: true,
          },
          runnerToken,
        ),
      'CLAIM_TAKEN',
    );
    expectStoreError(
      () => store.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken),
      'REVISION_STALE',
    );

    // The one-time claim is the only launch-capable route.
    const claim = store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
    assert.equal(claim.heartbeatCounter, 0);

    // A different claim identity cannot ride the reservation.
    expectStoreError(
      () =>
        store.publishResult(
          OWNER,
          job.jobId,
          'claim-other',
          0,
          {
            shellCode: 0,
            finalized: true,
          },
          runnerToken,
        ),
      'CLAIM_TAKEN',
    );
    // The authorized original runner can publish under its durable claim.
    const published = store.publishResult(
      OWNER,
      job.jobId,
      'claim-1',
      0,
      {
        launch: 'launched',
        shellCode: 0,
        finalized: true,
      },
      runnerToken,
    );
    assert.equal(published.evidence.finalized, true);

    // Metadata replay never grants launch authority: the claim stays consumed.
    expectStoreError(
      () => store.claimRunner(OWNER, job.jobId, 'claim-replay', runnerToken),
      'CLAIM_TAKEN',
    );
  } finally {
    store.close();
  }
});

test('only the reservation creator can authorize a runner; metadata never recovers the capability', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-creator-authority-');
  const creator = openStore(dir);
  const created = creator.reserve(reservationInput());
  creator.close();
  const reopened = openStore(dir);
  try {
    const replay = reopened.reserve(reservationInput());
    assert.equal(replay.created, false);
    expectStoreError(
      () =>
        reopened.claimRunner(
          OWNER,
          replay.job.jobId,
          'adopter',
          replay.runnerToken ?? null,
        ),
      'CLAIM_TAKEN',
    );
    assert.equal(replay.runnerToken, null);
    assert.equal(typeof created.runnerToken, 'string');
    const token = created.runnerToken;
    assert.ok(token);
    assert.ok(
      !JSON.stringify(reopened.observeJob(OWNER, created.job.jobId)).includes(
        token,
      ),
    );
    const claim = reopened.claimRunner(
      OWNER,
      created.job.jobId,
      'original',
      token,
    );
    const observation = reopened.observeJob(OWNER, created.job.jobId);
    assert.equal(observation.claimId, claim.claimId);
    assert.ok(!JSON.stringify(observation).includes(token));
    expectStoreError(
      () => reopened.claimRunner(OWNER, created.job.jobId, 'duplicate', token),
      'CLAIM_TAKEN',
    );
    expectStoreError(
      () =>
        reopened.heartbeat(OWNER, created.job.jobId, claim.claimId, 0, null),
      'CLAIM_TAKEN',
    );
    expectStoreError(
      () =>
        reopened.publishResult(
          OWNER,
          created.job.jobId,
          claim.claimId,
          0,
          { finalized: true },
          null,
        ),
      'CLAIM_TAKEN',
    );
    assert.equal(
      reopened.heartbeat(OWNER, created.job.jobId, claim.claimId, 0, token)
        .counter,
      1,
    );
    assert.equal(
      reopened.publishResult(
        OWNER,
        created.job.jobId,
        claim.claimId,
        0,
        { shellCode: 0, finalized: true },
        token,
      ).revision,
      1,
    );
  } finally {
    reopened.close();
  }
});

test('the evidence model stores independent lifecycle facts with legal transitions', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-evidence-');
  const store = openStore(dir);
  try {
    // Established non-execution allows cleanup not_required. The suppression
    // evidence is authored by the original runner under its durable claim
    // (the cancellation-first pre-spawn checkpoint follows the claim).
    const { job, runnerToken } = store.reserve(
      reservationInput({ requestKey: 'call-sup' }),
    );
    store.claimRunner(OWNER, job.jobId, 'claim-sup', runnerToken);
    const suppressed = store.publishResult(
      OWNER,
      job.jobId,
      'claim-sup',
      0,
      {
        launch: 'suppressed_cancelled',
        cancellationIntentObserved: true,
        cleanupState: 'not_required',
        finalized: true,
      },
      runnerToken,
    );
    assert.equal(suppressed.evidence.launch, 'suppressed_cancelled');
    assert.equal(suppressed.evidence.cleanupState, 'not_required');
    assert.equal(suppressed.evidence.shellCode, null);
    assert.equal(suppressed.evidence.cancellationIntentObserved, true);

    // not_required without established non-execution is illegal.
    const { job: job2, runnerToken: token2 } = store.reserve(
      reservationInput({ requestKey: 'call-evid2' }),
    );
    store.claimRunner(OWNER, job2.jobId, 'claim-2', token2);
    expectStoreError(
      () =>
        store.publishResult(
          OWNER,
          job2.jobId,
          'claim-2',
          0,
          {
            launch: 'unknown',
            cleanupState: 'not_required',
            finalized: true,
          },
          token2,
        ),
      'VALIDATION_FAILED',
    );

    // A known shell exit coexists with unconfirmed cleanup and incomplete,
    // open capture; retention truncation and incompleteness are independent
    // per stream. The first revision is deliberately non-final so the merge
    // transitions below are exercised against a live record.
    const { job: job3, runnerToken: token3 } = store.reserve(
      reservationInput({ requestKey: 'call-evid3' }),
    );
    store.claimRunner(OWNER, job3.jobId, 'claim-3', token3);
    const known = store.publishResult(
      OWNER,
      job3.jobId,
      'claim-3',
      0,
      {
        launch: 'launched',
        shellCode: 0,
        cleanupState: 'unconfirmed',
        cleanupTermObservation: 'returned',
        cleanupKillIntentObserved: true,
        deadlineTriggerObserved: true,
        stdout: { available: true, truncated: true, incomplete: false },
        stderr: {
          available: true,
          truncated: false,
          incomplete: true,
          openAtCutover: true,
        },
        finalized: false,
      },
      token3,
    );
    assert.equal(known.evidence.shellCode, 0);
    assert.equal(known.evidence.cleanupState, 'unconfirmed');
    assert.equal(known.evidence.stdout.truncated, true);
    assert.equal(known.evidence.stdout.incomplete, false);
    assert.equal(known.evidence.stderr.truncated, false);
    assert.equal(known.evidence.stderr.incomplete, true);
    assert.equal(known.evidence.stderr.openAtCutover, true);
    assert.equal(known.evidence.finalized, false);

    // A single guardian TERM attempt has one immutable return/error receipt.
    for (const cleanupTermObservation of ['error', null] as const) {
      expectStoreError(
        () =>
          store.publishResult(
            OWNER,
            job3.jobId,
            'claim-3',
            1,
            { cleanupTermObservation },
            token3,
          ),
        'VALIDATION_FAILED',
      );
    }

    // Launch regression (launched -> suppressed) is a contradiction.
    expectStoreError(
      () =>
        store.publishResult(
          OWNER,
          job3.jobId,
          'claim-3',
          1,
          {
            launch: 'suppressed_deadline',
            finalized: false,
          },
          token3,
        ),
      'VALIDATION_FAILED',
    );

    // Contradictory shell evidence is rejected.
    expectStoreError(
      () =>
        store.publishResult(
          OWNER,
          job3.jobId,
          'claim-3',
          1,
          {
            shellCode: 1,
            finalized: false,
          },
          token3,
        ),
      'VALIDATION_FAILED',
    );

    // Cleanup regression (unconfirmed -> pending) is rejected.
    expectStoreError(
      () =>
        store.publishResult(
          OWNER,
          job3.jobId,
          'claim-3',
          1,
          {
            cleanupState: 'pending',
            finalized: false,
          },
          token3,
        ),
      'VALIDATION_FAILED',
    );
    // No defeated or rejected write leaves a revision behind.
    assert.equal(store.listResults(OWNER, job3.jobId).length, 1);

    // Later finalization keeps every established fact, and a known shell
    // exit still coexists with unconfirmed cleanup and open/incomplete
    // capture in the finalized revision.
    const finalized = store.publishResult(
      OWNER,
      job3.jobId,
      'claim-3',
      1,
      {
        finalized: true,
      },
      token3,
    );
    assert.equal(finalized.evidence.finalized, true);
    assert.equal(finalized.evidence.shellCode, 0);
    assert.equal(finalized.evidence.cleanupTermObservation, 'returned');
    assert.equal(finalized.evidence.cleanupState, 'unconfirmed');
    assert.equal(finalized.evidence.stderr.openAtCutover, true);
    assert.equal(store.getJob(OWNER, job3.jobId).state, 'settled');
  } finally {
    store.close();
  }
});

test('merged evidence rejects non-execution shell and cleanup contradictions', {
  skip: runtimeSkip,
}, () => {
  type NonExecutionPhase =
    | 'suppressed_cancelled'
    | 'suppressed_deadline'
    | 'spawn_failed';
  const phases: readonly NonExecutionPhase[] = [
    'suppressed_cancelled',
    'suppressed_deadline',
    'spawn_failed',
  ];
  const outcomes = [{ shellCode: 0 }, { shellSignal: 'SIGTERM' }] as const;

  const assertUnchangedAfterReopen = (
    dir: string,
    store: JobStore,
    jobId: string,
    beforeObservation: ReturnType<JobStore['observeJob']>,
    beforeResults: ReturnType<JobStore['listResults']>,
    beforeNotices: ReturnType<JobStore['listNotices']>,
  ): void => {
    assert.deepEqual(store.observeJob(OWNER, jobId), beforeObservation);
    assert.deepEqual(store.listResults(OWNER, jobId), beforeResults);
    assert.deepEqual(store.listNotices(OWNER, jobId), beforeNotices);
    store.close();
    const reopened = openStore(dir);
    try {
      assert.deepEqual(reopened.observeJob(OWNER, jobId), beforeObservation);
      assert.deepEqual(reopened.listResults(OWNER, jobId), beforeResults);
      assert.deepEqual(reopened.listNotices(OWNER, jobId), beforeNotices);
    } finally {
      reopened.close();
    }
  };

  let caseNumber = 0;
  const nextKey = (prefix: string): string => `${prefix}-${caseNumber++}`;

  // Every non-execution phase rejects a shell code/signal merged in the same
  // revision, while explicit null/no-attempt values remain legal.
  for (const phase of phases) {
    for (const outcome of outcomes) {
      const dir = tempDir('u1-evidence-shell-same-');
      const store = openStore(dir);
      try {
        const { job, runnerToken } = store.reserve(
          reservationInput({ requestKey: nextKey('shell-same') }),
        );
        const claimId = `claim-${caseNumber}`;
        store.claimRunner(OWNER, job.jobId, claimId, runnerToken);
        const beforeObservation = store.observeJob(OWNER, job.jobId);
        const beforeResults = store.listResults(OWNER, job.jobId);
        const beforeNotices = store.listNotices(OWNER, job.jobId);
        expectStoreError(
          () =>
            store.publishResult(
              OWNER,
              job.jobId,
              claimId,
              0,
              { launch: phase, ...outcome, finalized: false },
              runnerToken,
            ),
          'VALIDATION_FAILED',
        );
        assertUnchangedAfterReopen(
          dir,
          store,
          job.jobId,
          beforeObservation,
          beforeResults,
          beforeNotices,
        );
      } catch (error) {
        store.close();
        throw error;
      }
    }
  }

  // A non-final non-execution snapshot cannot gain a shell outcome in a later
  // revision; using a live snapshot avoids REVISION_STALE masking the guard.
  for (const phase of phases) {
    for (const outcome of outcomes) {
      const dir = tempDir('u1-evidence-shell-later-');
      const store = openStore(dir);
      try {
        const { job, runnerToken } = store.reserve(
          reservationInput({ requestKey: nextKey('shell-later') }),
        );
        const claimId = `claim-${caseNumber}`;
        store.claimRunner(OWNER, job.jobId, claimId, runnerToken);
        store.publishResult(
          OWNER,
          job.jobId,
          claimId,
          0,
          { launch: phase, cleanupState: 'not_required', finalized: false },
          runnerToken,
        );
        const beforeObservation = store.observeJob(OWNER, job.jobId);
        const beforeResults = store.listResults(OWNER, job.jobId);
        const beforeNotices = store.listNotices(OWNER, job.jobId);
        expectStoreError(
          () =>
            store.publishResult(
              OWNER,
              job.jobId,
              claimId,
              1,
              { ...outcome, finalized: false },
              runnerToken,
            ),
          'VALIDATION_FAILED',
        );
        assertUnchangedAfterReopen(
          dir,
          store,
          job.jobId,
          beforeObservation,
          beforeResults,
          beforeNotices,
        );
      } catch (error) {
        store.close();
        throw error;
      }
    }
  }

  // Reverse merge order is also fenced: a known shell outcome followed by a
  // non-execution assertion cannot be persisted.
  for (const phase of phases) {
    for (const outcome of outcomes) {
      const dir = tempDir('u1-evidence-shell-reverse-');
      const store = openStore(dir);
      try {
        const { job, runnerToken } = store.reserve(
          reservationInput({ requestKey: nextKey('shell-reverse') }),
        );
        const claimId = `claim-${caseNumber}`;
        store.claimRunner(OWNER, job.jobId, claimId, runnerToken);
        store.publishResult(
          OWNER,
          job.jobId,
          claimId,
          0,
          { ...outcome, finalized: false },
          runnerToken,
        );
        const beforeObservation = store.observeJob(OWNER, job.jobId);
        const beforeResults = store.listResults(OWNER, job.jobId);
        const beforeNotices = store.listNotices(OWNER, job.jobId);
        expectStoreError(
          () =>
            store.publishResult(
              OWNER,
              job.jobId,
              claimId,
              1,
              { launch: phase, finalized: false },
              runnerToken,
            ),
          'VALIDATION_FAILED',
        );
        assertUnchangedAfterReopen(
          dir,
          store,
          job.jobId,
          beforeObservation,
          beforeResults,
          beforeNotices,
        );
      } catch (error) {
        store.close();
        throw error;
      }
    }
  }

  const cleanupCases = [
    {
      phase: 'suppressed_cancelled' as const,
      evidence: { cleanupTermObservation: 'returned' as const },
    },
    {
      phase: 'suppressed_deadline' as const,
      evidence: { cleanupTermObservation: 'error' as const },
    },
    {
      phase: 'spawn_failed' as const,
      evidence: { cleanupKillIntentObserved: true as const },
    },
  ];

  // TERM receipts and KILL intent are not compatible with not_required in the
  // same revision, but known null/false no-attempt observations are legal.
  for (const { phase, evidence } of cleanupCases) {
    const dir = tempDir('u1-evidence-cleanup-same-');
    const store = openStore(dir);
    try {
      const { job, runnerToken } = store.reserve(
        reservationInput({ requestKey: nextKey('cleanup-same') }),
      );
      const claimId = `claim-${caseNumber}`;
      store.claimRunner(OWNER, job.jobId, claimId, runnerToken);
      const beforeObservation = store.observeJob(OWNER, job.jobId);
      const beforeResults = store.listResults(OWNER, job.jobId);
      const beforeNotices = store.listNotices(OWNER, job.jobId);
      expectStoreError(
        () =>
          store.publishResult(
            OWNER,
            job.jobId,
            claimId,
            0,
            {
              launch: phase,
              cleanupState: 'not_required',
              cleanupTermObservation: null,
              cleanupKillIntentObserved: false,
              ...evidence,
              finalized: false,
            },
            runnerToken,
          ),
        'VALIDATION_FAILED',
      );
      assertUnchangedAfterReopen(
        dir,
        store,
        job.jobId,
        beforeObservation,
        beforeResults,
        beforeNotices,
      );
    } catch (error) {
      store.close();
      throw error;
    }
  }

  // Later cleanup contradictions are checked against non-final snapshots.
  for (const { phase, evidence } of cleanupCases) {
    const dir = tempDir('u1-evidence-cleanup-later-');
    const store = openStore(dir);
    try {
      const { job, runnerToken } = store.reserve(
        reservationInput({ requestKey: nextKey('cleanup-later') }),
      );
      const claimId = `claim-${caseNumber}`;
      store.claimRunner(OWNER, job.jobId, claimId, runnerToken);
      store.publishResult(
        OWNER,
        job.jobId,
        claimId,
        0,
        { launch: phase, cleanupState: 'not_required', finalized: false },
        runnerToken,
      );
      const beforeObservation = store.observeJob(OWNER, job.jobId);
      const beforeResults = store.listResults(OWNER, job.jobId);
      const beforeNotices = store.listNotices(OWNER, job.jobId);
      expectStoreError(
        () =>
          store.publishResult(
            OWNER,
            job.jobId,
            claimId,
            1,
            { ...evidence, finalized: false },
            runnerToken,
          ),
        'VALIDATION_FAILED',
      );
      assertUnchangedAfterReopen(
        dir,
        store,
        job.jobId,
        beforeObservation,
        beforeResults,
        beforeNotices,
      );
    } catch (error) {
      store.close();
      throw error;
    }
  }

  // Reverse cleanup order: an attempt receipt known while launch is unknown
  // cannot later be merged with not_required non-execution.
  for (const { phase, evidence } of cleanupCases) {
    const dir = tempDir('u1-evidence-cleanup-reverse-');
    const store = openStore(dir);
    try {
      const { job, runnerToken } = store.reserve(
        reservationInput({ requestKey: nextKey('cleanup-reverse') }),
      );
      const claimId = `claim-${caseNumber}`;
      store.claimRunner(OWNER, job.jobId, claimId, runnerToken);
      store.publishResult(
        OWNER,
        job.jobId,
        claimId,
        0,
        { ...evidence, finalized: false },
        runnerToken,
      );
      const beforeObservation = store.observeJob(OWNER, job.jobId);
      const beforeResults = store.listResults(OWNER, job.jobId);
      const beforeNotices = store.listNotices(OWNER, job.jobId);
      expectStoreError(
        () =>
          store.publishResult(
            OWNER,
            job.jobId,
            claimId,
            1,
            {
              launch: phase,
              cleanupState: 'not_required',
              finalized: false,
            },
            runnerToken,
          ),
        'VALIDATION_FAILED',
      );
      assertUnchangedAfterReopen(
        dir,
        store,
        job.jobId,
        beforeObservation,
        beforeResults,
        beforeNotices,
      );
    } catch (error) {
      store.close();
      throw error;
    }
  }

  // Established non-execution with explicit null/no-attempt facts remains a
  // valid finalized snapshot.
  for (const phase of phases) {
    const dir = tempDir('u1-evidence-cleanup-control-');
    const store = openStore(dir);
    try {
      const { job, runnerToken } = store.reserve(
        reservationInput({ requestKey: nextKey('cleanup-control') }),
      );
      const claimId = `claim-${caseNumber}`;
      store.claimRunner(OWNER, job.jobId, claimId, runnerToken);
      const result = store.publishResult(
        OWNER,
        job.jobId,
        claimId,
        0,
        {
          launch: phase,
          shellCode: null,
          shellSignal: null,
          cleanupState: 'not_required',
          cleanupTermObservation: null,
          cleanupKillIntentObserved: false,
          finalized: true,
        },
        runnerToken,
      );
      assert.equal(result.revision, 1);
      assert.equal(store.listResults(OWNER, job.jobId).length, 1);
      assert.equal(store.listNotices(OWNER, job.jobId).length, 1);
    } finally {
      store.close();
    }
  }
});

test('capture availability distinguishes unknown from unavailable across revisions and reopen', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-capture-availability-');
  const store = openStore(dir);
  let jobId: string;
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    jobId = job.jobId;
    store.claimRunner(OWNER, jobId, 'capture-claim', runnerToken);
    const initial = store.observeJob(OWNER, jobId);
    assert.equal(initial.evidence.stdout.available, null);
    assert.equal(initial.evidence.stderr.available, null);
    const first = store.publishResult(
      OWNER,
      jobId,
      'capture-claim',
      0,
      {
        stdout: { available: false, incomplete: true },
      },
      runnerToken,
    );
    assert.equal(first.evidence.stdout.available, false);
    assert.equal(first.evidence.stderr.available, null);
    const observer = openStore(dir);
    try {
      assert.deepEqual(
        observer.observeJob(OWNER, jobId).evidence,
        first.evidence,
      );
    } finally {
      observer.close();
    }
    for (const available of [true, null]) {
      expectStoreError(
        () =>
          store.publishResult(
            OWNER,
            jobId,
            'capture-claim',
            1,
            {
              stdout: { available },
            },
            runnerToken,
          ),
        'VALIDATION_FAILED',
      );
    }
    store.publishResult(
      OWNER,
      jobId,
      'capture-claim',
      1,
      {
        stderr: { available: true },
        finalized: true,
      },
      runnerToken,
    );
  } finally {
    store.close();
  }
  const reopened = openStore(dir);
  try {
    const final = reopened.observeJob(OWNER, jobId).evidence;
    assert.equal(final.stdout.available, false);
    assert.equal(final.stdout.incomplete, true);
    assert.equal(final.stderr.available, true);
  } finally {
    reopened.close();
  }
});

test('established facts survive uncertainty and later finalization; stale publishers lose', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-monotonic-');
  const store = openStore(dir);
  try {
    const { job, runnerToken } = store.reserve(reservationInput());
    store.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
    store.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken);

    // Revision 1: known, non-final evidence.
    const first = store.publishResult(
      OWNER,
      job.jobId,
      'claim-1',
      0,
      {
        launch: 'launched',
        shellCode: 0,
        stdout: { available: true },
        finalized: false,
      },
      runnerToken,
    );
    assert.equal(first.revision, 1);

    // Revision 2: stale-witness uncertainty must retain every known fact.
    const witness = store.publishUncertainResult(OWNER, job.jobId, {
      observedClaimId: 'claim-1',
      observedCounter: 1,
      observedRevision: first.revision,
    });
    assert.equal(witness.revision, 2);
    assert.equal(witness.evidence.uncertain, true);
    assert.equal(witness.evidence.launch, 'launched', 'launch fact survives');
    assert.equal(witness.evidence.shellCode, 0, 'known shell outcome survives');
    assert.equal(
      witness.evidence.stdout.available,
      true,
      'capture fact survives',
    );

    // A stale observer with a stale evidence version loses.
    expectStoreError(
      () =>
        store.publishUncertainResult(OWNER, job.jobId, {
          observedClaimId: 'claim-1',
          observedCounter: 1,
          observedRevision: 1,
        }),
      'REVISION_STALE',
    );

    // Revision 3: the surviving original runner finalizes with an exact
    // expected revision; merged facts persist.
    const final = store.publishResult(
      OWNER,
      job.jobId,
      'claim-1',
      2,
      {
        cleanupState: 'unconfirmed',
        stderr: { available: true, incomplete: true },
        finalized: true,
      },
      runnerToken,
    );
    assert.equal(final.revision, 3);
    assert.equal(final.evidence.shellCode, 0);
    assert.equal(final.evidence.launch, 'launched');
    assert.equal(final.evidence.stdout.available, true);
    assert.equal(final.evidence.stderr.incomplete, true);
    assert.equal(final.evidence.cleanupState, 'unconfirmed');

    // Null expected revision now means revision zero only: stale publishers
    // cannot append after revisions exist.
    expectStoreError(
      () =>
        store.publishResult(
          OWNER,
          job.jobId,
          'claim-1',
          null,
          {
            shellCode: 3,
            finalized: true,
          },
          runnerToken,
        ),
      'REVISION_STALE',
    );
    expectStoreError(
      () =>
        store.publishResult(
          OWNER,
          job.jobId,
          'claim-1',
          1,
          {
            shellCode: 3,
            finalized: true,
          },
          runnerToken,
        ),
      'REVISION_STALE',
    );
    // A finalized record is terminal.
    expectStoreError(
      () =>
        store.publishUncertainResult(OWNER, job.jobId, {
          observedClaimId: 'claim-1',
          observedCounter: 1,
          observedRevision: 3,
        }),
      'REVISION_STALE',
    );
  } finally {
    store.close();
  }
});

test('reopening rejects unsafe sidecars before SQLite can touch their targets', {
  skip: runtimeSkip,
}, () => {
  for (const suffix of ['-wal', '-shm']) {
    for (const kind of ['symlink', 'directory']) {
      const dir = tempDir('u1-sidecar-type-');
      openStore(dir).close();
      const sidecar = dbPath(dir) + suffix;
      const sentinel = join(dir, 'outside-target');
      writeFileSync(sentinel, 'untouched', { mode: 0o644 });
      const originalMode = statSync(sentinel).mode;
      if (kind === 'symlink') symlinkSync(sentinel, sidecar);
      else mkdirSync(sidecar);
      let opened: JobStore | undefined;
      try {
        assert.throws(
          () => {
            opened = openStore(dir);
          },
          (error: unknown) => {
            assert.ok(error instanceof StoreError);
            assert.equal(error.code, 'PATH_UNSAFE', `${suffix} ${kind}`);
            return true;
          },
        );
        assert.equal(readFileSync(sentinel, 'utf8'), 'untouched');
        assert.equal(statSync(sentinel).mode, originalMode);
        assert.equal(
          fs.lstatSync(sidecar).isSymbolicLink(),
          kind === 'symlink',
        );
        assert.equal(fs.lstatSync(sidecar).isDirectory(), kind === 'directory');
      } finally {
        opened?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test('reopening rejects unsafe sidecar permissions before SQLite access', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-sidecar-reopen-');
  const keeper = openStore(dir);
  const created = keeper.reserve(reservationInput());
  const wal = `${dbPath(dir)}-wal`;
  const originalChmod = fs.chmodSync;
  originalChmod(wal, 0o644);
  t.mock.method(
    fs,
    'chmodSync',
    (
      path: Parameters<typeof fs.chmodSync>[0],
      mode: Parameters<typeof fs.chmodSync>[1],
    ) => {
      if (path === wal)
        throw Object.assign(new Error('SIDECAR_PRIVATE_FAILURE'), {
          code: 'EACCES',
        });
      originalChmod(path, mode);
    },
  );
  syncBuiltinESMExports();
  let opened: JobStore | undefined;
  try {
    assert.throws(
      () => {
        opened = openStore(dir);
      },
      (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.code, 'PATH_UNSAFE');
        assert.ok(
          !JSON.stringify(toDiagnostic(error)).includes(
            'SIDECAR_PRIVATE_FAILURE',
          ),
        );
        return true;
      },
    );
  } finally {
    opened?.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (existsSync(wal)) originalChmod(wal, 0o600);
    keeper.close();
  }
  const reopened = openStore(dir);
  try {
    assert.equal(reopened.getJob(OWNER, created.job.jobId).state, 'reserved');
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap sidecar maintenance failure rejects opening with a committed receipt', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-bootstrap-privacy-');
  const wal = `${dbPath(dir)}-wal`;
  const originalChmod = fs.chmodSync;
  t.mock.method(
    fs,
    'chmodSync',
    (
      path: Parameters<typeof fs.chmodSync>[0],
      mode: Parameters<typeof fs.chmodSync>[1],
    ) => {
      if (path === wal)
        throw Object.assign(new Error('BOOTSTRAP_PRIVATE_FAILURE'), {
          code: 'EACCES',
        });
      originalChmod(path, mode);
    },
  );
  syncBuiltinESMExports();
  let opened: JobStore | undefined;
  try {
    assert.throws(
      () => {
        opened = openStore(dir, {
          hooks: {
            beforeCommit(op) {
              if (op === 'bootstrap') originalChmod(wal, 0o644);
            },
          },
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.code, 'STORE_UNAVAILABLE');
        assert.equal(
          (error as { commitOutcome?: string }).commitOutcome,
          'committed',
        );
        assert.ok(
          !JSON.stringify(toDiagnostic(error)).includes(
            'BOOTSTRAP_PRIVATE_FAILURE',
          ),
        );
        return true;
      },
    );
  } finally {
    opened?.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (existsSync(wal)) originalChmod(wal, 0o600);
  }
  const reopened = openStore(dir);
  try {
    assert.deepEqual(reopened.listJobs(OWNER), []);
    assert.equal(reopened.reserve(reservationInput()).created, true);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('post-commit privacy failure reports the committed identity and disables further writes', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-privacy-failure-');
  const wal = `${dbPath(dir)}-wal`;
  const originalChmod = fs.chmodSync;
  const candidate = 'c0000000-0000-4000-8000-000000000005';
  const store = openStore(dir, {
    hooks: {
      beforeCommit(op) {
        if (op === 'reserve') originalChmod(wal, 0o644);
      },
    },
  });
  t.mock.method(
    fs,
    'chmodSync',
    (
      path: Parameters<typeof fs.chmodSync>[0],
      mode: Parameters<typeof fs.chmodSync>[1],
    ) => {
      if (path === wal)
        throw Object.assign(new Error('PRIVACY_SECRET'), { code: 'EACCES' });
      originalChmod(path, mode);
    },
  );
  syncBuiltinESMExports();
  try {
    let failure: unknown;
    try {
      store.reserve(reservationInput({ candidateJobId: candidate }));
    } catch (error) {
      failure = error;
    }
    assert.ok(
      failure instanceof StoreError,
      'permission errors must not be swallowed',
    );
    assert.equal(failure.code, 'ACCEPTANCE_UNCONFIRMED');
    assert.equal(
      (failure as { commitOutcome?: string }).commitOutcome,
      'committed',
    );
    assert.equal(
      (failure as { candidateJobId?: string }).candidateJobId,
      candidate,
    );
    assert.equal('runnerToken' in failure, false);
    assert.ok(
      !JSON.stringify(toDiagnostic(failure)).includes('PRIVACY_SECRET'),
    );
    assert.equal(store.getJob(OWNER, candidate).state, 'reserved');
    expectStoreError(
      () => store.reserve(reservationInput({ requestKey: 'after-failure' })),
      'STORE_UNAVAILABLE',
    );
    assert.equal(store.listJobs(OWNER).length, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (existsSync(wal)) originalChmod(wal, 0o600);
    store.close();
  }
  const reopened = openStore(dir);
  try {
    assert.equal(reopened.getJob(OWNER, candidate).state, 'reserved');
  } finally {
    reopened.close();
  }
});

test('a lost replay response names the existing durable job, not an unused candidate', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-replay-ack-');
  const creator = openStore(dir);
  const created = creator.reserve(reservationInput());
  creator.close();
  const replay = openStore(dir, {
    hooks: {
      afterCommit(op) {
        if (op === 'reserve') throw new Error('synthetic-response-loss');
      },
    },
  });
  try {
    let failure: unknown;
    try {
      replay.reserve(
        reservationInput({
          candidateJobId: 'c0000000-0000-4000-8000-000000000004',
        }),
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof StoreError);
    assert.equal(failure.code, 'ACCEPTANCE_UNCONFIRMED');
    assert.equal(
      (failure as { candidateJobId?: string }).candidateJobId,
      created.job.jobId,
    );
    assert.equal(
      (failure as { commitOutcome?: string }).commitOutcome,
      'committed',
    );
    assert.deepEqual(replay.getJob(OWNER, created.job.jobId), created.job);
  } finally {
    replay.close();
  }
});

test('reservations preallocate the candidate identity and separate ambiguous acceptance', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-store-candidate-');
  const store = openStore(dir);
  try {
    const candidate = 'c0000000-0000-4000-8000-000000000001';
    const created = store.reserve(
      reservationInput({ candidateJobId: candidate }),
    );
    assert.equal(created.created, true);
    assert.equal(created.job.jobId, candidate);

    // Reuse preserves the original durable identity and timestamps; the
    // new candidate is not adopted for an existing reservation.
    const reused = store.reserve(
      reservationInput({
        candidateJobId: 'c0000000-0000-4000-8000-000000000002',
      }),
    );
    assert.equal(reused.created, false);
    assert.equal(reused.job.jobId, candidate);
    assert.equal(reused.job.acceptedAtMs, created.job.acceptedAtMs);
    assert.equal(reused.job.deadlineAtMs, created.job.deadlineAtMs);

    // Invalid candidate identity rejects before the transaction.
    expectStoreError(
      () =>
        store.reserve(
          reservationInput({
            requestKey: 'call-bad',
            candidateJobId: 'not-a-uuid',
          }),
        ),
      'VALIDATION_FAILED',
    );

    // Post-commit acknowledgment loss (controlled injection, finding #6):
    // the commit is durable and the typed error carries the stable candidate
    // identity — never a rollback-style error. Reopen and compare.
    const ambiguousStore = openStore(dir, {
      hooks: {
        afterCommit: (op: string) => {
          if (op === 'reserve') {
            throw new Error('acknowledgment lost after commit');
          }
        },
      },
    });
    const ambiguousCandidate = 'c0000000-0000-4000-8000-000000000003';
    let ambiguous: unknown;
    try {
      ambiguousStore.reserve(
        reservationInput({
          requestKey: 'call-ambiguous',
          candidateJobId: ambiguousCandidate,
        }),
      );
      assert.fail('expected the ambiguous-acceptance error');
    } catch (error) {
      ambiguous = error;
    }
    assert.ok(ambiguous instanceof Error);
    assert.equal(
      (ambiguous as { code?: string }).code,
      'ACCEPTANCE_UNCONFIRMED',
    );
    assert.equal(
      (ambiguous as { candidateJobId?: string }).candidateJobId,
      ambiguousCandidate,
    );
    const reopened = openStore(dir);
    try {
      const durable = reopened.getJob(OWNER, ambiguousCandidate);
      assert.equal(durable.jobId, ambiguousCandidate);
    } finally {
      reopened.close();
      ambiguousStore.close();
    }
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// U1-W3 correction slice — findings #3, #4, #5. Existing behavior is
// characterized here; focused red/green evidence is retained for new fixes.
// ---------------------------------------------------------------------------

test('(W3#3) store creation requires a trusted root: without it nothing is touched', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-w3-root-required-');
  // Cast simulates a JS caller passing no options at all; the runtime guard
  // must return a redacted StoreError, not a TypeError.
  expectStoreError(
    () =>
      createJobStore(
        dbPath(dir),
        undefined as unknown as Parameters<typeof createJobStore>[1],
      ),
    'PATH_UNSAFE',
  );
  assert.ok(
    !existsSync(dbPath(dir)),
    'store file must not be created without a trusted root',
  );
});

test('(W3#3) a database path outside the trusted root is refused', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-w3-contain-');
  const outside = tempDir('u1-w3-contain-out-');
  expectStoreError(
    () => createJobStore(join(outside, 'jobs.sqlite'), { trustedRoot: dir }),
    'PATH_UNSAFE',
  );
  // The WHOLE outside subtree stays untouched: no store file, no sidecars,
  // no watch/v1 directory tree.
  assert.deepEqual(
    fs.readdirSync(outside),
    [],
    'outside subtree must not be modified in any way',
  );
  expectStoreError(
    () => createJobStore(dir, { trustedRoot: dir }),
    'PATH_UNSAFE',
  );
  expectStoreError(
    () => createJobStore(`${dir}-sibling/jobs.sqlite`, { trustedRoot: dir }),
    'PATH_UNSAFE',
  );
});

test('(W3#3) a symlinked store component at a non-immediate ancestor rejects and leaves the target untouched', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-w3-deeplink-');
  const outside = tempDir('u1-w3-deeplink-out-');
  // Non-immediate ancestor (watch -> outside dir): recursive creation
  // must not follow this symlink.
  symlinkSync(outside, join(dir, 'watch'));
  const outsideBefore = treeEntries(outside);
  expectStoreError(() => openStore(dir), 'PATH_UNSAFE');
  assert.deepEqual(
    treeEntries(outside),
    outsideBefore,
    'the complete symlink target subtree must remain untouched',
  );
});

test('(W3#3) a legitimately symlinked trusted root is accepted', {
  skip: runtimeSkip,
}, () => {
  const real = tempDir('u1-w3-alias-real-');
  const alias = tempDir('u1-w3-alias-link-');
  const link = join(alias, 'root-alias');
  symlinkSync(real, link);
  const store = createJobStore(join(link, 'watch', 'v1', 'jobs.sqlite'), {
    trustedRoot: link,
  });
  try {
    assert.equal(store.reserve(reservationInput()).created, true);
  } finally {
    store.close();
  }
});

test('(W3#3) canonical alias spellings map to one private database path', {
  skip: runtimeSkip,
}, () => {
  const real = tempDir('u1-w3-alias-real-');
  const aliasParent = tempDir('u1-w3-alias-parent-');
  const nested = join(aliasParent, 'nested');
  mkdirSync(nested, { mode: 0o700 });
  const alias = join(nested, 'alias');
  symlinkSync(real, alias);
  const aliasDb = join(alias, 'watch', 'v1', 'jobs.sqlite');
  const canonicalRoot = realpathSync(real);
  const canonicalDb = join(canonicalRoot, 'watch', 'v1', 'jobs.sqlite');

  const viaAlias = createJobStore(aliasDb, { trustedRoot: alias });
  try {
    assert.equal(viaAlias.reserve(reservationInput()).created, true);
  } finally {
    viaAlias.close();
  }
  assert.equal(realpathSync(aliasDb), canonicalDb);
  assert.ok(existsSync(canonicalDb));
  assert.equal(statSync(canonicalDb).mode & 0o777, 0o600);

  // A canonical spelling of the same root is accepted even when the supplied
  // trusted root is the existing nested alias.
  const viaCanonical = createJobStore(
    join(canonicalRoot, 'second', 'jobs.sqlite'),
    { trustedRoot: alias },
  );
  try {
    assert.equal(
      viaCanonical.reserve(reservationInput({ requestKey: 'second' })).created,
      true,
    );
  } finally {
    viaCanonical.close();
  }
  assert.ok(existsSync(join(real, 'second', 'jobs.sqlite')));

  // A separate pre-existing alias spelling outside the supplied root is not
  // accepted merely because it points at the same canonical directory.
  const siblingAlias = join(aliasParent, 'sibling-alias');
  symlinkSync(real, siblingAlias);
  expectStoreError(
    () =>
      createJobStore(join(siblingAlias, 'escape', 'jobs.sqlite'), {
        trustedRoot: alias,
      }),
    'PATH_UNSAFE',
  );
  assert.ok(!existsSync(join(real, 'escape')));
});

test('(W3#3) overlapping root aliases transport the canonical database path', {
  skip: runtimeSkip,
}, (t) => {
  const real = realpathSync(tempDir('u1-w3-overlap-real-'));
  const alias = join(real, 'alias');
  symlinkSync(real, alias);
  const aliasDb = join(alias, 'watch', 'jobs.sqlite');
  const canonicalDb = join(realpathSync(real), 'watch', 'jobs.sqlite');
  const originalChmod = fs.chmodSync;
  const chmodPaths: string[] = [];
  t.mock.method(
    fs,
    'chmodSync',
    (
      path: Parameters<typeof fs.chmodSync>[0],
      mode: Parameters<typeof fs.chmodSync>[1],
    ) => {
      chmodPaths.push(String(path));
      return originalChmod(path, mode);
    },
  );
  syncBuiltinESMExports();
  try {
    const store = createJobStore(aliasDb, { trustedRoot: alias });
    store.close();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(!chmodPaths.some((path) => path === canonicalDb));
  assert.ok(!chmodPaths.some((path) => path === aliasDb));
  assert.ok(existsSync(canonicalDb));
});

test('(W3#3) pre-existing directories are not chmod-ed; directories created by the store are 0700', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-w3-modes-');
  // The supplied root is the last shared directory. The store must create
  // `watch` and `v1` itself at 0700 and never chmod the trusted root.
  const shared = join(dir, 'shared');
  mkdirSync(shared, { mode: 0o744 });
  const dbFile = join(shared, 'watch', 'v1', 'jobs.sqlite');
  const store = createJobStore(dbFile, { trustedRoot: shared });
  try {
    store.reserve(reservationInput());
    assert.equal(
      statSync(shared).mode & 0o777,
      0o744,
      'pre-existing dir must not be chmod-ed',
    );
    assert.equal(
      statSync(join(shared, 'watch')).mode & 0o777,
      0o700,
      'store-created dir must be 0700',
    );
    assert.equal(
      statSync(join(shared, 'watch', 'v1')).mode & 0o777,
      0o700,
      'store-created leaf dir must be 0700',
    );
    assert.equal(
      statSync(dbFile).mode & 0o777,
      0o600,
      'store file must be 0600',
    );
  } finally {
    store.close();
  }
});

test('(W3#3) pre-existing derived directories must already be private', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-w3-existing-modes-');
  const watch = join(dir, 'watch');
  const v1 = join(watch, 'v1');
  mkdirSync(v1, { recursive: true, mode: 0o700 });

  fs.chmodSync(watch, 0o755);
  fs.chmodSync(v1, 0o700);
  expectStoreError(() => openStore(dir), 'PATH_UNSAFE');
  assert.equal(statSync(watch).mode & 0o7777, 0o755);
  assert.equal(statSync(v1).mode & 0o7777, 0o700);
  assert.deepEqual(treeEntries(dir), ['watch', 'watch/v1']);

  fs.chmodSync(watch, 0o700);
  fs.chmodSync(v1, 0o755);
  expectStoreError(() => openStore(dir), 'PATH_UNSAFE');
  assert.equal(statSync(watch).mode & 0o7777, 0o700);
  assert.equal(statSync(v1).mode & 0o7777, 0o755);
  assert.deepEqual(treeEntries(dir), ['watch', 'watch/v1']);

  fs.chmodSync(v1, 0o700);
  const store = openStore(dir);
  try {
    assert.equal(store.reserve(reservationInput()).created, true);
  } finally {
    store.close();
  }
  assert.equal(statSync(watch).mode & 0o7777, 0o700);
  assert.equal(statSync(v1).mode & 0o7777, 0o700);
});

test('(W3#3) a missing database is private before SQLite opens it', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-create-mode-');
  const shared = join(dir, 'shared');
  mkdirSync(shared, { mode: 0o755 });
  const database = join(realpathSync(shared), 'jobs.sqlite');
  const originalExec = DatabaseSync.prototype.exec;
  let modeBeforeFirstExec: number | undefined;
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string): void {
      if (modeBeforeFirstExec === undefined && existsSync(database)) {
        modeBeforeFirstExec = statSync(database).mode & 0o777;
      }
      originalExec.call(this, sql);
    },
  );
  try {
    const store = createJobStore(database, { trustedRoot: shared });
    store.close();
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(modeBeforeFirstExec, 0o600);
  assert.equal(statSync(database).mode & 0o777, 0o600);
});

test('(W3#3) atomic database creation closes its descriptor on a redacted failure', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-create-failure-');
  const database = join(dir, 'jobs.sqlite');
  const originalClose = fs.closeSync;
  let closeCount = 0;
  t.mock.method(fs, 'fchmodSync', () => {
    throw Object.assign(new Error('PRIVATE_CREATE_FAILURE'), {
      code: 'EACCES',
    });
  });
  t.mock.method(fs, 'closeSync', (fd: number) => {
    closeCount += 1;
    return originalClose(fd);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => createJobStore(database, { trustedRoot: dir }),
      (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.code, 'PATH_UNSAFE');
        assert.ok(
          !JSON.stringify(toDiagnostic(error)).includes(
            'PRIVATE_CREATE_FAILURE',
          ),
        );
        return true;
      },
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(closeCount, 1);
  const reopened = createJobStore(database, { trustedRoot: dir });
  reopened.close();
  assert.equal(statSync(database).mode & 0o777, 0o600);
});

test('(W3#3) each unsafe WAL or SHM permission rejects before SQLite access', {
  skip: runtimeSkip,
}, (t) => {
  for (const unsafeSuffix of ['-wal', '-shm']) {
    const dir = tempDir(`u1-w3-reopen-${unsafeSuffix.slice(1)}-`);
    const database = dbPath(dir);
    const keeper = openStore(dir);
    try {
      keeper.reserve(reservationInput());
      const paths = [database, `${database}-wal`, `${database}-shm`];
      for (const path of paths) assert.ok(existsSync(path), path);
      fs.chmodSync(`${database}${unsafeSuffix}`, 0o644);

      const originalExec = DatabaseSync.prototype.exec;
      let execCount = 0;
      t.mock.method(
        DatabaseSync.prototype,
        'exec',
        function (this: DatabaseSync, sql: string): void {
          execCount += 1;
          originalExec.call(this, sql);
        },
      );
      assert.throws(
        () => openStore(dir),
        (error: unknown) =>
          error instanceof StoreError && error.code === 'PATH_UNSAFE',
      );
      assert.equal(
        execCount,
        0,
        'SQLite must not exec against an unsafe store',
      );
      assert.equal(statSync(database).mode & 0o777, 0o600);
      assert.equal(
        statSync(`${database}${unsafeSuffix}`).mode & 0o777,
        0o644,
        unsafeSuffix,
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      keeper.close();
    }
  }
});

test('(W3#3) close failure aborts before SQLite opens a newly created database', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-close-failure-');
  const database = dbPath(dir);
  const originalClose = fs.closeSync;
  const originalExec = DatabaseSync.prototype.exec;
  let closeCount = 0;
  let execCount = 0;
  t.mock.method(fs, 'closeSync', (descriptor: number) => {
    closeCount += 1;
    originalClose(descriptor);
    throw Object.assign(new Error('INJECTED_CLOSE_FAILURE'), { code: 'EIO' });
  });
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string): void {
      execCount += 1;
      originalExec.call(this, sql);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => openStore(dir),
      (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.code, 'STORE_UNAVAILABLE');
        assert.ok(
          !JSON.stringify(toDiagnostic(error)).includes(
            'INJECTED_CLOSE_FAILURE',
          ),
        );
        return true;
      },
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(closeCount, 1);
  assert.equal(execCount, 0, 'SQLite must not open after close failure');
  assert.ok(existsSync(database));
});

test('(W3#4) a newer schema store is refused without any mutation: bytes, mode and journal unchanged', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-w3-nonmutate-');
  // Craft a v1-era store manually: DELETE journal mode, distinct file mode.
  const dbFile = dbPath(dir);
  mkdirSync(join(dir, 'watch'), { mode: 0o700 });
  mkdirSync(dirname(dbFile), { mode: 0o700 });
  const rawSeed = new DatabaseSync(dbFile);
  rawSeed.exec(
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  );
  rawSeed
    .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '999')")
    .run();
  rawSeed.close();
  fs.chmodSync(dbFile, 0o600);
  const bytesBefore = readFileSync(dbFile);
  const modeBefore = statSync(dbFile).mode & 0o777;
  const jProbe = new DatabaseSync(dbFile);
  const journalBefore = jProbe.prepare('PRAGMA journal_mode').get();
  jProbe.close();

  assert.equal(
    errorCode(() => openStore(dir)),
    'SCHEMA_TOO_NEW',
  );

  assert.equal(
    statSync(dbFile).mode & 0o777,
    modeBefore,
    'file mode must be unchanged',
  );
  assert.deepEqual(readFileSync(dbFile), bytesBefore, 'file bytes unchanged');
  const jProbe2 = new DatabaseSync(dbFile);
  const journalAfter = jProbe2.prepare('PRAGMA journal_mode').get();
  jProbe2.close();
  assert.deepEqual(
    journalAfter,
    journalBefore,
    'journal mode must be unchanged (still DELETE, not WAL)',
  );
});

test('(W3#4) a newer version committed in WAL is refused through the read-only committed view', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-w3-newer-wal-');
  const dbFile = dbPath(dir);
  const keeper = openStore(dir);
  let writer: DatabaseSync | undefined;
  try {
    keeper.reserve(reservationInput());
    writer = new DatabaseSync(dbFile);
    writer
      .prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'")
      .run();
    // Keep both handles alive: the version update remains in the WAL rather
    // than being checkpointed away by a final close.
    assert.ok(existsSync(`${dbFile}-wal`), 'WAL sidecar must be retained');
    assert.ok(existsSync(`${dbFile}-shm`), 'SHM sidecar must be retained');
    assert.equal(
      errorCode(() => openStore(dir)),
      'SCHEMA_TOO_NEW',
    );
    assert.equal(
      (
        writer
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string }
      ).value,
      '999',
    );
  } finally {
    writer?.close();
    keeper.close();
  }
});

test('(W3#5) same-name extra schema objects and changed metadata are refused without application writes', {
  skip: runtimeSkip,
}, () => {
  for (const mutate of [
    (db: DatabaseSync) => db.exec('CREATE VIEW unexpected_view AS SELECT 1'),
    (db: DatabaseSync) =>
      db.exec('ALTER TABLE jobs ADD COLUMN unexpected TEXT'),
    (db: DatabaseSync) =>
      db
        .prepare(
          "UPDATE meta SET value = 'malformed' WHERE key = 'schema_version'",
        )
        .run(),
  ]) {
    const dir = tempDir('u1-w3-schema-identity-');
    const store = openStore(dir);
    store.reserve(reservationInput());
    store.close();
    const raw = new DatabaseSync(dbPath(dir));
    mutate(raw);
    raw.close();
    assert.equal(
      errorCode(() => openStore(dir)),
      'STORE_CORRUPT',
    );
    const verify = new DatabaseSync(dbPath(dir));
    assert.equal(
      (
        verify.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
          count: number;
        }
      ).count,
      1,
    );
    verify.close();
  }
});

test('(W3 cleanup correction) reader cleanup failure still attempts writer cleanup', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-cleanup-reader-');
  const database = dbPath(dir);
  openStore(dir).close();
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let reader: DatabaseSync | undefined;
  let writer: DatabaseSync | undefined;
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string): void {
      if (sql === 'BEGIN DEFERRED') reader = this;
      if (this === reader && sql === 'ROLLBACK')
        throw new Error('CLEANUP_READER_ROLLBACK_SECRET');
      originalExec.call(this, sql);
      if (sql === 'BEGIN IMMEDIATE') writer = this;
    },
  );
  t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string, ...args: unknown[]) {
      if (this === writer && sql.includes('FROM sqlite_schema'))
        throw Object.assign(new Error('CLEANUP_WRITER_VALIDATION_SECRET'), {
          errcode: 10,
        });
      return Reflect.apply(originalPrepare, this, [sql, ...args] as never);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => openStore(dir),
      (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.code, 'STORE_UNAVAILABLE');
        const diagnostic = JSON.stringify(toDiagnostic(error));
        assert.ok(!diagnostic.includes('CLEANUP_READER_ROLLBACK_SECRET'));
        assert.ok(!diagnostic.includes('CLEANUP_WRITER_VALIDATION_SECRET'));
        return true;
      },
    );
    assert.equal(reader?.isOpen, false, 'reader close was attempted');
    assert.equal(writer?.isOpen, false, 'writer close must not be skipped');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    try {
      if (reader?.isOpen) reader.close();
    } catch {
      // Test-owned cleanup is best effort after the assertion.
    }
    try {
      if (writer?.isOpen) writer.close();
    } catch {
      // Test-owned cleanup is best effort after the assertion.
    }
  }
  const independent = new DatabaseSync(database, { timeout: 200 });
  try {
    assert.doesNotThrow(() => independent.exec('PRAGMA user_version = 41'));
  } finally {
    independent.close();
  }
});

test('(W3 cleanup correction) committed bootstrap receipt survives candidate close failure', {
  skip: runtimeSkip,
}, (t) => {
  const controlDir = tempDir('u1-w3-cleanup-control-');
  openStore(controlDir).close();
  assert.throws(
    () =>
      openStore(controlDir, {
        hooks: {
          afterCommit(op) {
            if (op === 'bootstrap')
              throw new Error('POSTCOMMIT_CONTROL_SECRET');
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof StoreWriteError);
      assert.equal(error.code, 'STORE_UNAVAILABLE');
      assert.equal(error.commitOutcome, 'committed');
      assert.ok(
        !JSON.stringify(toDiagnostic(error)).includes(
          'POSTCOMMIT_CONTROL_SECRET',
        ),
      );
      return true;
    },
  );
  const controlReopen = openStore(controlDir);
  controlReopen.close();

  const dir = tempDir('u1-w3-cleanup-committed-');
  const database = dbPath(dir);
  openStore(dir).close();
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  let writer: DatabaseSync | undefined;
  let closeCalls = 0;
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string): void {
      originalExec.call(this, sql);
      if (sql === 'BEGIN IMMEDIATE') writer = this;
    },
  );
  t.mock.method(
    DatabaseSync.prototype,
    'close',
    function (this: DatabaseSync): void {
      if (this === writer && closeCalls++ === 0)
        throw new Error('CLEANUP_COMMITTED_CLOSE_SECRET');
      originalClose.call(this);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        openStore(dir, {
          hooks: {
            afterCommit(op) {
              if (op === 'bootstrap') throw new Error('POSTCOMMIT_SECRET');
            },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof StoreWriteError);
        assert.equal(error.code, 'STORE_UNAVAILABLE');
        assert.equal(error.commitOutcome, 'committed');
        const diagnostic = JSON.stringify(toDiagnostic(error));
        assert.ok(!diagnostic.includes('CLEANUP_COMMITTED_CLOSE_SECRET'));
        assert.ok(!diagnostic.includes('POSTCOMMIT_SECRET'));
        return true;
      },
    );
    assert.equal(closeCalls, 1, 'candidate close was attempted once');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    try {
      if (writer?.isOpen) writer.close();
    } catch {
      // Test-owned cleanup is best effort after the assertion.
    }
  }
  const reopened = openStore(dir);
  reopened.close();
  assert.ok(existsSync(database));
});

test('(W3 cleanup correction) unknown bootstrap receipt survives candidate close failure', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-cleanup-unknown-');
  openStore(dir).close();
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  let writer: DatabaseSync | undefined;
  let closeCalls = 0;
  let commitCalls = 0;
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string): void {
      if (sql === 'BEGIN IMMEDIATE') writer = this;
      if (this === writer && sql === 'COMMIT' && commitCalls++ === 0)
        throw new Error('CLEANUP_UNKNOWN_COMMIT_SECRET');
      originalExec.call(this, sql);
    },
  );
  t.mock.method(
    DatabaseSync.prototype,
    'close',
    function (this: DatabaseSync): void {
      if (this === writer && closeCalls++ === 0)
        throw new Error('CLEANUP_UNKNOWN_CLOSE_SECRET');
      originalClose.call(this);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => openStore(dir),
      (error: unknown) => {
        assert.ok(error instanceof StoreWriteError);
        assert.equal(error.code, 'STORE_UNAVAILABLE');
        assert.equal(error.commitOutcome, 'unknown');
        const diagnostic = JSON.stringify(toDiagnostic(error));
        assert.ok(!diagnostic.includes('CLEANUP_UNKNOWN_COMMIT_SECRET'));
        assert.ok(!diagnostic.includes('CLEANUP_UNKNOWN_CLOSE_SECRET'));
        return true;
      },
    );
    assert.equal(closeCalls, 1, 'candidate close was attempted once');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    try {
      if (writer?.isOpen) writer.close();
    } catch {
      // Test-owned cleanup is best effort after the assertion.
    }
  }
});

test('(W3 correction) filesystem races remain redacted before compatibility inspection', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-stat-race-');
  const database = dbPath(dir);
  const seed = openStore(dir);
  seed.close();
  const originalLstat = fs.lstatSync;
  let databaseCalls = 0;
  t.mock.method(fs, 'lstatSync', (path: Parameters<typeof fs.lstatSync>[0]) => {
    if (String(path) === database) {
      databaseCalls += 1;
      if (databaseCalls >= 2) throw new Error('STAT_PRIVATE_SECRET');
    }
    return originalLstat(path);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => openStore(dir),
      (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.code, 'PATH_UNSAFE');
        assert.ok(
          !JSON.stringify(toDiagnostic(error)).includes('STAT_PRIVATE_SECRET'),
        );
        return true;
      },
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('(W3 correction) read-only operational inspection failures preserve unavailable diagnostics', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-ro-error-');
  const seed = openStore(dir);
  seed.close();
  const originalPrepare = DatabaseSync.prototype.prepare;
  t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string, ...args: unknown[]) {
      if (sql.includes('FROM sqlite_schema'))
        throw Object.assign(new Error('RO_INSPECTION_PRIVATE_SECRET'), {
          code: 'ERR_SQLITE_IOERR',
          errcode: 10,
          errstr: 'disk I/O error',
        });
      return Reflect.apply(originalPrepare, this, [sql, ...args] as never);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => openStore(dir),
      (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.code, 'STORE_UNAVAILABLE');
        assert.ok(
          !JSON.stringify(toDiagnostic(error)).includes(
            'RO_INSPECTION_PRIVATE_SECRET',
          ),
        );
        return true;
      },
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('(W3 correction) canonical schema rejects BLOB metadata without reserving a job', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-w3-schema-blob-version-');
  const store = openStore(dir);
  try {
    store.reserve(reservationInput({ requestKey: 'pre-existing' }));
  } finally {
    store.close();
  }
  let snapshot: {
    schema: unknown[];
    metadata: unknown[];
    jobs: unknown[];
  };
  const before = new DatabaseSync(dbPath(dir));
  try {
    before
      .prepare("UPDATE meta SET value = X'01' WHERE key = 'schema_version'")
      .run();
    snapshot = {
      schema: before
        .prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql',
        )
        .all(),
      metadata: before
        .prepare('SELECT key, value FROM meta ORDER BY key')
        .all(),
      jobs: before
        .prepare(
          'SELECT owner_uuid, request_key, command, cwd, state FROM jobs ORDER BY request_key',
        )
        .all(),
    };
  } finally {
    before.close();
  }
  try {
    expectStoreError(() => openStore(dir), 'STORE_CORRUPT');
    const after = new DatabaseSync(dbPath(dir));
    try {
      assert.deepEqual(
        {
          schema: after
            .prepare(
              'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql',
            )
            .all(),
          metadata: after
            .prepare('SELECT key, value FROM meta ORDER BY key')
            .all(),
          jobs: after
            .prepare(
              'SELECT owner_uuid, request_key, command, cwd, state FROM jobs ORDER BY request_key',
            )
            .all(),
        },
        snapshot,
      );
      assert.equal(
        (
          after.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
            count: number;
          }
        ).count,
        1,
      );
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(W3 correction) malformed meta layouts refuse as corruption without application writes', {
  skip: runtimeSkip,
}, () => {
  for (const missingColumn of ['value', 'key'] as const) {
    const dir = tempDir('u1-w3-schema-meta-shape-');
    const seeded = openStore(dir);
    try {
      seeded.reserve(reservationInput({ requestKey: 'pre-existing' }));
    } finally {
      seeded.close();
    }
    let snapshot: unknown[];
    const raw = new DatabaseSync(dbPath(dir));
    try {
      if (missingColumn === 'value') {
        raw.exec('DROP TABLE meta; CREATE TABLE meta (key TEXT PRIMARY KEY)');
      } else {
        raw.exec('DROP TABLE meta; CREATE TABLE meta (value TEXT NOT NULL)');
      }
      snapshot = raw
        .prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql',
        )
        .all();
    } finally {
      raw.close();
    }
    try {
      expectStoreError(() => openStore(dir), 'STORE_CORRUPT');
      const verify = new DatabaseSync(dbPath(dir));
      try {
        assert.deepEqual(
          verify
            .prepare(
              'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql',
            )
            .all(),
          snapshot,
        );
        assert.equal(
          (
            verify.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
              count: number;
            }
          ).count,
          1,
        );
      } finally {
        verify.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('(W3 correction) complete schema identity matrix refuses one deliberate mutation at a time', {
  skip: runtimeSkip,
}, () => {
  type Variant = { name: string; mutate: (db: DatabaseSync) => void };
  const variants: Variant[] = [
    {
      name: 'missing ordinary column',
      mutate: (db) => db.exec('ALTER TABLE jobs DROP COLUMN cwd'),
    },
    {
      name: 'changed primary key declaration',
      mutate: (db) => {
        db.exec('PRAGMA writable_schema = ON');
        db.prepare(
          "UPDATE sqlite_master SET sql = replace(sql, 'creation_ordinal INTEGER PRIMARY KEY AUTOINCREMENT', 'creation_ordinal INTEGER UNIQUE') WHERE name = 'jobs'",
        ).run();
        db.exec('PRAGMA writable_schema = OFF');
      },
    },
    {
      name: 'changed unique constraint',
      mutate: (db) => {
        db.exec('PRAGMA writable_schema = ON');
        db.prepare(
          "UPDATE sqlite_master SET sql = replace(sql, 'UNIQUE (owner_uuid, request_namespace, request_key)', 'UNIQUE (owner_uuid, request_namespace)') WHERE name = 'jobs'",
        ).run();
        db.exec('PRAGMA writable_schema = OFF');
      },
    },
    {
      name: 'changed check constraint',
      mutate: (db) => {
        db.exec('PRAGMA writable_schema = ON');
        db.prepare(
          "UPDATE sqlite_master SET sql = replace(sql, 'CHECK (state IN (''reserved'', ''claimed'', ''settled''))', 'CHECK (state IN (''reserved'', ''claimed''))') WHERE name = 'jobs'",
        ).run();
        db.exec('PRAGMA writable_schema = OFF');
      },
    },
    {
      name: 'changed foreign key',
      mutate: (db) => {
        db.exec('PRAGMA writable_schema = ON');
        db.prepare(
          "UPDATE sqlite_master SET sql = replace(sql, 'REFERENCES jobs(job_id)', 'REFERENCES other_jobs(job_id)') WHERE name = 'job_claims'",
        ).run();
        db.exec('PRAGMA writable_schema = OFF');
      },
    },
    {
      name: 'missing named index',
      mutate: (db) => {
        db.exec('PRAGMA writable_schema = ON');
        db.prepare(
          "DELETE FROM sqlite_master WHERE type = 'index' AND name = 'jobs_owner_idx'",
        ).run();
        db.exec('PRAGMA writable_schema = OFF');
      },
    },
    {
      name: 'unexpected trigger',
      mutate: (db) =>
        db.exec(
          'CREATE TRIGGER unexpected_trigger AFTER INSERT ON jobs BEGIN SELECT 1; END',
        ),
    },
    {
      name: 'unexpected table',
      mutate: (db) => db.exec('CREATE TABLE unexpected_table (value TEXT)'),
    },
    {
      name: 'unexpected index',
      mutate: (db) => db.exec('CREATE INDEX unexpected_index ON jobs(job_id)'),
    },
    {
      name: 'missing version row',
      mutate: (db) =>
        db.prepare("DELETE FROM meta WHERE key = 'schema_version'").run(),
    },
    {
      name: 'malformed version row',
      mutate: (db) =>
        db
          .prepare(
            "UPDATE meta SET value = 'not-a-version' WHERE key = 'schema_version'",
          )
          .run(),
    },
    {
      name: 'partial schema',
      mutate: (db) => db.exec('DROP TABLE stale_witnesses'),
    },
  ];
  for (const variant of variants) {
    const dir = tempDir('u1-w3-schema-matrix-');
    const seeded = openStore(dir);
    seeded.reserve(reservationInput());
    seeded.close();
    let snapshot: {
      schema: unknown[];
      metadata: unknown[];
      job: unknown[];
    };
    const raw = new DatabaseSync(dbPath(dir));
    try {
      raw.enableDefensive(false);
      variant.mutate(raw);
      snapshot = {
        schema: raw
          .prepare(
            'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql',
          )
          .all(),
        metadata: raw.prepare('SELECT key, value FROM meta ORDER BY key').all(),
        job: raw
          .prepare(
            'SELECT owner_uuid, request_key, command FROM jobs ORDER BY request_key',
          )
          .all(),
      };
    } finally {
      raw.close();
    }
    try {
      assert.equal(
        errorCode(() => openStore(dir)),
        'STORE_CORRUPT',
        variant.name,
      );
      const verify = new DatabaseSync(dbPath(dir));
      try {
        assert.deepEqual(
          {
            schema: verify
              .prepare(
                'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql',
              )
              .all(),
            metadata: verify
              .prepare('SELECT key, value FROM meta ORDER BY key')
              .all(),
            job: verify
              .prepare(
                'SELECT owner_uuid, request_key, command FROM jobs ORDER BY request_key',
              )
              .all(),
          },
          snapshot,
          variant.name,
        );
      } finally {
        verify.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('(W3 correction) conversion failures fail closed and a later independent opener can recover', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-conversion-failure-');
  const database = dbPath(dir);
  const seed = openStore(dir);
  seed.close();
  const reset = new DatabaseSync(database);
  reset.prepare('PRAGMA journal_mode = DELETE').get();
  reset.close();
  const originalPrepare = DatabaseSync.prototype.prepare;
  t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string, ...args: unknown[]) {
      if (sql === 'PRAGMA journal_mode = WAL')
        throw Object.assign(new Error('CONVERSION_PRIVATE_SECRET'), {
          code: 'ERR_SQLITE_IOERR',
          errcode: 10,
          errstr: 'disk I/O error',
        });
      return Reflect.apply(originalPrepare, this, [sql, ...args] as never);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.equal(
      errorCode(() => openStore(dir)),
      'STORE_UNAVAILABLE',
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  const afterFailure = new DatabaseSync(database);
  assert.equal(
    afterFailure.prepare('PRAGMA journal_mode').get()?.journal_mode,
    'delete',
  );
  afterFailure.close();
  const recovered = openStore(dir);
  recovered.close();
});

test('(W3 correction) conversion lock is released only after WAL and locked revalidation rejects a later upgrade', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-conversion-order-');
  const database = dbPath(dir);
  const seed = openStore(dir);
  seed.close();
  const reset = new DatabaseSync(database);
  reset.prepare('PRAGMA journal_mode = DELETE').get();
  reset.close();
  const originalExec = DatabaseSync.prototype.exec;
  const events: string[] = [];
  let beginCount = 0;
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string): void {
      events.push(sql);
      if (sql === 'BEGIN IMMEDIATE') {
        beginCount += 1;
        if (beginCount === 2) {
          const writer = new DatabaseSync(database, { timeout: 1000 });
          writer
            .prepare(
              "UPDATE meta SET value = '999' WHERE key = 'schema_version'",
            )
            .run();
          writer.close();
        }
      }
      originalExec.call(this, sql);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.equal(
      errorCode(() => openStore(dir)),
      'SCHEMA_TOO_NEW',
    );
    assert.equal(
      beginCount,
      2,
      'validation and bootstrap reservations are distinct',
    );
    assert.ok(events.includes('ROLLBACK'));
    assert.ok(events.includes('PRAGMA locking_mode = NORMAL'));
    const verify = new DatabaseSync(database);
    assert.equal(
      verify.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'wal',
    );
    assert.equal(
      (
        verify
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string }
      ).value,
      '999',
    );
    verify.close();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
