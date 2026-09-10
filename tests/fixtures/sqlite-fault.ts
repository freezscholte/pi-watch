import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  createJobStore,
  type JobRecord,
  type JobStore,
} from '../../src/job-store.ts';
import {
  AmbiguousAcceptanceError,
  StoreError,
  StoreWriteError,
} from '../../src/job-types.ts';

export type FaultOperation =
  | 'reserve'
  | 'claim_runner'
  | 'heartbeat'
  | 'publish_result'
  | 'publish_uncertain'
  | 'statement_full';

export interface SeededStore {
  root: string;
  dbPath: string;
  store: JobStore;
  job: JobRecord | null;
  runnerToken: string | null;
  beforeJobsDigest: string;
}

export interface FaultRun {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  outcome: FaultOutcome;
}

export interface FaultOutcome {
  operation: FaultOperation;
  nativeFault: {
    stage: 'statement' | 'commit';
    errcode: number;
    code?: string;
    errstr?: string;
    inTransaction?: boolean;
  } | null;
  mapped: {
    name: string;
    code?: string;
    commitOutcome?: string;
    candidateJobId?: string;
  } | null;
  writeAfterFault: FaultOutcome['mapped'];
  replacementClaimCode: string | null;
  reopened: {
    jobsDigest: string;
    targetPresent: boolean;
    jobCount: number;
    jobId?: string;
    state?: string;
    claimId?: string | null;
    heartbeatCounter?: number;
    latestRevision?: number;
    finalized?: boolean;
    resultCount: number;
    noticeCount: number;
  } | null;
  seedWalBytes: number;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const CLAIM_ID = 'fault-claim-1';
const TARGET_JOB_ID = '11111111-2222-4333-8444-555555555551';
const CANDIDATE_JOB_ID = '11111111-2222-4333-8444-555555555552';

function walBytes(dbPath: string): number {
  const path = `${dbPath}-wal`;
  return existsSync(path) ? statSync(path).size : 0;
}

/**
 * Keep a disposable parent connection open while the limited child writes.
 * Disabling this connection's auto-checkpoint leaves bounded WAL frames in
 * place, so the child's per-process file-size limit faults its target commit
 * rather than startup. This is a fixture-only observation seam.
 */
function openWithWalAccumulation(dbPath: string, root: string): JobStore {
  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function patchedExec(
    this: DatabaseSync,
    sql: string,
  ): void {
    originalExec.call(this, sql);
    if (sql.trim().toUpperCase() === 'COMMIT') {
      try {
        originalExec.call(this, 'PRAGMA wal_autocheckpoint = 0');
      } catch {
        // The store's original operation remains authoritative.
      }
    }
  } as DatabaseSync['exec'];
  try {
    return createJobStore(dbPath, { trustedRoot: root });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
}

/** Seed only through normal store operations; no production schema is changed. */
export function createSeededStore(operation: FaultOperation): SeededStore {
  const root = mkdtempSync(join(tmpdir(), 'pi-watch-sqlite-fault-'));
  const dbPath = join(root, 'jobs.sqlite');
  const store = openWithWalAccumulation(dbPath, root);
  let job: JobRecord | null = null;
  let runnerToken: string | null = null;

  try {
    if (
      operation === 'claim_runner' ||
      operation === 'heartbeat' ||
      operation === 'publish_result' ||
      operation === 'publish_uncertain'
    ) {
      const reserved = store.reserve({
        ownerUuid: OWNER,
        sessionPath: '/sessions/fault-owner.jsonl',
        namespace: 'tool_call',
        requestKey: 'target',
        command: 'echo target',
        cwd: '/tmp',
        candidateJobId: TARGET_JOB_ID,
      });
      assert.equal(reserved.created, true);
      job = reserved.job;
      runnerToken = reserved.runnerToken;
      assert.notEqual(runnerToken, null);
      if (operation === 'heartbeat' || operation === 'publish_result') {
        store.claimRunner(OWNER, job.jobId, CLAIM_ID, runnerToken);
      }
    }

    // Normal reservations safely accumulate WAL frames. The child receives a
    // shell-specific file cap; 24 rows stays far below the 1000-page range.
    for (let index = 0; index < 24; index += 1) {
      store.reserve({
        ownerUuid: OWNER,
        sessionPath: '/sessions/fault-owner.jsonl',
        namespace: 'tool_call',
        requestKey: `seed-${index}`,
        command: 'echo seed',
        cwd: '/tmp',
      });
    }
    assert.ok(walBytes(dbPath) > 32 * 1024, 'fixture WAL must be populated');
    return {
      root,
      dbPath,
      store,
      job,
      runnerToken,
      beforeJobsDigest: jobsDigest(store.listJobs(OWNER)),
    };
  } catch (error) {
    store.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Run one target operation in a child restricted to a disposable file cap. */
export function runLimitedFault(
  seeded: SeededStore,
  operation: FaultOperation,
  fileLimitBlocks = 32,
): FaultRun {
  const node = process.execPath;
  const fixture = fileURLToPath(import.meta.url);
  const args = [
    fixture,
    seeded.root,
    operation,
    seeded.job?.jobId ?? '',
    seeded.runnerToken ?? '',
  ];
  const result = spawnSync(
    '/bin/sh',
    [
      '-c',
      'ulimit -c 0 && ulimit -f "$1" || exit 2; shift; exec "$@"',
      'pi-watch-fault',
      String(fileLimitBlocks),
      node,
      ...args,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 15_000,
      killSignal: 'SIGKILL',
      windowsHide: true,
    },
  );
  assert.equal(
    result.error,
    undefined,
    result.error?.message ?? 'fault child process failed',
  );
  assert.equal(result.stderr.length < 64 * 1024, true);
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  assert.notEqual(line, '', `fault child produced no JSON: ${result.stderr}`);
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    outcome: JSON.parse(line) as FaultOutcome,
  };
}

function jobsDigest(jobs: JobRecord[]): string {
  return createHash('sha256').update(JSON.stringify(jobs)).digest('hex');
}

function errorShape(error: unknown): FaultOutcome['mapped'] {
  if (error instanceof AmbiguousAcceptanceError) {
    return {
      name: error.name,
      code: error.code,
      commitOutcome: error.commitOutcome,
      candidateJobId: error.candidateJobId,
    };
  }
  if (error instanceof StoreWriteError) {
    return {
      name: error.name,
      code: error.code,
      commitOutcome: error.commitOutcome,
    };
  }
  if (error instanceof StoreError) {
    return { name: error.name, code: error.code };
  }
  return { name: error instanceof Error ? error.name : 'UnknownError' };
}

function installNativeObservation(operation: FaultOperation): {
  nativeFault: FaultOutcome['nativeFault'];
  restoreCap: () => void;
} {
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let active = false;
  let cappedConnection: DatabaseSync | null = null;
  let priorMaxPageCount: number | null = null;
  let nativeFault: FaultOutcome['nativeFault'] = null;

  const capture = (
    stage: 'statement' | 'commit',
    error: unknown,
    inTransaction?: boolean,
  ): void => {
    if (nativeFault !== null || !active) return;
    const raw = error as {
      errcode?: unknown;
      code?: unknown;
      errstr?: unknown;
      inTransaction?: unknown;
    };
    const errcode = Number(raw.errcode);
    if (!Number.isInteger(errcode)) return;
    nativeFault = {
      stage,
      errcode,
      ...(typeof raw.code === 'string' ? { code: raw.code } : {}),
      ...(typeof raw.errstr === 'string' ? { errstr: raw.errstr } : {}),
      ...(typeof inTransaction === 'boolean'
        ? { inTransaction }
        : typeof raw.inTransaction === 'boolean'
          ? { inTransaction: raw.inTransaction }
          : {}),
    };
  };

  DatabaseSync.prototype.exec = function observedExec(
    this: DatabaseSync,
    sql: string,
  ): void {
    const upper = sql.trim().toUpperCase();
    try {
      originalExec.call(this, sql);
      // Existing stores run bootstrap's commit before the target operation.
      // Apply FULL only to that live production-store connection, then leave
      // the cap in place until the target statement has been observed.
      if (
        operation === 'statement_full' &&
        upper === 'COMMIT' &&
        cappedConnection === null
      ) {
        const row = this.prepare('PRAGMA page_count').get() as {
          page_count?: unknown;
        };
        const pageCount = Number(row.page_count);
        const limit = Math.max(1, pageCount);
        const maxRow = this.prepare('PRAGMA max_page_count').get() as {
          max_page_count?: unknown;
        };
        priorMaxPageCount = Number(maxRow.max_page_count);
        originalExec.call(this, `PRAGMA max_page_count = ${limit}`);
        cappedConnection = this;
      }
      return;
    } catch (error) {
      if (active && upper === 'COMMIT') {
        capture('commit', error, this.isTransaction);
      }
      throw error;
    }
  } as DatabaseSync['exec'];

  DatabaseSync.prototype.prepare = function observedPrepare(
    this: DatabaseSync,
    sql: string,
  ): ReturnType<DatabaseSync['prepare']> {
    const statement = originalPrepare.call(this, sql);
    return new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'run' && property !== 'get' && property !== 'all') {
          return value;
        }
        return (...runArgs: unknown[]) => {
          try {
            return Reflect.apply(
              value as (...a: unknown[]) => unknown,
              target,
              runArgs,
            );
          } catch (error) {
            if (active) capture('statement', error);
            throw error;
          }
        };
      },
    }) as DatabaseSync['prepare'] extends (...a: never[]) => infer R
      ? R
      : never;
  } as DatabaseSync['prepare'];

  active = true;
  return {
    get nativeFault() {
      return nativeFault;
    },
    restoreCap: () => {
      if (cappedConnection !== null && priorMaxPageCount !== null) {
        try {
          originalExec.call(
            cappedConnection,
            `PRAGMA max_page_count = ${priorMaxPageCount}`,
          );
        } catch {
          // The fixture reports the native target fault; cleanup is bounded.
        }
      }
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.prepare = originalPrepare;
      active = false;
    },
  };
}

