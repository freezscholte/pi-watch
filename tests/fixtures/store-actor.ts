/**
 * Bounded store actor fixture (test-only).
 *
 * A separate process that performs store operations so lifecycle tests can
 * exercise real multi-process contention, lock holding, and kill-before/
 * after-commit behavior WITHOUT blocking the test's event loop.
 *
 * Usage:
 *   node tests/fixtures/store-actor.ts <mode> --db <path> --root <path> [options]
 *
 * Modes:
 *   reserve          reserve (owner/key/command via options), print result JSON
 *   open-close       open and close the store (bootstrap), print result JSON
 *   bootstrap-hold   hold inside the bootstrap transaction until the hold
 *                    deadline or an external kill; bounded by wall clock
 *   hold-open        hold inside a reserve transaction until the hold
 *                    deadline or an external kill; bounded by wall clock
 *   commit-then-hold commit a reservation, print the result, then stay alive
 *                    until the hold deadline or an external kill
 *   publish          claim + heartbeat + finalized result publication
 *   prepare-claim    create, claim, advance N heartbeats; no publication
 *   witness-only     publish using the supplied fixed --observed-* snapshot;
 *                    never refresh the snapshot, claim, or heartbeat
 *
 * Every mode prints exactly one JSON line to stdout before exiting (unless
 * it is killed first). The hold modes expire independently using a clock
 * deadline computed BEFORE any blocking loop, never same-loop timers, so
 * an actor can never hang its parent or itself.
 */
import { randomUUID } from 'node:crypto';
import {
  checkRuntimeSupport,
  createJobStore,
  type JobObservation,
} from '../../src/job-store.ts';

interface ActorOptions {
  db: string;
  root: string;
  owner: string;
  session: string;
  namespace: string;
  key: string;
  command: string;
  cwd: string;
  deadlineMs: number;
  holdMs: number;
  claimId: string;
  counter: number;
  shellCode: number;
  jobId: string;
  observedClaim: string;
  observedCounter: number;
  observedRevision: number;
}

const DEFAULTS: ActorOptions = {
  db: '',
  root: '',
  owner: '11111111-2222-4333-8444-555555555555',
  session: '/sessions/owner-session.jsonl',
  namespace: 'tool_call',
  key: 'call-1',
  command: 'echo actor',
  cwd: '/tmp/base',
  deadlineMs: 1_800_000,
  holdMs: 5_000,
  claimId: 'claim-1',
  counter: 0,
  shellCode: 0,
  jobId: '',
  observedClaim: 'claim-1',
  observedCounter: 0,
  observedRevision: 0,
};

function parseArgs(argv: string[]): { mode: string; options: ActorOptions } {
  const [mode = '', ...rest] = argv;
  const options: ActorOptions = { ...DEFAULTS };
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if (name === undefined || value === undefined) break;
    switch (name.replace(/^--/, '')) {
      case 'db':
        options.db = value;
        break;
      case 'root':
        options.root = value;
        break;
      case 'owner':
        options.owner = value;
        break;
      case 'session':
        options.session = value;
        break;
      case 'namespace':
        options.namespace = value;
        break;
      case 'key':
        options.key = value;
        break;
      case 'command':
        options.command = value;
        break;
      case 'cwd':
        options.cwd = value;
        break;
      case 'deadline':
        options.deadlineMs = Number(value);
        break;
      case 'hold':
        options.holdMs = Number(value);
        break;
      case 'claim':
        options.claimId = value;
        break;
      case 'counter':
        options.counter = Number(value);
        break;
      case 'shell-code':
        options.shellCode = Number(value);
        break;
      case 'observed-claim':
        options.observedClaim = value;
        break;
      case 'observed-counter':
        options.observedCounter = Number(value);
        break;
      case 'observed-revision':
        options.observedRevision = Number(value);
        break;
      case 'job':
        options.jobId = value;
        break;
      default:
        break;
    }
  }
  return { mode, options };
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Blocks the calling thread until `deadlineMs` (wall clock, computed before
 * entering) expires. Atomics.wait on a private buffer with short timeouts
 * keeps this bounded without depending on timers of the blocked loop.
 */
function blockUntil(deadlineMs: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadlineMs) {
    Atomics.wait(shared, 0, 0, 25);
  }
}

