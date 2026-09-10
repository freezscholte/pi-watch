import { parentPort, workerData } from 'node:worker_threads';

const mode =
  typeof workerData === 'object' &&
  workerData !== null &&
  'startupMode' in workerData &&
  typeof workerData.startupMode === 'string'
    ? workerData.startupMode
    : 'ready';

if (mode === 'error') {
  throw new Error('PRIVATE_STARTUP_MARKER');
}
if (mode === 'early-exit') {
  process.exit(0);
}
if (mode === 'init-error' || mode === 'init-error-then-ready') {
  parentPort?.postMessage({
    type: 'init-error',
    error: { code: 'RUNTIME_UNSUPPORTED', message: 'PRIVATE_STARTUP_MARKER' },
  });
  if (mode === 'init-error-then-ready') {
    setTimeout(() => parentPort?.postMessage({ type: 'ready' }), 0);
  }
} else if (mode === 'ready') {
  parentPort?.postMessage({ type: 'ready' });
} else if (mode === 'late-ready') {
  setTimeout(() => parentPort?.postMessage({ type: 'ready' }), 250);
}

setTimeout(() => process.exit(0), 5_000);
