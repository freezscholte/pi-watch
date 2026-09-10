import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MessageChannel, Worker } from 'node:worker_threads';
import {
  checkRuntimeSupport,
  createJobStore,
  type JobObservation,
  type ReservationInput,
} from '../src/job-store.ts';
import { StoreError, StoreWriteError, toDiagnostic } from '../src/job-types.ts';
import { openStoreClient } from '../src/store-client.ts';
import {
  runStoreWorker,
  type StoreErrorResponseMessage,
} from '../src/store-worker.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function dbPath(dir: string): string {
  return join(realpathSync(dir), 'watch', 'v1', 'jobs.sqlite');
}

function treeEntries(root: string): string[] {
  const entries: string[] = [];
  const visit = (current: string, relative: string): void => {
    for (const name of readdirSync(current)) {
      const childRelative = relative === '' ? name : join(relative, name);
      entries.push(childRelative);
      if (lstatSync(join(current, name)).isDirectory()) {
        visit(join(current, name), childRelative);
      }
    }
  };
  visit(root, '');
  return entries.sort();
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const OTHER_OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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

interface ActorOutcome {
  status: string;
  code?: string;
  created?: boolean;
  jobId?: string;
  revision?: number;
  disposition?: string;
}

interface ActorHandle {
  child: ChildProcess;
  result: Promise<ActorOutcome>;
  /** Test-only direct expiry control for deterministic lifecycle ordering. */
  expire: () => void;
  /** Resolves once the actor has emitted its entering marker. */
  entering: Promise<void>;
  /** Everything the actor printed so far (diagnostics for failures). */
  output: () => string;
}

/**
 * Spawns ONE bounded store actor (a real separate process). The returned
 * promise always settles: on actor exit, on the configured kill, or on a
 * hard expiry that rejects rather than hangs the test.
 */
function spawnActor(
  args: string[],
  root: string,
  options: {
    killAfterEntering?: boolean;
    killAfterFirstJson?: boolean;
    expiryMs?: number;
  } = {},
): ActorHandle {
  const expiryMs = options.expiryMs ?? 20_000;
  const child = spawn(
    process.execPath,
    ['tests/fixtures/store-actor.ts', ...args, '--root', root],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdoutText = '';
  let killArmed =
    options.killAfterEntering === true || options.killAfterFirstJson === true;
  let enteringReady = false;
  let enteringResolve: () => void = () => {};
  let enteringReject: (error: Error) => void = () => {};
  let expireActor: () => void = () => {};
  const entering = new Promise<void>((resolve, reject) => {
    enteringResolve = resolve;
    enteringReject = reject;
  });
  // A caller may only await result; keep an early readiness rejection handled
  // without changing the rejection observed by callers that await entering.
  void entering.catch(() => {});
  const result = new Promise<ActorOutcome>((resolve, reject) => {
    let settled = false;
    const failReadiness = (reason: string): void => {
      if (!enteringReady) {
        enteringReject(new Error(`store actor was not ready: ${reason}`));
      }
    };
    const expire = (): void => {
      if (settled) return;
      settled = true;
      failReadiness(`expired after ${expiryMs}ms: ${stdoutText}`);
      // Expiry owns cleanup through this original direct child handle; never
      // signal a PID recovered from output or durable store state.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      reject(
        new Error(`store actor expired after ${expiryMs}ms: ${stdoutText}`),
      );
    };
    expireActor = expire;
    const expiry = setTimeout(expire, expiryMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutText += chunk.toString('utf8');
      if (stdoutText.includes('"marker":"entering"') && !enteringReady) {
        enteringReady = true;
        enteringResolve();
      }
      if (killArmed) {
        // Only a "status" JSON line counts as committed output; the
        // entering marker is NOT a commit.
        const shouldKill =
          (options.killAfterEntering === true &&
            stdoutText.includes('"marker":"entering"')) ||
          (options.killAfterFirstJson === true &&
            stdoutText.includes('"status"'));
        if (shouldKill) {
          killArmed = false;
          // Signal ONLY this original live direct child handle.
          child.kill('SIGKILL');
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stdoutText += chunk.toString('utf8');
    });
    child.once('exit', (code, signal) => {
      clearTimeout(expiry);
      if (settled) return;
      settled = true;
      if (!enteringReady) {
        failReadiness(`exited before entering (status output: ${stdoutText})`);
      }
      const lines = stdoutText
        .trim()
        .split('\n')
        .filter((line) => line.startsWith('{'));
      const parsed =
        lines.length > 0
          ? (JSON.parse(lines[lines.length - 1] ?? '{}') as Record<
              string,
              unknown
            >)
          : {};
      resolve({
        ...(parsed as unknown as ActorOutcome),
        status:
          (parsed.status as string | undefined) ??
          (signal === 'SIGKILL' ? 'killed' : `exit-${code}`),
      });
    });
    child.once('error', (error) => {
      clearTimeout(expiry);
      if (settled) return;
      settled = true;
      failReadiness(`error: ${error.message}`);
      reject(error);
    });
  });
  return {
    child,
    result,
    entering,
    expire: () => expireActor(),
    output: () => stdoutText,
  };
}

async function awaitActor(handle: ActorHandle): Promise<ActorOutcome> {
  const outcome = await handle.result;
  handle.child.removeAllListeners();
  return outcome;
}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`bounded test wait exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Blocks until another process actually holds the store's write lock,
 * detected with real bounded SQLite probes (10ms busy timeout). Returns
 * once contention is observable; gives up after `timeoutMs`.
 */
async function waitForHeldWriteLock(
  db: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let probe: DatabaseSync;
    try {
      probe = new DatabaseSync(db);
    } catch {
      // The store file may not exist yet (fresh bootstrap); wait for the
      // actor to create it rather than treating open failure as a lock.
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    try {
      probe.exec('PRAGMA busy_timeout = 10');
      probe.exec('BEGIN IMMEDIATE');
      probe.exec('ROLLBACK');
      probe.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      probe.close();
      return; // "database is locked": the actor holds the write lock
    }
  }
  assert.fail(`write lock was not observed as held within ${timeoutMs}ms`);
}

test('the async client reserves and reads owner-scoped records through the worker', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-worker-scoped-');
  const client = await openStoreClient(dbPath(dir), { trustedRoot: dir });
  try {
    const input = reservationInput();
    const created = await client.reserve(input);
    assert.equal(created.created, true);
    const reused = await client.reserve(input);
    assert.equal(reused.created, false);
    assert.equal(reused.job.jobId, created.job.jobId);
    assert.equal(reused.runnerToken, null);
    await assert.rejects(
      client.claimRunner(
        OWNER,
        reused.job.jobId,
        'adopter',
        reused.runnerToken,
      ),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'CLAIM_TAKEN',
    );

    await assert.rejects(
      client.getJob(OTHER_OWNER, created.job.jobId),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'NOT_FOUND',
    );
    const job = await client.getJob(input.ownerUuid, created.job.jobId);
    assert.equal(job.command, 'echo hello');
    const claim = await client.claimRunner(
      input.ownerUuid,
      created.job.jobId,
      'claim-1',
      created.runnerToken,
    );
    assert.equal(claim.claimId, 'claim-1');
    const published = await client.publishResult(
      input.ownerUuid,
      created.job.jobId,
      'claim-1',
      null,
      {
        launch: 'launched',
        shellCode: 0,
        stdout: { available: true, incomplete: false },
        stderr: { available: true, incomplete: false },
        finalized: true,
      },
      created.runnerToken,
    );
    assert.equal(published.evidence.finalized, true);
  } finally {
    await client.close();
  }
});

test('the async worker preserves durable cancellation and one-time suppression control', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u2-worker-control-');
  const client = await openStoreClient(dbPath(dir), { trustedRoot: dir });
  try {
    const created = await client.reserve(
      reservationInput({ requestKey: 'worker-control' }),
    );
    const recorded = await client.requestCancellation(OWNER, created.job.jobId);
    assert.equal(recorded.disposition, 'recorded');
    const claim = await client.claimRunner(
      OWNER,
      created.job.jobId,
      'worker-control-claim',
      created.runnerToken,
    );
    const decision = await client.decideLaunch(
      OWNER,
      created.job.jobId,
      claim.claimId,
      created.runnerToken,
    );
    assert.equal(decision.disposition, 'suppressed_now');
    assert.equal(decision.control.launchDecision, 'suppressed_cancelled');
    const observation = await client.observeJob(OWNER, created.job.jobId);
    assert.equal(observation.control.launchDecision, 'suppressed_cancelled');
    assert.equal(observation.finalized, true);
  } finally {
    await client.close();
  }
});

test('two real store actors race one launch decision to one authorization', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u2-control-race-');
  const db = dbPath(dir);
  const seed = createJobStore(db, { trustedRoot: dir });
  const created = seed.reserve(
    reservationInput({ requestKey: 'control-race' }),
  );
  seed.claimRunner(OWNER, created.job.jobId, 'race-claim', created.runnerToken);
  seed.close();
  const first = spawnActor(
    [
      'decide',
      '--db',
      db,
      '--job',
      created.job.jobId,
      '--claim',
      'race-claim',
      '--runner-token',
      created.runnerToken ?? '',
    ],
    dir,
  );
  const second = spawnActor(
    [
      'decide',
      '--db',
      db,
      '--job',
      created.job.jobId,
      '--claim',
      'race-claim',
      '--runner-token',
      created.runnerToken ?? '',
    ],
    dir,
  );
  const closed = Promise.all(
    [first, second].map(
      ({ child }) =>
        new Promise<void>((resolve) => child.once('close', () => resolve())),
    ),
  );
  try {
    const outcomes = await bounded(
      Promise.all([first.result, second.result]),
      20_000,
    );
    await bounded(closed, 5_000);
    for (const actor of [first, second]) {
      assert.equal(actor.child.exitCode, 0);
      assert.equal(actor.child.signalCode, null);
    }
    assert.ok(outcomes.every((outcome) => outcome.status === 'ok'));
    assert.deepEqual(outcomes.map((outcome) => outcome.disposition).sort(), [
      'already_decided',
      'authorized_now',
    ]);
  } finally {
    first.expire();
    second.expire();
    await bounded(closed, 5_000);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('actual control-worker response loss is unknown after committed cancellation and decision', {
  skip: runtimeSkip,
}, async () => {
  for (const operation of ['request_cancellation', 'decide_launch'] as const) {
    const dir = tempDir(`u2-worker-control-loss-${operation}-`);
    const db = dbPath(dir);
    const seed = createJobStore(db, { trustedRoot: dir });
    const created = seed.reserve(
      reservationInput({ requestKey: `loss-${operation}` }),
    );
    if (operation === 'decide_launch') {
      seed.claimRunner(
        OWNER,
        created.job.jobId,
        'loss-claim',
        created.runnerToken,
      );
    }
    seed.close();
    let worker: Worker | undefined;
    try {
      const client = await bounded(
        openStoreClient(db, {
          trustedRoot: dir,
          startupWorkerUrl: new URL(
            './fixtures/control-worker.ts',
            import.meta.url,
          ),
          onStartupWorker: (original) => {
            worker = original;
          },
        }),
        10_000,
      );
      try {
        const invoke = (jobId: string): Promise<unknown> =>
          operation === 'request_cancellation'
            ? client.requestCancellation(OWNER, jobId)
            : client.decideLaunch(
                OWNER,
                jobId,
                'loss-claim',
                created.runnerToken,
              );
        // A clone failure occurs before handoff, not after an uncertain write.
        await assert.rejects(
          bounded(invoke((() => {}) as unknown as string), 10_000),
          (error: unknown) =>
            error instanceof StoreError &&
            !(error instanceof StoreWriteError) &&
            error.code === 'VALIDATION_FAILED',
        );
        await assert.rejects(
          bounded(invoke(created.job.jobId), 10_000),
          (error: unknown) =>
            error instanceof StoreWriteError &&
            error.commitOutcome === 'unknown' &&
            !('disposition' in error),
        );
        // Once the original worker has exited, no new call was handed off.
        await assert.rejects(
          bounded(invoke(created.job.jobId), 10_000),
          (error: unknown) =>
            error instanceof StoreError &&
            !(error instanceof StoreWriteError) &&
            error.code === 'STORE_UNAVAILABLE',
        );
      } finally {
        await bounded(client.close(), 5_000);
      }
      const reopened = createJobStore(db, { trustedRoot: dir });
      try {
        const observation = reopened.observeJob(OWNER, created.job.jobId);
        if (operation === 'request_cancellation') {
          assert.notEqual(observation.control.cancellationRequestedAtMs, null);
        } else {
          assert.equal(observation.control.launchDecision, 'authorized');
          assert.equal(
            reopened.decideLaunch(
              OWNER,
              created.job.jobId,
              'loss-claim',
              created.runnerToken,
            ).disposition,
            'already_decided',
          );
        }
      } finally {
        reopened.close();
      }
    } finally {
      if (worker !== undefined && worker.threadId !== -1) {
        await bounded(worker.terminate(), 5_000);
      }
      // No removal if original-worker termination was not confirmed above.
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('worker error protocol preserves resolved replay identity and committed outcome', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-worker-error-receipt-');
  const db = dbPath(dir);
  const seed = createJobStore(db, { trustedRoot: dir });
  const created = seed.reserve(reservationInput());
  seed.close();
  const { port1, port2 } = new MessageChannel();
  const ready = once(port2, 'message');
  const stop = runStoreWorker(port1, db, {
    trustedRoot: dir,
    hooks: {
      afterCommit(op: string) {
        if (op === 'reserve') throw new Error('PRIVATE_RESPONSE_FAILURE');
      },
    },
  });
  try {
    await ready;
    const reply = once(port2, 'message');
    port2.postMessage({
      id: 1,
      op: 'reserve',
      payload: reservationInput({
        candidateJobId: 'c0000000-0000-4000-8000-000000000006',
      }),
    });
    const [raw] = await reply;
    const response = raw as StoreErrorResponseMessage;
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'ACCEPTANCE_UNCONFIRMED');
    assert.equal(response.candidateJobId, created.job.jobId);
    assert.equal(response.commitOutcome, 'committed');
    assert.ok(!JSON.stringify(response).includes('PRIVATE_RESPONSE_FAILURE'));
    assert.ok(
      !JSON.stringify(response).includes(created.runnerToken ?? 'NO_TOKEN'),
    );
  } finally {
    if (typeof stop === 'function') stop();
    port1.close();
    port2.close();
  }
  const reopened = createJobStore(db, { trustedRoot: dir });
  try {
    assert.equal(reopened.getJob(OWNER, created.job.jobId).state, 'reserved');
  } finally {
    reopened.close();
  }
});

test('worker response loss retains a pre-handoff candidate and never claims a commit or launch', {
  skip: runtimeSkip,
}, async (t) => {
  const dir = tempDir('u1-worker-ack-loss-');
  const db = dbPath(dir);
  const originalPost = Worker.prototype.postMessage;
  const originalEmit = Worker.prototype.emit;
  let candidate: unknown;
  let committedId: string | undefined;
  let termination: Promise<number> | undefined;
  t.mock.method(
    Worker.prototype,
    'postMessage',
    function (this: Worker, message: unknown, ...rest: unknown[]) {
      const request = message as {
        op?: string;
        payload?: { candidateJobId?: string };
      };
      if (request.op === 'reserve') candidate = request.payload?.candidateJobId;
      return Reflect.apply(originalPost, this, [message, ...rest]);
    },
  );
  t.mock.method(
    Worker.prototype,
    'emit',
    function (this: Worker, event: string | symbol, ...args: unknown[]) {
      const response = args[0] as
        | { ok?: boolean; result?: { job?: { jobId: string } } }
        | undefined;
      if (
        event === 'message' &&
        response?.ok === true &&
        response.result?.job
      ) {
        committedId = response.result.job.jobId;
        termination = this.terminate(); // Only this original worker handle.
        return true; // Controlled loss of the actual committed response.
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    },
  );
  const client = await openStoreClient(db, { trustedRoot: dir });
  const expiry = setTimeout(() => {
    void client.terminateWorker();
  }, 5000);
  try {
    await assert.rejects(
      client.reserve(reservationInput()),
      (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.code, 'ACCEPTANCE_UNCONFIRMED');
        assert.equal(typeof candidate, 'string');
        assert.equal(
          (error as { candidateJobId?: string }).candidateJobId,
          candidate,
        );
        assert.equal(
          (error as { commitOutcome?: string }).commitOutcome,
          'unknown',
        );
        assert.equal('runnerToken' in error, false);
        return true;
      },
    );
    assert.equal(committedId, candidate);
  } finally {
    clearTimeout(expiry);
    await client.close();
    await termination;
    t.mock.restoreAll();
  }
  const reopened = createJobStore(db, { trustedRoot: dir });
  try {
    assert.equal(reopened.getJob(OWNER, String(candidate)).state, 'reserved');
    const replay = reopened.reserve(reservationInput());
    assert.equal(replay.created, false);
    assert.equal(replay.runnerToken, null);
  } finally {
    reopened.close();
  }
});

test('two independent actor processes reserve the same key exactly once; conflicts reject cross-process', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-dup-');
  const db = dbPath(dir);
  const args = [
    'reserve',
    '--db',
    db,
    '--key',
    'call-1',
    '--command',
    'echo hello',
    '--cwd',
    '/tmp/base',
  ];
  // Concurrent duplicate starts from separate processes.
  const [first, second] = [spawnActor(args, dir), spawnActor(args, dir)];
  const [firstResult, secondResult] = await Promise.all([
    awaitActor(first),
    awaitActor(second),
  ]);
  assert.equal(firstResult.status, 'ok');
  assert.equal(secondResult.status, 'ok');
  const created = [firstResult.created, secondResult.created];
  assert.deepEqual(created.sort(), [false, true]);
  assert.equal(firstResult.jobId, secondResult.jobId);

  // The creating process has exited. A same-owner replay process cannot
  // invent a new runner claim or publish using the recovered metadata.
  const adopter = await awaitActor(
    spawnActor(['publish', ...args.slice(1)], dir),
  );
  assert.equal(adopter.status, 'error');
  assert.equal(adopter.code, 'CLAIM_TAKEN');
  const inspect = createJobStore(db, { trustedRoot: dir });
  try {
    assert.equal(
      inspect.observeJob(OWNER, String(firstResult.jobId)).claimId,
      null,
    );
    assert.equal(
      inspect.listResults(OWNER, String(firstResult.jobId)).length,
      0,
    );
  } finally {
    inspect.close();
  }

  // Conflicting parameters reject in a separate process.
  const conflict = spawnActor(
    [
      'reserve',
      '--db',
      db,
      '--key',
      'call-1',
      '--command',
      'echo changed',
      '--cwd',
      '/tmp/base',
    ],
    dir,
  );
  const conflictResult = await awaitActor(conflict);
  assert.equal(conflictResult.status, 'error');
  assert.equal(conflictResult.code, 'REQUEST_KEY_CONFLICT');

  // A different owner/key remains independent.
  const independent = spawnActor(
    [
      'reserve',
      '--db',
      db,
      '--key',
      'call-1',
      '--owner',
      OTHER_OWNER,
      '--command',
      'echo hello',
    ],
    dir,
  );
  const independentResult = await awaitActor(independent);
  assert.equal(independentResult.status, 'ok');
  assert.equal(independentResult.created, true);
  assert.notEqual(independentResult.jobId, firstResult.jobId);
});

test('twenty storage actors preserve unique reservations and conditional final writes', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-twenty-');
  const db = dbPath(dir);
  // Each original creating actor retains its private capability through
  // claim and publication; a later actor must never adopt a reservation.
  const publishes = Array.from({ length: 20 }, (_, i) =>
    spawnActor(
      [
        'publish',
        '--db',
        db,
        '--key',
        `call-${i}`,
        '--command',
        `echo actor-${i}`,
        '--claim',
        `claim-${i}`,
        '--shell-code',
        String(i % 3),
      ],
      dir,
    ),
  );
  const publishResults = await Promise.all(publishes.map(awaitActor));
  const jobIds = new Set<string>();
  for (const result of publishResults) {
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.created, true);
    assert.equal(result.revision, 1);
    assert.ok(result.jobId);
    jobIds.add(result.jobId);
  }
  assert.equal(jobIds.size, 20, 'all reservations unique');

  const store = createJobStore(db, { trustedRoot: dir });
  try {
    const jobs = store.listJobs(OWNER);
    assert.equal(jobs.length, 20);
    for (const job of jobs) assert.equal(job.state, 'settled');
    // A held writer returns bounded busy instead of fabricating failure:
    // verified separately in the busy-writer test below.
  } finally {
    store.close();
  }
});

test('killing an actor before commit preserves old state; after commit preserves new state on reopen', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-kill-');
  const db = dbPath(dir);

  // Pre-existing state: one settled job.
  const seed = spawnActor(['publish', '--db', db, '--key', 'seed'], dir);
  assert.equal((await awaitActor(seed)).status, 'ok');

  // Killed BEFORE commit: the held transaction rolls back. The actor
  // prints its entering marker; we observe the real held write lock via
  // bounded SQLite probes, then SIGKILL the actor inside its hold.
  const preCommit = spawnActor(
    ['hold-open', '--db', db, '--key', 'pre-commit', '--hold', '30000'],
    dir,
    { expiryMs: 20_000 },
  );
  await preCommit.entering;
  try {
    await waitForHeldWriteLock(db);
  } catch (error) {
    preCommit.child.kill('SIGKILL');
    await preCommit.result.catch(() => null);
    console.error(`preCommit actor output: ${preCommit.output()}`);
    throw error;
  }
  preCommit.child.kill('SIGKILL');
  await preCommit.result.catch(() => null);
  const storeAfterPre = createJobStore(db, { trustedRoot: dir });
  assert.equal(
    storeAfterPre.listJobs(OWNER).length,
    1,
    'only the seed job survived the pre-commit kill',
  );
  storeAfterPre.close();

  // Killed AFTER commit: the committed reservation survives. The actor
  // commits, prints its JSON, then holds; we observe the hold (not the
  // transaction) via the bounded lock probe waiting on the actor's exit.
  const postCommit = spawnActor(
    ['commit-then-hold', '--db', db, '--key', 'post-commit', '--hold', '30000'],
    dir,
    { killAfterFirstJson: true, expiryMs: 20_000 },
  );
  await postCommit.result.catch(() => null);
  const storeAfterPost = createJobStore(db, { trustedRoot: dir });
  const jobs = storeAfterPost.listJobs(OWNER);
  assert.equal(
    jobs.length,
    2,
    'the committed reservation survived the post-commit kill',
  );
  assert.ok(jobs.some((job) => job.requestKey === 'post-commit'));
  storeAfterPost.close();
});

test('concurrent first opens never expose partial schema on reopen', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-bootstrap-');
  const db = dbPath(dir);
  const openers = Array.from({ length: 6 }, () =>
    spawnActor(['open-close', '--db', db], dir),
  );
  const results = await Promise.all(openers.map(awaitActor));
  assert.ok(
    results.some((result) => result.status === 'ok'),
    `at least one opener must succeed: ${JSON.stringify(results)}`,
  );
  const failures = results.filter((result) => result.status !== 'ok');
  for (const failure of failures) {
    assert.ok(
      failure.code === 'STORE_BUSY' || failure.code === 'STORE_UNAVAILABLE',
      `unexpected bootstrap failure: ${JSON.stringify(failure)}`,
    );
  }
  // Reopen: one complete validated schema, usable.
  const store = createJobStore(db, { trustedRoot: dir });
  const result = store.reserve(reservationInput());
  assert.equal(result.created, true);
  store.close();
  assert.equal(statSync(join(dir, 'watch')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'watch', 'v1')).mode & 0o777, 0o700);
  assert.equal(statSync(db).mode & 0o777, 0o600);
});

test('a killed worker rejects new requests promptly without freezing the event loop', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-worker-kill-');
  const client = await openStoreClient(dbPath(dir), { trustedRoot: dir });
  try {
    // Real termination of the original idle worker handle via the seam.
    await client.terminateWorker();
    const start = Date.now();
    await assert.rejects(
      client.reserve(reservationInput({ requestKey: 'after-loss' })),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'STORE_UNAVAILABLE',
    );
    assert.ok(Date.now() - start < 5_000, 'worker loss rejected promptly');
    // Event loop is responsive after worker loss.
    const loopLag = await new Promise<number>((resolve) => {
      const t0 = Date.now();
      setTimeout(() => resolve(Date.now() - t0), 1);
    });
    assert.ok(loopLag < 2_000, `event loop lag ${loopLag}ms`);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('a pending request during worker termination settles within the bounded busy window', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-worker-pending-');
  const db = dbPath(dir);
  // Open the client first so the worker bootstraps without contention;
  // then a separate actor process holds the write lock so the worker-side
  // reservation is genuinely in flight (native busy wait) when the
  // worker is terminated. Node cannot interrupt a native call, so the
  // pending request settles with the bounded busy answer (or immediately
  // if termination lands first); either way the event loop stays free.
  const client = await openStoreClient(db, { trustedRoot: dir });
  const holder = spawnActor(
    ['hold-open', '--db', db, '--key', 'holder', '--hold', '4000'],
    dir,
  );
  try {
    await holder.entering;
    await waitForHeldWriteLock(db);
    const pendingReserve = client.reserve(
      reservationInput({ requestKey: 'in-flight' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const terminated = client.terminateWorker();
    const start = Date.now();
    await assert.rejects(
      pendingReserve,
      (error: unknown) =>
        error instanceof StoreError &&
        (error.code === 'ACCEPTANCE_UNCONFIRMED' ||
          error.code === 'STORE_BUSY'),
    );
    await terminated;
    assert.ok(
      Date.now() - start < 5_000,
      'pending request settled within the bound',
    );
    await assert.rejects(
      client.reserve(reservationInput({ requestKey: 'after-loss' })),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'STORE_UNAVAILABLE',
    );
    // Event loop is responsive after worker loss.
    const loopLag = await new Promise<number>((resolve) => {
      const t0 = Date.now();
      setTimeout(() => resolve(Date.now() - t0), 1);
    });
    assert.ok(loopLag < 2_000, `event loop lag ${loopLag}ms`);
  } finally {
    await client.close().catch(() => undefined);
    holder.child.kill('SIGKILL');
    await holder.result.catch(() => null);
  }
});

test('a held writer returns bounded STORE_BUSY instead of a fabricated job failure', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-worker-busy-');
  const db = dbPath(dir);
  // Open the client before contention, then the actor holds the
  // transaction for 1.6s, expiring independently.
  const client = await openStoreClient(db, { trustedRoot: dir });
  const holder = spawnActor(
    ['hold-open', '--db', db, '--key', 'holder', '--hold', '1600'],
    dir,
  );
  try {
    await holder.entering;
    await waitForHeldWriteLock(db);
    const start = Date.now();
    await assert.rejects(
      client.reserve(reservationInput()),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'STORE_BUSY',
    );
    const waited = Date.now() - start;
    assert.ok(waited >= 1_000 && waited < 4_000, `busy wait ${waited}ms`);
    // The busy rejection fabricated nothing; after the actor expires the
    // same request succeeds.
    await awaitActor(holder);
    const retry = await client.reserve(reservationInput());
    assert.equal(retry.created, true);
  } finally {
    await client.close();
    holder.child.kill('SIGKILL');
    await holder.result.catch(() => null);
  }
});

test('an unsafe store path rejects client initialization without touching outside targets', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-worker-unsafe-');
  const outside = tempDir('u1-worker-outside-');
  const sentinel = join(outside, 'sentinel.txt');
  writeFileSync(sentinel, 'untouched');
  mkdirSync(join(dir, 'pre'), { mode: 0o700 });
  symlinkSync(sentinel, join(dir, 'pre', 'jobs.sqlite'));
  const outsideBefore = treeEntries(outside);
  await assert.rejects(
    openStoreClient(join(dir, 'pre', 'jobs.sqlite'), { trustedRoot: dir }),
    (error: unknown) =>
      error instanceof StoreError && error.code === 'PATH_UNSAFE',
  );
  assert.equal(readFileSync(sentinel, 'utf8'), 'untouched');
  assert.deepEqual(
    treeEntries(outside),
    outsideBefore,
    'the complete external target subtree must remain untouched',
  );
});

test('diagnostics from worker failures stay allowlisted', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-worker-diag-');
  const client = await openStoreClient(dbPath(dir), { trustedRoot: dir });
  try {
    const input = reservationInput({ command: 'echo TOPSECRET-OUTPUT' });
    await client.reserve(input);
    let conflict: unknown;
    try {
      await client.reserve({ ...input, command: 'echo changed' });
      assert.fail('expected the conflicting reservation to reject');
    } catch (error) {
      conflict = error;
    }
    assert.ok(conflict instanceof StoreError);
    const diagnostic = toDiagnostic(conflict);
    assert.equal(diagnostic.code, 'REQUEST_KEY_CONFLICT');
    const serialized = JSON.stringify(diagnostic);
    assert.ok(!serialized.includes('TOPSECRET'), serialized);
    assert.ok(!serialized.includes(dir), serialized);
  } finally {
    await client.close();
  }
});

test('two competing witness-only processes race one conditional publication; the loser is exactly REVISION_STALE', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-witness-race-');
  const db = dbPath(dir);

  // Seed real claimed state with original direct handles (finding #11):
  // the fixture actors never first claim or heartbeat the job.
  const seed = createJobStore(db, { trustedRoot: dir });
  let jobId: string;
  let runnerToken: string | null;
  let observation: JobObservation;
  try {
    const reserved = seed.reserve(reservationInput());
    jobId = reserved.job.jobId;
    runnerToken = reserved.runnerToken;
    seed.claimRunner(OWNER, jobId, 'claim-1', reserved.runnerToken);
    seed.heartbeat(OWNER, jobId, 'claim-1', 0, reserved.runnerToken);
    seed.heartbeat(OWNER, jobId, 'claim-1', 1, reserved.runnerToken); // counter now 2
    observation = seed.observeJob(OWNER, jobId);
  } finally {
    seed.close();
  }

  // Two independent processes consume the same unchanged observation and
  // race the same conditional stale-witness publication.
  const witnessArgs = [
    'witness-only',
    '--db',
    db,
    '--owner',
    OWNER,
    '--job',
    jobId,
    '--observed-claim',
    observation.claimId ?? '',
    '--observed-counter',
    String(observation.heartbeatCounter),
    '--observed-revision',
    String(observation.latestRevision),
  ];
  const [first, second] = [
    spawnActor(witnessArgs, dir),
    spawnActor(witnessArgs, dir),
  ];
  const [firstResult, secondResult] = await Promise.all([
    awaitActor(first),
    awaitActor(second),
  ]);

  const outcomes = [firstResult, secondResult];
  const winners = outcomes.filter((o) => o.status === 'ok');
  const losers = outcomes.filter((o) => o.status === 'error');
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(winners[0]?.revision, 1);
  assert.equal(winners[0]?.jobId, jobId);
  assert.equal(
    losers[0]?.code,
    'REVISION_STALE',
    `the loser must lose at the conditional write, not an earlier fence: ${JSON.stringify(losers[0])}`,
  );

  // Exactly one uncertain revision and one pending notice committed.
  const verify = createJobStore(db, { trustedRoot: dir });
  try {
    const results = verify.listResults(OWNER, jobId);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.evidence.uncertain, true);
    const notices = verify.listNotices(OWNER, jobId);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.revision, results[0]?.revision);
    assert.equal(notices[0]?.pending, true);
    // A later actor must use the supplied OLD observation, not refresh it
    // after new progress and thereby create an unrelated stale revision.
    verify.heartbeat(OWNER, jobId, 'claim-1', 2, runnerToken);
    const late = await awaitActor(spawnActor(witnessArgs, dir));
    assert.equal(late.status, 'error');
    assert.equal(late.code, 'REVISION_STALE');
    assert.equal(verify.listResults(OWNER, jobId).length, 1);
    assert.equal(verify.listNotices(OWNER, jobId).length, 1);
  } finally {
    verify.close();
  }
});

test('heartbeat, claim, and final-result progress defeats stale witnesses at the store seam', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-seam-races-');
  const db = dbPath(dir);
  const a = createJobStore(db, { trustedRoot: dir });
  const b = createJobStore(db, { trustedRoot: dir });
  try {
    const { job, runnerToken } = a.reserve(reservationInput());

    // A heartbeats while B publishes with the pre-heartbeat observation.
    a.claimRunner(OWNER, job.jobId, 'claim-1', runnerToken);
    const heartbeatBeforeWitness = b.publishUncertainResult(OWNER, job.jobId, {
      observedClaimId: 'claim-1',
      observedCounter: 0,
      observedRevision: 0,
    });
    assert.equal(heartbeatBeforeWitness.revision, 1);
    // The surviving original runner advances fresh activity; a stale
    // observer of counter 0 is defeated by the heartbeat progress.
    a.heartbeat(OWNER, job.jobId, 'claim-1', 0, runnerToken);
    assert.equal(
      errorCode(() =>
        b.publishUncertainResult(OWNER, job.jobId, {
          observedClaimId: 'claim-1',
          observedCounter: 0,
          observedRevision: 1,
        }),
      ),
      'REVISION_STALE',
    );

    // A final result from the original runner defeats the witness route.
    a.publishResult(
      OWNER,
      job.jobId,
      'claim-1',
      1,
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
      errorCode(() =>
        b.publishUncertainResult(OWNER, job.jobId, {
          observedClaimId: 'claim-1',
          observedCounter: 1,
          observedRevision: 2,
        }),
      ),
      'REVISION_STALE',
    );

    // A claim arriving between an unclaimed observation and the witness
    // commit defeats the write across connections.
    const { job: job2, runnerToken: token2 } = a.reserve(
      reservationInput({ requestKey: 'call-2' }),
    );
    a.claimRunner(OWNER, job2.jobId, 'claim-early', token2);
    assert.equal(
      errorCode(() =>
        b.publishUncertainResult(OWNER, job2.jobId, {
          observedClaimId: null,
          observedCounter: 0,
          observedRevision: 0,
        }),
      ),
      'REVISION_STALE',
    );
    assert.deepEqual(a.listResults(OWNER, job2.jobId), []);
  } finally {
    a.close();
    b.close();
  }
});

test('the async client exposes an owner-scoped consistent observation snapshot', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-worker-observe-');
  const db = dbPath(dir);
  const input = reservationInput({ requestKey: 'observe-1' });
  const client = await openStoreClient(db, { trustedRoot: dir });
  let jobId = '';
  try {
    const created = await client.reserve(input);
    jobId = created.job.jobId;

    // Unclaimed observation.
    const unclaimed = await client.observeJob(input.ownerUuid, jobId);
    assert.equal(unclaimed.claimId, null);
    assert.equal(unclaimed.heartbeatCounter, 0);
    assert.equal(unclaimed.latestRevision, 0);
    assert.equal(unclaimed.finalized, false);
    assert.equal(unclaimed.job.state, 'reserved');

    // Claimed with an advancing heartbeat.
    await client.claimRunner(
      input.ownerUuid,
      jobId,
      'claim-1',
      created.runnerToken,
    );
    await client.heartbeat(
      input.ownerUuid,
      jobId,
      'claim-1',
      0,
      created.runnerToken,
    );
    await client.heartbeat(
      input.ownerUuid,
      jobId,
      'claim-1',
      1,
      created.runnerToken,
    );
    const claimed = await client.observeJob(input.ownerUuid, jobId);
    assert.equal(claimed.claimId, 'claim-1');
    assert.equal(claimed.heartbeatCounter, 2);
    assert.equal(claimed.job.state, 'claimed');

    // Final state.
    await client.publishResult(
      input.ownerUuid,
      jobId,
      'claim-1',
      0,
      {
        launch: 'launched',
        shellCode: 0,
        stdout: { available: true, incomplete: false },
        stderr: { available: true, incomplete: false },
        finalized: true,
      },
      created.runnerToken,
    );
    const settled = await client.observeJob(input.ownerUuid, jobId);
    assert.equal(settled.finalized, true);
    assert.equal(settled.evidence.shellCode, 0);
    assert.equal(settled.job.state, 'settled');
  } finally {
    await client.close();
  }

  // Reopen: a fresh owner client observes the same snapshot. The CAS input
  // comes from the returned snapshot, never from guessed values. Because
  // the record is finalized, the conditional witness write is defeated
  // exactly at the evidence check.
  const reopened = await openStoreClient(db, { trustedRoot: dir });
  try {
    const snapshot = await reopened.observeJob(input.ownerUuid, jobId);
    assert.equal(snapshot.claimId, 'claim-1');
    assert.equal(snapshot.latestRevision, 1);
    assert.equal(snapshot.finalized, true);
    await assert.rejects(
      reopened.publishUncertainResult(input.ownerUuid, jobId, {
        observedClaimId: snapshot.claimId,
        observedCounter: snapshot.heartbeatCounter,
        observedRevision: snapshot.latestRevision,
      }),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'REVISION_STALE',
    );
  } finally {
    await reopened.close();
  }

  // Foreign owners remain hidden through the facade.
  const foreign = await openStoreClient(db, { trustedRoot: dir });
  try {
    await assert.rejects(
      foreign.observeJob(OTHER_OWNER, jobId),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'NOT_FOUND',
    );
  } finally {
    await foreign.close();
  }
});

test('store-actor readiness rejects bounded early exits without leaking a rejection', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-readiness-');
  const actor = spawnActor(['unsupported-mode', '--db', dbPath(dir)], dir, {
    expiryMs: 2_000,
  });
  await assert.rejects(actor.entering, /store actor was not ready/);
  const result = await awaitActor(actor);
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'ACTOR_USAGE');
});

test('store-actor result-only early exit remains handled', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-result-only-');
  const actor = spawnActor(['unsupported-mode', '--db', dbPath(dir)], dir, {
    expiryMs: 2_000,
  });
  const result = await awaitActor(actor);
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'ACTOR_USAGE');
});

test('store-actor expiry before entering kills and reaps the original child', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-expiry-before-');
  const actor = spawnActor(
    [
      'hold-open',
      '--db',
      dbPath(dir),
      '--key',
      'expiry-before',
      '--hold',
      '30000',
    ],
    dir,
    { expiryMs: 5_000 },
  );
  const readiness = actor.entering.then(
    () => ({ ready: true as const }),
    (error: unknown) => ({ ready: false as const, error }),
  );
  const result = actor.result.then(
    (outcome) => ({ ok: true as const, outcome }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  actor.expire();
  const readinessOutcome = await readiness;
  const resultOutcome = await result;
  assert.equal(readinessOutcome.ready, false);
  if (readinessOutcome.ready)
    throw new Error('readiness unexpectedly resolved');
  assert.match(String(readinessOutcome.error), /store actor was not ready/);
  assert.equal(resultOutcome.ok, false);
  if (resultOutcome.ok) throw new Error('expiry unexpectedly resolved');
  assert.match(String(resultOutcome.error), /store actor expired/);
  if (actor.child.exitCode === null && actor.child.signalCode === null) {
    await once(actor.child, 'exit');
  }
  assert.equal(actor.child.signalCode, 'SIGKILL');
  actor.child.removeAllListeners();
});

test('store-actor expiry after entering kills and reaps the original child', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-expiry-after-');
  const actor = spawnActor(
    [
      'hold-open',
      '--db',
      dbPath(dir),
      '--key',
      'expiry-after',
      '--hold',
      '30000',
    ],
    dir,
    { expiryMs: 5_000 },
  );
  const readiness = actor.entering.then(
    () => ({ ready: true as const }),
    (error: unknown) => ({ ready: false as const, error }),
  );
  const result = actor.result.then(
    (outcome) => ({ ok: true as const, outcome }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const readinessOutcome = await readiness;
  assert.equal(readinessOutcome.ready, true);
  actor.expire();
  const resultOutcome = await result;
  assert.equal(resultOutcome.ok, false);
  if (resultOutcome.ok) throw new Error('expiry unexpectedly resolved');
  assert.match(String(resultOutcome.error), /store actor expired/);
  if (actor.child.exitCode === null && actor.child.signalCode === null) {
    await once(actor.child, 'exit');
  }
  assert.equal(actor.child.signalCode, 'SIGKILL');
  actor.child.removeAllListeners();
});

test('store-actor timed expiry remains bounded when startup ordering varies', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-expiry-timed-');
  const actor = spawnActor(
    [
      'hold-open',
      '--db',
      dbPath(dir),
      '--key',
      'expiry-timed',
      '--hold',
      '30000',
    ],
    dir,
    { expiryMs: 100 },
  );
  const readiness = actor.entering.then(
    () => ({ ready: true as const }),
    (error: unknown) => ({ ready: false as const, error }),
  );
  const result = actor.result.then(
    (outcome) => ({ ok: true as const, outcome }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const readinessOutcome = await readiness;
  const resultOutcome = await result;
  assert.equal(resultOutcome.ok, false);
  if (resultOutcome.ok) throw new Error('expiry unexpectedly resolved');
  assert.match(String(resultOutcome.error), /store actor expired/);
  if (!readinessOutcome.ready) {
    assert.match(String(readinessOutcome.error), /store actor was not ready/);
  }
  if (actor.child.exitCode === null && actor.child.signalCode === null) {
    await once(actor.child, 'exit');
  }
  assert.equal(actor.child.signalCode, 'SIGKILL');
  actor.child.removeAllListeners();
});

test('actual unsupported Node startup rejects before direct or worker-backed disk mutation', async (t) => {
  const unsupportedNode =
    process.env.PI_WATCH_UNSUPPORTED_NODE ??
    (runtimeOk ? undefined : process.execPath);
  if (unsupportedNode === undefined) {
    t.skip('set PI_WATCH_UNSUPPORTED_NODE to an explicit Node 24 executable');
    return;
  }
  assert.ok(
    existsSync(unsupportedNode),
    `runtime does not exist: ${unsupportedNode}`,
  );
  const dir = tempDir('u1-runtime-preflight-');
  const db = dbPath(dir);
  const child = spawnSync(
    unsupportedNode,
    [
      '--experimental-strip-types',
      'tests/fixtures/runtime-preflight.ts',
      '--db',
      db,
      '--root',
      dir,
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim()) as {
    direct: { ok: boolean; code?: string };
    client: { ok: boolean; code?: string };
  };
  assert.deepEqual(result, {
    direct: { ok: false, code: 'RUNTIME_UNSUPPORTED' },
    client: { ok: false, code: 'RUNTIME_UNSUPPORTED' },
  });
  assert.deepEqual(treeEntries(dir), []);
});

test('async client preserves newer-schema guidance and reaps the real init-error worker', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-client-newer-schema-');
  const db = dbPath(dir);
  const seed = createJobStore(db, { trustedRoot: dir });
  seed.close();
  const raw = new DatabaseSync(db);
  raw
    .prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'")
    .run();
  raw.close();

  let worker: Worker | undefined;
  let originalTerminate: (() => Promise<number>) | undefined;
  let workerExited = false;
  try {
    await assert.rejects(
      bounded(
        openStoreClient(db, {
          trustedRoot: dir,
          onStartupWorker: (created) => {
            worker = created;
            originalTerminate = created.terminate.bind(created);
            created.once('exit', () => {
              workerExited = true;
            });
          },
        }),
        2_000,
      ),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === 'SCHEMA_TOO_NEW' &&
        /update pi-watch/.test(error.message) &&
        !error.message.includes(db),
    );
    assert.ok(worker);
    assert.equal(workerExited, true, 'real init-error worker was not reaped');
    const probe = new DatabaseSync(db);
    try {
      assert.equal(
        (
          probe
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string }
        ).value,
        '999',
      );
    } finally {
      probe.close();
    }
  } finally {
    if (
      worker !== undefined &&
      !workerExited &&
      originalTerminate !== undefined
    ) {
      await bounded(originalTerminate(), 2_000).catch(() => undefined);
    }
  }
});

test('async client startup failure is prompt, redacted, and reaps the original worker', {
  skip: runtimeSkip,
}, async () => {
  const fixture = new URL('./fixtures/worker-startup.ts', import.meta.url);
  const failures = [
    { mode: 'timeout', timeout: 50, code: 'STORE_UNAVAILABLE' },
    {
      mode: 'init-error-then-ready',
      timeout: 1_000,
      code: 'RUNTIME_UNSUPPORTED',
    },
    { mode: 'error', timeout: 1_000, code: 'STORE_UNAVAILABLE' },
    { mode: 'early-exit', timeout: 1_000, code: 'STORE_UNAVAILABLE' },
    { mode: 'late-ready', timeout: 50, code: 'STORE_UNAVAILABLE' },
  ] as const;
  for (const failure of failures) {
    const dir = tempDir(`u1-client-startup-${failure.mode}-`);
    let worker: Worker | undefined;
    let originalTerminate: (() => Promise<number>) | undefined;
    let workerExited = false;
    try {
      const startup = openStoreClient(dbPath(dir), {
        trustedRoot: dir,
        startupWorkerUrl: fixture,
        startupWorkerMode: failure.mode,
        startupTimeoutMs: failure.timeout,
        onStartupWorker: (created) => {
          worker = created;
          originalTerminate = created.terminate.bind(created);
          created.once('exit', () => {
            workerExited = true;
          });
        },
      });
      await assert.rejects(
        bounded(startup, 2_000),
        (error: unknown) =>
          error instanceof StoreError &&
          error.code === failure.code &&
          !error.message.includes('PRIVATE_STARTUP_MARKER'),
      );
      assert.ok(worker, `${failure.mode} did not create a real worker`);
      assert.equal(workerExited, true, `${failure.mode} worker survived`);
      assert.deepEqual(treeEntries(dir), [], `${failure.mode} touched disk`);
    } finally {
      if (
        worker !== undefined &&
        !workerExited &&
        originalTerminate !== undefined
      ) {
        await bounded(originalTerminate(), 2_000).catch(() => undefined);
      }
    }
  }

  for (const terminationMode of ['pending', 'rejected'] as const) {
    const dir = tempDir(`u1-client-startup-cleanup-${terminationMode}-`);
    let worker: Worker | undefined;
    let originalTerminate: (() => Promise<number>) | undefined;
    let workerExited = false;
    try {
      const startup = openStoreClient(dbPath(dir), {
        trustedRoot: dir,
        startupWorkerUrl: fixture,
        startupWorkerMode: 'init-error',
        onStartupWorker: (created) => {
          worker = created;
          originalTerminate = created.terminate.bind(created);
          created.once('exit', () => {
            workerExited = true;
          });
          created.terminate =
            terminationMode === 'pending'
              ? () => new Promise<number>(() => {})
              : () => Promise.reject(new Error('PRIVATE_TERMINATION_FAILURE'));
        },
      });
      await assert.rejects(
        bounded(startup, 2_000),
        (error: unknown) =>
          error instanceof StoreError &&
          error.code === 'RUNTIME_UNSUPPORTED' &&
          error.message.includes('cleanup was not confirmed') &&
          !error.message.includes('PRIVATE_'),
      );
      assert.equal(
        workerExited,
        false,
        `${terminationMode} cleanup unexpectedly reaped`,
      );
    } finally {
      if (
        worker !== undefined &&
        !workerExited &&
        originalTerminate !== undefined
      ) {
        await bounded(originalTerminate(), 2_000);
      }
    }
  }

  const dir = tempDir('u1-client-startup-success-');
  let worker: Worker | undefined;
  let originalTerminate: (() => Promise<number>) | undefined;
  let workerExited = false;
  try {
    const client = await openStoreClient(dbPath(dir), {
      trustedRoot: dir,
      startupWorkerUrl: fixture,
      startupWorkerMode: 'ready',
      onStartupWorker: (created) => {
        worker = created;
        originalTerminate = created.terminate.bind(created);
        created.once('exit', () => {
          workerExited = true;
        });
      },
    });
    assert.ok(worker);
    await client.close();
    assert.equal(workerExited, true, 'successful close did not reap worker');
  } finally {
    if (
      worker !== undefined &&
      !workerExited &&
      originalTerminate !== undefined
    ) {
      await bounded(originalTerminate(), 2_000).catch(() => undefined);
    }
  }
});

test('startup observer exceptions are bounded and reap the original worker', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-client-startup-observer-');
  const fixture = new URL('./fixtures/worker-startup.ts', import.meta.url);
  let worker: Worker | undefined;
  let originalTerminate: (() => Promise<number>) | undefined;
  let workerExited = false;
  try {
    await assert.rejects(
      bounded(
        openStoreClient(dbPath(dir), {
          trustedRoot: dir,
          startupWorkerUrl: fixture,
          startupWorkerMode: 'ready',
          onStartupWorker: (created) => {
            worker = created;
            originalTerminate = created.terminate.bind(created);
            created.once('exit', () => {
              workerExited = true;
            });
            throw new Error('PRIVATE_OBSERVER_FAILURE');
          },
        }),
        2_000,
      ),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === 'STORE_UNAVAILABLE' &&
        !error.message.includes('PRIVATE_'),
    );
    assert.equal(workerExited, true, 'observer failure worker was not reaped');
  } finally {
    if (
      worker !== undefined &&
      !workerExited &&
      originalTerminate !== undefined
    ) {
      await bounded(originalTerminate(), 2_000).catch(() => undefined);
    }
  }
});

test('killing an actor during bootstrap leaves either no schema or a complete one on reopen', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-actor-bootstrap-kill-');
  const db = dbPath(dir);
  const interrupted = spawnActor(
    ['bootstrap-hold', '--db', db, '--hold', '30000'],
    dir,
    { expiryMs: 20_000 },
  );
  await interrupted.entering;
  try {
    await waitForHeldWriteLock(db);
  } catch (error) {
    interrupted.child.kill('SIGKILL');
    await interrupted.result.catch(() => null);
    console.error(`bootstrap actor output: ${interrupted.output()}`);
    throw error;
  }
  interrupted.child.kill('SIGKILL');
  await interrupted.result.catch(() => null);
  // Reopen after the mid-bootstrap kill: the transaction rolled back, so
  // the next open creates one complete validated schema.
  const store = createJobStore(db, { trustedRoot: dir });
  const result = store.reserve(reservationInput());
  assert.equal(result.created, true);
  store.close();
  // And the store remains a valid, complete schema for fresh openers.
  const probe = spawnActor(['open-close', '--db', db], dir);
  assert.equal((await awaitActor(probe)).status, 'ok');
});

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof StoreError);
    return error.code;
  }
  assert.fail('expected the operation to throw');
}