function run(): void {
  const { mode, options } = parseArgs(process.argv.slice(2));
  if (options.db === '' || options.root === '') {
    emit({ status: 'error', code: 'ACTOR_USAGE', mode });
    return;
  }
  checkRuntimeSupport();
  const holdDeadline = Date.now() + options.holdMs;

  // Marker for parents that kill mid-transaction: emitted before the store
  // opens, so a kill after this line lands inside or before the transaction.
  if (
    mode === 'hold-open' ||
    mode === 'bootstrap-hold' ||
    mode === 'commit-then-hold'
  ) {
    emit({ marker: 'entering', mode });
  }

  const hooks =
    mode === 'hold-open'
      ? {
          beforeCommit: (op: string) => {
            if (op === 'reserve') blockUntil(holdDeadline);
          },
        }
      : mode === 'bootstrap-hold'
        ? {
            beforeCommit: (op: string) => {
              if (op === 'bootstrap') blockUntil(holdDeadline);
            },
          }
        : undefined;

  if (mode === 'open-close') {
    const store = createJobStore(options.db, { trustedRoot: options.root });
    store.close();
    emit({ status: 'ok' });
    return;
  }

  const store = createJobStore(
    options.db,
    hooks === undefined
      ? { trustedRoot: options.root }
      : { trustedRoot: options.root, hooks },
  );

  function waitBriefly(): void {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, 120);
  }

  /** Bounded retry of the idempotent reservation under writer contention. */
  function reserveWithRetry(): {
    created: boolean;
    jobId: string;
    runnerToken: string | null;
  } {
    const candidateJobId = randomUUID();
    for (let attempt = 1; ; attempt++) {
      try {
        const result = store.reserve({
          ownerUuid: options.owner,
          sessionPath: options.session,
          namespace:
            options.namespace === 'explicit' ? 'explicit' : 'tool_call',
          requestKey: options.key,
          command: options.command,
          cwd: options.cwd,
          deadlineMs: options.deadlineMs,
          // Preallocated candidate identity (finding #6): generated before
          // persistence in the actor process.
          candidateJobId,
        });
        return {
          created: result.created,
          jobId: result.job.jobId,
          runnerToken: result.runnerToken,
        };
      } catch (error) {
        if (
          attempt < 4 &&
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code: unknown }).code === 'STORE_BUSY'
        ) {
          waitBriefly();
          continue;
        }
        throw error;
      }
    }
  }

  if (mode === 'reserve' || mode === 'hold-open') {
    const result = reserveWithRetry();
    emit({ status: 'ok', created: result.created, jobId: result.jobId });
    store.close();
    return;
  }

  if (mode === 'commit-then-hold') {
    const result = reserveWithRetry();
    emit({ status: 'ok', created: result.created, jobId: result.jobId });
    blockUntil(holdDeadline); // stay alive for the parent to kill; bounded
    store.close();
    return;
  }

  if (mode === 'publish') {
    const reserved = reserveWithRetry();
    let claimed = false;
    let heartbeated = false;
    for (let attempt = 1; ; attempt++) {
      try {
        if (!claimed) {
          store.claimRunner(
            options.owner,
            reserved.jobId,
            options.claimId,
            reserved.runnerToken,
          );
          claimed = true; // Only a successful response grants this authority.
        }
        if (!heartbeated) {
          store.heartbeat(
            options.owner,
            reserved.jobId,
            options.claimId,
            0,
            reserved.runnerToken,
          );
          heartbeated = true;
        }
        try {
          const published = store.publishResult(
            options.owner,
            reserved.jobId,
            options.claimId,
            null,
            {
              launch: 'launched',
              shellCode: options.shellCode,
              stdout: { available: true, incomplete: false },
              stderr: { available: true, incomplete: false },
              finalized: true,
            },
            reserved.runnerToken,
          );
          emit({
            status: 'ok',
            created: reserved.created,
            jobId: reserved.jobId,
            revision: published.revision,
          });
          break;
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code: unknown }).code === 'REVISION_STALE' &&
            store
              .listResults(options.owner, reserved.jobId)
              .some((r) => r.evidence.finalized)
          ) {
            // A prior attempt of this actor already finalized the result.
            emit({ status: 'ok', jobId: reserved.jobId, revision: -1 });
            break;
          }
          throw error;
        }
      } catch (error) {
        if (
          attempt < 4 &&
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code: unknown }).code === 'STORE_BUSY'
        ) {
          waitBriefly();
          continue;
        }
        throw error;
      }
    }
    store.close();
    return;
  }

  if (mode === 'prepare-claim') {
    // Building state only: reserve/reuse, claim once, advance heartbeats.
    // No publication; lets the parent race witness actors against a real
    // claimed observation.
    const reserved = reserveWithRetry();
    const claim = store.claimRunner(
      options.owner,
      reserved.jobId,
      options.claimId,
      reserved.runnerToken,
    );
    let counter = claim.heartbeatCounter;
    for (let c = counter; c < options.counter; c++) {
      counter = store.heartbeat(
        options.owner,
        reserved.jobId,
        options.claimId,
        c,
        reserved.runnerToken,
      ).counter;
    }
    const observation: JobObservation = store.observeJob(
      options.owner,
      reserved.jobId,
    );
    emit({
      status: 'ok',
      jobId: reserved.jobId,
      claimId: observation.claimId,
      counter: observation.heartbeatCounter,
      revision: observation.latestRevision,
    });
    store.close();
    return;
  }

  if (mode === 'witness-only') {
    // Both competitors use the parent's fixed observation, even if one
    // starts after another writer commits. Never refresh away a stale input.
    try {
      const published = store.publishUncertainResult(
        options.owner,
        options.jobId,
        {
          observedClaimId:
            options.observedClaim === '' ? null : options.observedClaim,
          observedCounter: options.observedCounter,
          observedRevision: options.observedRevision,
        },
      );
      emit({
        status: 'ok',
        jobId: options.jobId,
        revision: published.revision,
      });
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'UNKNOWN';
      emit({ status: 'error', code, jobId: options.jobId });
    }
    store.close();
    return;
  }

  emit({ status: 'error', code: 'ACTOR_USAGE', mode });
}

try {
  run();
} catch (error) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'UNKNOWN';
  emit({ status: 'error', code });
  process.exitCode = 0;
}
