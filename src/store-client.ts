/**
 * Asynchronous store client (plan KTD1): the facade the Pi adapter and
 * runner use. It runs the synchronous SQLite store on a short-lived worker
 * thread (store-worker.ts) so SQLite lock waits cannot block the host
 * event loop. Worker loss rejects pending reservations with their retained
 * identity and unknown acceptance; other pending/new calls report storage
 * unavailability rather than inventing a command outcome.
 */
import { Worker } from 'node:worker_threads';
import {
  checkRuntimeSupport,
  type JobObservation,
  type JobRecord,
  type NoticeRecord,
  type ReservationInput,
  type ReservationResult,
  type ResultRecord,
  type RunnerClaim,
} from './job-store.ts';
import {
  AmbiguousAcceptanceError,
  allocateReservationId,
  type StoreDiagnostic,
  StoreError,
  StoreWriteError,
} from './job-types.ts';
import type { EvidenceInput } from './store-evidence.ts';
import type {
  StoreErrorResponseMessage,
  StoreResponseMessage,
  StoreWorkerInitMessage,
} from './store-worker.ts';

export type {
  JobObservation,
  JobRecord,
  NoticeRecord,
  ReservationResult,
  ResultRecord,
  RunnerClaim,
};

export interface StoreClient {
  reserve(input: ReservationInput): Promise<ReservationResult>;
  getJob(ownerUuid: string, jobId: string): Promise<JobRecord>;
  listJobs(ownerUuid: string): Promise<JobRecord[]>;
  observeJob(ownerUuid: string, jobId: string): Promise<JobObservation>;
  claimRunner(
    ownerUuid: string,
    jobId: string,
    claimId: string,
    runnerToken: string | null,
  ): Promise<RunnerClaim>;
  heartbeat(
    ownerUuid: string,
    jobId: string,
    claimId: string,
    expectedCounter: number,
    runnerToken: string | null,
  ): Promise<{ counter: number }>;
  publishResult(
    ownerUuid: string,
    jobId: string,
    claimId: string,
    expectedRevision: number | null,
    evidence: EvidenceInput,
    runnerToken: string | null,
  ): Promise<ResultRecord>;
  publishUncertainResult(
    ownerUuid: string,
    jobId: string,
    witness: {
      observedClaimId: string | null;
      observedCounter: number;
      observedRevision: number;
    },
  ): Promise<ResultRecord>;
  acknowledgeNotice(
    ownerUuid: string,
    jobId: string,
    revision: number,
  ): Promise<void>;
  listNotices(ownerUuid: string, jobId: string): Promise<NoticeRecord[]>;
  listPendingNotices(ownerUuid: string): Promise<NoticeRecord[]>;
  listResults(ownerUuid: string, jobId: string): Promise<ResultRecord[]>;
  close(): Promise<void>;
  /**
   * Test/ops seam: terminates the original worker handle for real worker-loss
   * coverage. Pending reservations retain acceptance uncertainty; new calls
   * reject with STORE_UNAVAILABLE because no request was handed off.
   */
  terminateWorker(): Promise<void>;
}

