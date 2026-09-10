import { parentPort, workerData } from 'node:worker_threads';
import { createJobStore } from '../../src/job-store.ts';

if (parentPort === null) throw new Error('control worker requires parent port');
const port = parentPort;

const data = workerData as { dbPath: string; trustedRoot: string };
const store = createJobStore(data.dbPath, { trustedRoot: data.trustedRoot });
port.postMessage({ type: 'ready' });
const expiry = setTimeout(() => {
  store.close();
  port.close();
}, 10_000);

port.once('message', (message: unknown) => {
  const request = message as {
    id: number;
    op: 'request_cancellation' | 'decide_launch';
    payload: Record<string, unknown>;
  };
  try {
    if (request.op === 'request_cancellation') {
      store.requestCancellation(
        request.payload.ownerUuid as string,
        request.payload.jobId as string,
      );
    } else {
      store.decideLaunch(
        request.payload.ownerUuid as string,
        request.payload.jobId as string,
        request.payload.claimId as string,
        request.payload.runnerToken as string | null,
      );
    }
    // Lose the reply only after the real operation returned from COMMIT.
    // The caller also verifies persistence, so an earlier failure cannot pass.
  } finally {
    clearTimeout(expiry);
    store.close();
    port.close();
  }
});