function runChild(
  root: string,
  operation: FaultOperation,
  jobId: string,
  runnerToken: string,
): FaultOutcome {
  const dbPath = join(root, 'jobs.sqlite');
  const observation = installNativeObservation(operation);
  let store: JobStore | null = null;
  let mapped: FaultOutcome['mapped'] = null;
  let writeAfterFault: FaultOutcome['mapped'] = null;
  let replacementClaimCode: string | null = null;
  let reopened: FaultOutcome['reopened'] = null;
  try {
    store = createJobStore(dbPath, { trustedRoot: root });
    try {
      if (operation === 'reserve' || operation === 'statement_full') {
        store.reserve({
          ownerUuid: OWNER,
          sessionPath: '/sessions/fault-owner.jsonl',
          namespace: 'tool_call',
          requestKey: operation === 'reserve' ? 'fault-reserve' : 'fault-full',
          command:
            operation === 'statement_full'
              ? `echo ${'x'.repeat(1_000_000)}`
              : `echo ${'x'.repeat(500_000)}`,
          cwd: '/tmp',
          candidateJobId: CANDIDATE_JOB_ID,
        });
      } else if (operation === 'claim_runner') {
        store.claimRunner(OWNER, jobId, CLAIM_ID, runnerToken);
      } else if (operation === 'heartbeat') {
        store.heartbeat(OWNER, jobId, CLAIM_ID, 0, runnerToken);
      } else if (operation === 'publish_uncertain') {
        store.publishUncertainResult(OWNER, jobId, {
          observedClaimId: null,
          observedCounter: 0,
          observedRevision: 0,
        });
      } else {
        store.publishResult(
          OWNER,
          jobId,
          CLAIM_ID,
          null,
          {
            launch: 'launched',
            shellCode: 0,
            cleanupState: 'unconfirmed',
            stdout: { available: true, incomplete: false },
            stderr: { available: true, incomplete: false },
            finalized: true,
          },
          runnerToken,
        );
      }
    } catch (error) {
      mapped = errorShape(error);
    }
    if (observation.nativeFault?.stage === 'commit') {
      try {
        store.reserve({
          ownerUuid: OWNER,
          sessionPath: '/sessions/fault-owner.jsonl',
          namespace: 'tool_call',
          requestKey: 'must-stay-disabled',
          command: 'echo never-run',
          cwd: '/tmp',
        });
      } catch (error) {
        writeAfterFault = errorShape(error);
      }
    }
  } finally {
    observation.restoreCap();
    store?.close();
  }

  const reopenedStore = createJobStore(dbPath, { trustedRoot: root });
  try {
    const jobs = reopenedStore.listJobs(OWNER);
    const target = jobs.find(
      (job) => job.jobId === (jobId || CANDIDATE_JOB_ID),
    );
    const results = jobs.flatMap((job) =>
      reopenedStore.listResults(OWNER, job.jobId),
    );
    const notices = jobs.flatMap((job) =>
      reopenedStore.listNotices(OWNER, job.jobId),
    );
    const observationAfter = target
      ? reopenedStore.observeJob(OWNER, target.jobId)
      : undefined;
    if (operation === 'heartbeat' || operation === 'publish_result') {
      try {
        reopenedStore.claimRunner(OWNER, jobId, 'replacement', runnerToken);
      } catch (error) {
        if (error instanceof StoreError) replacementClaimCode = error.code;
      }
    }
    reopened = {
      jobsDigest: jobsDigest(jobs),
      targetPresent: target !== undefined,
      jobCount: jobs.length,
      ...(target && observationAfter
        ? {
            jobId: target.jobId,
            state: observationAfter.job.state,
            claimId: observationAfter.claimId,
            heartbeatCounter: observationAfter.heartbeatCounter,
            latestRevision: observationAfter.latestRevision,
            finalized: observationAfter.finalized,
          }
        : {}),
      resultCount: results.length,
      noticeCount: notices.length,
    };
  } finally {
    reopenedStore.close();
  }

  return {
    operation,
    nativeFault: observation.nativeFault,
    mapped,
    writeAfterFault,
    replacementClaimCode,
    reopened,
    seedWalBytes: walBytes(dbPath),
  };
}

// Node 26 runs this TypeScript fixture directly. It is also imported by the
// parent test, so only an explicit child invocation enters the fault process.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , root, operation, jobId = '', runnerToken = ''] = process.argv;
  if (
    root === undefined ||
    !(
      operation === 'reserve' ||
      operation === 'claim_runner' ||
      operation === 'heartbeat' ||
      operation === 'publish_result' ||
      operation === 'publish_uncertain' ||
      operation === 'statement_full'
    )
  ) {
    process.exitCode = 2;
  } else {
    // Observe EFBIG as SQLite's write error rather than letting the OS signal
    // terminate this disposable process before it can report the native fault.
    process.on('SIGXFSZ', () => {});
    try {
      process.stdout.write(
        `${JSON.stringify(runChild(root, operation, jobId, runnerToken))}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