type Pending = {
  candidateJobId: string | undefined;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

/** Diagnostics with code UNKNOWN (non-store failures) surface as STORE_UNAVAILABLE. */
function storeErrorFromDiagnostic(diagnostic: StoreDiagnostic): StoreError {
  // Worker payloads are a trust boundary: preserve the allowlisted code, but
  // never re-emit a message supplied by a worker or native dependency.
  const code =
    diagnostic.code === 'UNKNOWN' ? 'STORE_UNAVAILABLE' : diagnostic.code;
  const message =
    code === 'SCHEMA_TOO_NEW'
      ? 'Store schema is newer; update pi-watch.'
      : code === 'RUNTIME_UNSUPPORTED'
        ? 'Runtime is unsupported by pi-watch.'
        : code === 'STORE_UNAVAILABLE'
          ? 'Store is unavailable.'
          : undefined;
  return new StoreError(code, message);
}

const WORKER_TERMINATION_TIMEOUT_MS = 5_000;
const STARTUP_CLEANUP_TIMEOUT_MS = 1_000;

/**
 * Opening options for the async store client (finding #3, approved modified-A
 * decision): the trusted anchor directory is mandatory. The database path must
 * resolve strictly inside it; hooks cannot cross the worker boundary and are
 * therefore only supported on the synchronous store.
 */
export interface StoreClientOptions {
  /** Mandatory trusted anchor directory (finding #3, approved modified-A decision). */
  trustedRoot: string;
  /** Test-only startup worker URL; production resolves the matching source/build entry. */
  startupWorkerUrl?: URL;
  /** Test-only startup timeout override. */
  startupTimeoutMs?: number;
  /** Test-only startup fixture mode. */
  startupWorkerMode?: string;
  /** Test-only observation of the real startup Worker handle. */
  onStartupWorker?: (worker: Worker) => void;
}

export async function openStoreClient(
  dbPath: string,
  options: StoreClientOptions,
): Promise<StoreClient> {
  checkRuntimeSupport();
  // Runtime guard for JS callers: malformed/missing options must return a
  // redacted StoreError, not leak a TypeError.
  if (
    options === null ||
    typeof options !== 'object' ||
    typeof options.trustedRoot !== 'string'
  ) {
    throw new StoreError(
      'PATH_UNSAFE',
      'Trusted root must be an absolute, well-formed path.',
    );
  }
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let workerFailed: StoreDiagnostic | null = null;

  function failAll(error: StoreError): void {
    workerFailed = { code: error.code };
    for (const entry of pending.values()) {
      entry.reject(
        entry.candidateJobId === undefined
          ? error
          : new AmbiguousAcceptanceError(entry.candidateJobId),
      );
    }
    pending.clear();
  }

  const startupTimeoutMs =
    options.startupTimeoutMs ?? WORKER_TERMINATION_TIMEOUT_MS;
  const sourceUrl = new URL(import.meta.url);
  const defaultWorkerUrl = new URL(
    sourceUrl.pathname.endsWith('.ts')
      ? './store-worker.ts'
      : './store-worker.js',
    sourceUrl,
  );
  const worker = new Worker(options.startupWorkerUrl ?? defaultWorkerUrl, {
    workerData: {
      dbPath,
      trustedRoot: options.trustedRoot,
      startupMode: options.startupWorkerMode,
    },
    // The store worker must never keep the host alive on its own.
    stdout: true,
    stderr: true,
  });
  worker.unref();

  let startupSettled = false;
  let startupFailureStarted = false;
  let startupTimeout: NodeJS.Timeout | undefined;
  let resolveStartup!: () => void;
  let rejectStartup!: (error: unknown) => void;
  const startup = new Promise<void>((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });

  const startupCleanupFailure = (error: StoreError): StoreError => {
    const message =
      error.code === 'SCHEMA_TOO_NEW'
        ? 'Store schema is newer; update pi-watch; startup cleanup was not confirmed.'
        : error.code === 'RUNTIME_UNSUPPORTED'
          ? 'Runtime is unsupported by pi-watch; startup cleanup was not confirmed.'
          : 'Store startup failed; cleanup was not confirmed.';
    return new StoreError(error.code, message);
  };

  const terminateFailedStartup = async (error: StoreError): Promise<void> => {
    if (startupFailureStarted) return;
    startupFailureStarted = true;
    if (startupTimeout !== undefined) clearTimeout(startupTimeout);
    let cleanupTimer: NodeJS.Timeout | undefined;
    const termination = Promise.resolve().then(() => worker.terminate());
    const outcome = await Promise.race([
      termination.then(
        () => 'fulfilled' as const,
        () => 'failed' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        cleanupTimer = setTimeout(
          () => resolve('timeout'),
          STARTUP_CLEANUP_TIMEOUT_MS,
        );
      }),
    ]);
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    rejectStartup(
      outcome === 'fulfilled' ? error : startupCleanupFailure(error),
    );
  };

  const failStartup = (error: StoreError): void => {
    if (startupSettled || startupFailureStarted) return;
    startupSettled = true;
    void terminateFailedStartup(error);
  };

  const onWorkerMessage = (message: unknown): void => {
    if (!startupSettled) {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'ready'
      ) {
        startupSettled = true;
        if (startupTimeout !== undefined) clearTimeout(startupTimeout);
        resolveStartup();
      } else if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'init-error'
      ) {
        const init = message as Extract<
          StoreWorkerInitMessage,
          { type: 'init-error' }
        >;
        failStartup(storeErrorFromDiagnostic(init.error));
      }
      return;
    }
    if (
      typeof message !== 'object' ||
      message === null ||
      typeof (message as { id?: unknown }).id !== 'number'
    ) {
      return;
    }
    const entry = pending.get((message as { id: number }).id);
    if (entry === undefined) return;
    pending.delete((message as { id: number }).id);
    if ((message as { ok?: unknown }).ok === true) {
      entry.resolve((message as StoreResponseMessage).result);
    } else {
      const response = message as StoreErrorResponseMessage;
      const diagnostic = response.error;
      const candidateJobId = response.candidateJobId ?? entry.candidateJobId;
      if (
        diagnostic.code === 'ACCEPTANCE_UNCONFIRMED' &&
        typeof candidateJobId === 'string'
      ) {
        entry.reject(
          new AmbiguousAcceptanceError(
            candidateJobId,
            response.commitOutcome ?? 'unknown',
          ),
        );
      } else if (response.commitOutcome !== undefined) {
        entry.reject(new StoreWriteError(response.commitOutcome));
      } else {
        entry.reject(storeErrorFromDiagnostic(diagnostic));
      }
    }
  };
  worker.on('message', onWorkerMessage);
  worker.on('error', (error) => {
    if (!startupSettled) {
      void error; // raw error content never escapes
      failStartup(
        new StoreError('STORE_UNAVAILABLE', 'Store worker failed to start.'),
      );
    } else {
      failAll(new StoreError('STORE_UNAVAILABLE', 'Store worker failed.'));
    }
  });
  worker.on('exit', (code) => {
    if (!startupSettled) {
      failStartup(
        new StoreError(
          'STORE_UNAVAILABLE',
          code === 0
            ? 'Store worker stopped before it was ready.'
            : 'Store worker failed to start.',
        ),
      );
    } else if (code !== 0) {
      failAll(
        new StoreError(
          'STORE_UNAVAILABLE',
          'Store worker exited unexpectedly.',
        ),
      );
    } else {
      failAll(new StoreError('STORE_UNAVAILABLE', 'Store worker has stopped.'));
    }
  });
  startupTimeout = setTimeout(() => {
    failStartup(
      new StoreError(
        'STORE_UNAVAILABLE',
        'Store worker did not start in time.',
      ),
    );
  }, startupTimeoutMs);
  try {
    options.onStartupWorker?.(worker);
  } catch {
    failStartup(
      new StoreError('STORE_UNAVAILABLE', 'Store worker startup failed.'),
    );
  }

  await startup;

  function request<T>(
    op: string,
    payload: unknown,
    candidateJobId?: string,
  ): Promise<T> {
    if (workerFailed !== null) {
      return Promise.reject(
        new StoreError('STORE_UNAVAILABLE', 'Store worker has stopped.'),
      );
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        candidateJobId,
      });
      try {
        worker.postMessage({ id, op, payload });
      } catch {
        pending.delete(id);
        reject(
          new StoreError(
            'VALIDATION_FAILED',
            'Store request could not be sent.',
          ),
        );
      }
    });
  }

  return {
    reserve: async (input) => {
      const candidateJobId = allocateReservationId(input.candidateJobId);
      return request<ReservationResult>(
        'reserve',
        { ...input, candidateJobId },
        candidateJobId,
      );
    },
    getJob: (ownerUuid, jobId) =>
      request<JobRecord>('get_job', { ownerUuid, jobId }),
    listJobs: (ownerUuid) => request<JobRecord[]>('list_jobs', { ownerUuid }),
    observeJob: (ownerUuid, jobId) =>
      request<JobObservation>('observe_job', { ownerUuid, jobId }),
    claimRunner: (ownerUuid, jobId, claimId, runnerToken) =>
      request<RunnerClaim>('claim_runner', {
        ownerUuid,
        jobId,
        claimId,
        runnerToken,
      }),
    heartbeat: (ownerUuid, jobId, claimId, expectedCounter, runnerToken) =>
      request<{ counter: number }>('heartbeat', {
        ownerUuid,
        jobId,
        claimId,
        expectedCounter,
        runnerToken,
      }),
    publishResult: (
      ownerUuid,
      jobId,
      claimId,
      expectedRevision,
      evidence,
      runnerToken,
    ) =>
      request<ResultRecord>('publish_result', {
        ownerUuid,
        jobId,
        claimId,
        expectedRevision,
        evidence,
        runnerToken,
      }),
    publishUncertainResult: (ownerUuid, jobId, witness) =>
      request<ResultRecord>('publish_uncertain_result', {
        ownerUuid,
        jobId,
        witness,
      }),
    acknowledgeNotice: (ownerUuid, jobId, revision) =>
      request<void>('acknowledge_notice', { ownerUuid, jobId, revision }),
    listNotices: (ownerUuid, jobId) =>
      request<NoticeRecord[]>('list_notices', { ownerUuid, jobId }),
    listPendingNotices: (ownerUuid) =>
      request<NoticeRecord[]>('list_pending_notices', { ownerUuid }),
    listResults: (ownerUuid, jobId) =>
      request<ResultRecord[]>('list_results', { ownerUuid, jobId }),
    async close() {
      failAll(new StoreError('STORE_UNAVAILABLE', 'Store client closed.'));
      await worker.terminate();
    },
    async terminateWorker() {
      // Real termination of the original handle; the worker's exit event
      // rejects every pending request through failAll.
      await worker.terminate();
    },
  };
}
