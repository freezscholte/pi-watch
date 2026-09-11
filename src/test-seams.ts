import { appendFileSync, existsSync } from 'node:fs';
import { StoreWriteError } from './job-types.ts';

export interface InternalSeams {
  guardianPath: string | undefined;
  shPath: string | undefined;
  psPath: string | undefined;
  pauseBeforeDecide: boolean;
  pauseAfterAuthorized: boolean;
  pauseControllerAfterLaunch: boolean;
  disconnectBeforeGrantSend: boolean;
  decisionFailure: 'before' | 'after' | undefined;
  guardianMode: string | undefined;
  guardianLog: string | undefined;
  runnerLog: string | undefined;
  publishDelayMs: number;
}

export function internalSeams(
  env: NodeJS.ProcessEnv = process.env,
): InternalSeams {
  return {
    guardianPath: env.PI_WATCH_TEST_GUARDIAN_PATH,
    shPath: env.PI_WATCH_TEST_SH_PATH,
    psPath: env.PI_WATCH_TEST_PS_PATH,
    pauseBeforeDecide: env.PI_WATCH_TEST_PAUSE_BEFORE_DECIDE === '1',
    pauseAfterAuthorized: env.PI_WATCH_TEST_PAUSE_AFTER_AUTHORIZED === '1',
    pauseControllerAfterLaunch:
      env.PI_WATCH_TEST_PAUSE_CONTROLLER_AFTER_LAUNCH === '1',
    disconnectBeforeGrantSend:
      env.PI_WATCH_TEST_DISCONNECT_BEFORE_GRANT_SEND === '1',
    decisionFailure:
      env.PI_WATCH_TEST_DECISION_FAILURE === 'before' ||
      env.PI_WATCH_TEST_DECISION_FAILURE === 'after'
        ? env.PI_WATCH_TEST_DECISION_FAILURE
        : undefined,
    guardianMode: env.PI_WATCH_TEST_GUARDIAN_MODE,
    guardianLog: env.PI_WATCH_TEST_GUARDIAN_LOG,
    runnerLog: env.PI_WATCH_TEST_RUNNER_LOG,
    publishDelayMs: Number(env.PI_WATCH_TEST_PUBLISH_DELAY_MS ?? 0),
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

export function waitAtSeam(enabled: boolean): void {
  if (!enabled) return;
  const until = Date.now() + 30_000;
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
