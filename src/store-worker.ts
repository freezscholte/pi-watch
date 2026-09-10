/**
 * SQLite store worker (plan KTD1): a small worker-thread entry point that
 * owns the synchronous database so lock waits never block the Pi event
 * loop. Communication is a tiny request/response protocol over
 * MessagePorts; see store-client.ts for the async facade.
 */
import {
  isMainThread,
  type MessagePort,
  parentPort,
} from 'node:worker_threads';
import {
  createJobStore,
  type JobStore,
  type JobStoreOptions,
} from './job-store.ts';
import {
  AmbiguousAcceptanceError,
  type StoreDiagnostic,
  StoreError,
  StoreWriteError,
  toDiagnostic,
} from './job-types.ts';

export interface StoreRequestMessage {
  id: number;
  op: string;
  payload: unknown;
}

export interface StoreResponseMessage {
  id: number;
  ok: true;
  result: unknown;
}

export interface StoreErrorResponseMessage {
  id: number;
  ok: false;
  error: StoreDiagnostic;
  /** Typed operation receipt, separate from redacted diagnostic content. */
  candidateJobId?: string;
  commitOutcome?: 'unknown' | 'committed';
}

export type StoreWorkerInitMessage =
  | { type: 'ready' }
  | { type: 'init-error'; error: StoreDiagnostic };

/** Serves store requests on the given port. Returns the close function. */
export function runStoreWorker(
  port: MessagePort,
  dbPath: string,
  options: JobStoreOptions,
): (() => void) | undefined {
  let store: JobStore;
  try {
    store = createJobStore(dbPath, options);
  } catch (error) {
    port.postMessage({ type: 'init-error', error: toDiagnostic(error) });
    return;
  }
  port.postMessage({ type: 'ready' });

  function payloadOf(payload: unknown): Record<string, unknown> {
    if (typeof payload !== 'object' || payload === null) {
      throw new StoreError('VALIDATION_FAILED', 'Malformed store request.');
    }
    return payload as Record<string, unknown>;
  }

  function asNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new StoreError('VALIDATION_FAILED', `${label} must be an integer.`);
    }
    return value;
  }

  function optionalRevision(value: unknown): number | null {
    return value === null ? null : asNumber(value, 'Expected revision');
  }

  const handlers: Record<
    string,
    (payload: Record<string, unknown>) => unknown
  > = {
    ping: () => 'pong',
    reserve: (payload) => store.reserve(payloadOf(payload) as never),
    get_job: (payload) => {
      const p = payloadOf(payload);
      return store.getJob(p.ownerUuid as string, p.jobId as string);
    },
    list_jobs: (payload) =>
      store.listJobs(payloadOf(payload).ownerUuid as string),
    claim_runner: (payload) => {
      const p = payloadOf(payload);
      return store.claimRunner(
        p.ownerUuid as string,
        p.jobId as string,
        p.claimId as string,
        p.runnerToken as string | null,
      );
    },
    heartbeat: (payload) => {
      const p = payloadOf(payload);
      return store.heartbeat(
        p.ownerUuid as string,
        p.jobId as string,
        p.claimId as string,
        asNumber(p.expectedCounter, 'Heartbeat counter'),
        p.runnerToken as string | null,
      );
    },
    publish_result: (payload) => {
      const p = payloadOf(payload);
      return store.publishResult(
        p.ownerUuid as string,
        p.jobId as string,
        p.claimId as string,
        optionalRevision(p.expectedRevision),
        (p.evidence ?? {}) as never,
        p.runnerToken as string | null,
      );
    },
    publish_uncertain_result: (payload) => {
      const p = payloadOf(payload);
      return store.publishUncertainResult(
        p.ownerUuid as string,
        jobIdOf(p),
        (p.witness ?? {}) as never,
      );
    },
    observe_job: (payload) => {
      const p = payloadOf(payload);
      return store.observeJob(p.ownerUuid as string, p.jobId as string);
    },
    acknowledge_notice: (payload) => {
      const p = payloadOf(payload);
      store.acknowledgeNotice(
        p.ownerUuid as string,
        p.jobId as string,
        asNumber(p.revision, 'Revision'),
      );
      return undefined;
    },
    list_notices: (payload) => {
      const p = payloadOf(payload);
      return store.listNotices(p.ownerUuid as string, p.jobId as string);
    },
    list_pending_notices: (payload) =>
      store.listPendingNotices(payloadOf(payload).ownerUuid as string),
    list_results: (payload) => {
      const p = payloadOf(payload);
      return store.listResults(p.ownerUuid as string, p.jobId as string);
    },
  };

  const onMessage = (message: unknown) => {
    // Parse defensively first; every failure replies with an allowlisted
    // diagnostic instead of crashing the worker.
    const request: StoreRequestMessage | null =
      typeof message === 'object' &&
      message !== null &&
      typeof (message as { id?: unknown }).id === 'number' &&
      typeof (message as { op?: unknown }).op === 'string'
        ? (message as StoreRequestMessage)
        : null;
    const id = request?.id ?? -1;
    try {
      if (request === null) {
        throw new StoreError('VALIDATION_FAILED', 'Malformed store request.');
      }
      const handler = handlers[request.op];
      if (handler === undefined) {
        throw new StoreError('VALIDATION_FAILED', 'Unknown store operation.');
      }
      const result = handler(payloadOf(request.payload));
      const response: StoreResponseMessage = { id, ok: true, result };
      port.postMessage(response);
    } catch (error) {
      const response: StoreErrorResponseMessage = {
        id,
        ok: false,
        error: toDiagnostic(error),
      };
      if (error instanceof AmbiguousAcceptanceError) {
        response.candidateJobId = error.candidateJobId;
        response.commitOutcome = error.commitOutcome;
      } else if (error instanceof StoreWriteError) {
        response.commitOutcome = error.commitOutcome;
      }
      port.postMessage(response);
    }
  };
  port.on('message', onMessage);
  return () => {
    port.off('message', onMessage);
    store.close();
  };
}

function jobIdOf(payload: Record<string, unknown>): string {
  const jobId = payload.jobId;
  if (typeof jobId !== 'string') {
    throw new StoreError('VALIDATION_FAILED', 'Job id must be a string.');
  }
  return jobId;
}

// Auto-start when loaded as a worker thread (workerData carries the db path
// and the trusted root).
if (!isMainThread && parentPort !== null) {
  const data: unknown = (await import('node:worker_threads')).workerData;
  const readString = (key: string): string | undefined =>
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { [key: string]: unknown })[key] === 'string'
      ? (data as { [key: string]: string })[key]
      : undefined;
  const dbPath = readString('dbPath');
  const trustedRoot = readString('trustedRoot');
  if (dbPath === undefined || trustedRoot === undefined) {
    parentPort.postMessage({
      type: 'init-error',
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Worker requires a database path and a trusted root.',
      },
    });
  } else {
    runStoreWorker(parentPort, dbPath, { trustedRoot });
  }
}
