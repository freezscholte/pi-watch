import { appendFileSync, existsSync } from 'node:fs';
import { StoreWriteError } from './job-types.ts';

export interface InternalSeams {
  runnerExecutable: string | undefined;
  guardianPath: string | undefined;
  shPath: string | undefined;
  psPath: string | undefined;
  pauseBeforeDecide: boolean;
  pauseAfterAuthorized: boolean;
  pauseAfterAuthorizedMs: number;
  pauseControllerAfterLaunch: boolean;
  disconnectBeforeGrantSend: boolean;
  decisionFailure: 'before' | 'after' | undefined;
  guardianMode: string | undefined;
  guardianLog: string | undefined;
  runnerLog: string | undefined;
  publishDelayMs: number;
  /** Internal-only result-publication failure boundary for lifecycle tests. */
  publicationFailure: 'launch_before' | 'launch_after' | 'terminal' | undefined;
  /** Internal-only runner stream error selector. */
  streamError: 'stdout' | 'stderr' | undefined;
  /**
   * Optional synthetic Error detail for the gated stream-error seam only.
   * Accepted only at no more than 128 UTF-8 bytes and never logged.
   */
  streamErrorDetail: string | undefined;
  /** Internal-only pause after the cutover deadline and before the freeze fence. */
  freezeDelayMs: number;
  /** Internal-only duplicate-trigger and post-freeze callback probe. */
  raceCoordinator: boolean;
  /**
   * Internal-only bounded-capture fault selector. Enabled only when the
   * explicit test gate is set; production arguments cannot reach this seam.
   */
  captureFault: string | undefined;
}

export function internalSeams(
  env: NodeJS.ProcessEnv = process.env,
  acceptForwardedGuardianMode = false,
): InternalSeams {
  const pauseAfterAuthorizedMs = Number(
    env.PI_WATCH_TEST_PAUSE_AFTER_AUTHORIZED_MS ?? 0,
  );
  const freezeDelayMs = Number(env.PI_WATCH_TEST_FREEZE_DELAY_MS ?? 0);
  const internalGate = env.PI_WATCH_INTERNAL_TEST_SEAMS === '1';
  const streamErrorDetail = env.PI_WATCH_TEST_STREAM_ERROR_DETAIL;
  const boundedStreamErrorDetail =
    internalGate &&
    streamErrorDetail !== undefined &&
    Buffer.byteLength(streamErrorDetail, 'utf8') <= 128
      ? streamErrorDetail
      : undefined;
  return {
    runnerExecutable: env.PI_WATCH_TEST_RUNNER_EXECUTABLE,
    guardianPath: env.PI_WATCH_TEST_GUARDIAN_PATH,
    shPath: env.PI_WATCH_TEST_SH_PATH,
    psPath: env.PI_WATCH_TEST_PS_PATH,
    pauseBeforeDecide: env.PI_WATCH_TEST_PAUSE_BEFORE_DECIDE === '1',
    pauseAfterAuthorized: env.PI_WATCH_TEST_PAUSE_AFTER_AUTHORIZED === '1',
    pauseAfterAuthorizedMs:
      Number.isFinite(pauseAfterAuthorizedMs) && pauseAfterAuthorizedMs > 0
        ? Math.min(30_000, Math.floor(pauseAfterAuthorizedMs))
        : 0,
    pauseControllerAfterLaunch:
      env.PI_WATCH_TEST_PAUSE_CONTROLLER_AFTER_LAUNCH === '1',
    disconnectBeforeGrantSend:
      env.PI_WATCH_TEST_DISCONNECT_BEFORE_GRANT_SEND === '1',
    decisionFailure:
      env.PI_WATCH_TEST_DECISION_FAILURE === 'before' ||
      env.PI_WATCH_TEST_DECISION_FAILURE === 'after'
        ? env.PI_WATCH_TEST_DECISION_FAILURE
        : undefined,
    guardianMode:
      env.PI_WATCH_TEST_GUARDIAN_MODE === 'withhold-all-and-hold' ||
      env.PI_WATCH_TEST_GUARDIAN_MODE === 'disconnect-after-exit'
        ? internalGate || acceptForwardedGuardianMode
          ? env.PI_WATCH_TEST_GUARDIAN_MODE
          : undefined
        : env.PI_WATCH_TEST_GUARDIAN_MODE,
    guardianLog: env.PI_WATCH_TEST_GUARDIAN_LOG,
    runnerLog: env.PI_WATCH_TEST_RUNNER_LOG,
    publishDelayMs: Number(env.PI_WATCH_TEST_PUBLISH_DELAY_MS ?? 0),
    publicationFailure:
      internalGate &&
      (env.PI_WATCH_TEST_PUBLICATION_FAILURE === 'launch_before' ||
        env.PI_WATCH_TEST_PUBLICATION_FAILURE === 'launch_after' ||
        env.PI_WATCH_TEST_PUBLICATION_FAILURE === 'terminal')
        ? env.PI_WATCH_TEST_PUBLICATION_FAILURE
        : undefined,
    streamError:
      internalGate &&
      (env.PI_WATCH_TEST_STREAM_ERROR === 'stdout' ||
        env.PI_WATCH_TEST_STREAM_ERROR === 'stderr')
        ? env.PI_WATCH_TEST_STREAM_ERROR
        : undefined,
    streamErrorDetail: boundedStreamErrorDetail,
    freezeDelayMs:
      internalGate && Number.isFinite(freezeDelayMs) && freezeDelayMs > 0
        ? Math.min(2_000, Math.floor(freezeDelayMs))
        : 0,
    raceCoordinator: internalGate && env.PI_WATCH_TEST_RACE_COORDINATOR === '1',
    captureFault: internalGate ? env.PI_WATCH_TEST_CAPTURE_FAULT : undefined,
  };
}

export function recordRunnerPid(
  logPath: string | undefined,
  pid: number,
): void {
  recordRunnerEvent(logPath, `runner_pid ${pid}`);
}

export function recordRunnerEvent(
  logPath: string | undefined,
  event: string,
): void {
  if (logPath === undefined) return;
  try {
    appendFileSync(logPath, `${event}\n`);
  } catch {
    // Fixture diagnostics are never lifecycle authority.
  }
}

export function waitAtSeam(enabled: boolean, timeoutMs = 30_000): void {
  if (!enabled) return;
  const until = Date.now() + timeoutMs;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < until) Atomics.wait(cell, 0, 0, 25);
}

export async function waitAtAsyncSeam(enabled: boolean): Promise<void> {
  if (!enabled) return;
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}

export async function decideLaunchAtTestBoundary<T>(
  failure: InternalSeams['decisionFailure'],
  decide: () => Promise<T>,
): Promise<T> {
  if (failure === 'before') throw new Error('test decision call failure');
  const decision = await decide();
  if (failure === 'after') throw new StoreWriteError('unknown');
  return decision;
}

export function utilityPaths(env: NodeJS.ProcessEnv = process.env): {
  sh: string;
  ps: string;
} {
  const seams = internalSeams(env);
  const sh = seams.shPath;
  const ps = seams.psPath;
  if (sh !== undefined && sh.length > 0 && ps !== undefined && ps.length > 0) {
    return { sh, ps };
  }
  const defaultPs =
    process.platform === 'linux'
      ? existsSync('/bin/ps')
        ? '/bin/ps'
        : '/usr/bin/ps'
      : '/bin/ps';
  return {
    sh: sh !== undefined && sh.length > 0 ? sh : '/bin/sh',
    ps: ps !== undefined && ps.length > 0 ? ps : defaultPs,
  };
}
