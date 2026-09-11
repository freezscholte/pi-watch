import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, closeSync } from 'node:fs';
import {
  type GuardianMessage,
  isGuardianMessage,
  sendGuardianMessage,
} from './guardian-protocol.ts';
import {
  attemptOwnGroupSignal,
  monotonicNow,
  type ProcessGroupProbe,
  startProcessGroupProbe,
} from './process-control.ts';
import { internalSeams } from './test-seams.ts';

type State =
  | 'starting'
  | 'ready'
  | 'granted'
  | 'shell_spawned'
  | 'cleaning'
  | 'exited'
  | 'refused';
let state: State = 'starting';
let shell: ChildProcess | undefined;
let cleanupStarted = false;
let deadlineTimer: NodeJS.Timeout | undefined;
let readinessTimer: NodeJS.Timeout | undefined;
let activeProbe: ProcessGroupProbe | undefined;
let helloReply: Extract<GuardianMessage, { type: 'hello_reply' }> | undefined;
let shellExited = false;
const seams = internalSeams();
const fixtureMode = seams.guardianMode ?? '';
const fixtureLog = seams.guardianLog;
function fixtureEvent(event: string): void {
  if (fixtureLog === undefined) return;
  try {
    appendFileSync(fixtureLog, `${event} ${monotonicNow()}\n`);
  } catch {
    // Fixture diagnostics are never lifecycle authority.
  }
}

function stop(code = 0): void {
  if (readinessTimer !== undefined) clearTimeout(readinessTimer);
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  activeProbe?.stop();
  activeProbe = undefined;
  closeOutputDescriptors();
  state = 'exited';
  process.exitCode = code;
  if (process.connected) process.disconnect?.();
}
function closeOutputDescriptors(): void {
  try {
    closeSync(4);
  } catch {
    /* already closed */
  }
  try {
    closeSync(5);
  } catch {
    /* already closed */
  }
}
function violation(): void {
  sendGuardianMessage({ type: 'protocol_violation', state });
}
function cleanup(deadline = false): void {
  if (cleanupStarted || state === 'refused' || state === 'exited') return;
  cleanupStarted = true;
  state = 'cleaning';
  if (deadline) {
    fixtureEvent('deadline_trigger');
    if (fixtureMode !== 'withhold-deadline')
      sendGuardianMessage({ type: 'deadline' });
  }
  const observation = attemptOwnGroupSignal('SIGTERM');
  fixtureEvent(`term_${observation}`);
  sendGuardianMessage({ type: 'cleanup_term', observation });
  // The grace begins after the TERM attempt returns, measured by the
  // monotonic timer itself; do not subtract pre-timer bookkeeping time.
  const grace = 5_000;
  setTimeout(() => {
    // KILL intent is sent before own-group KILL because the signal includes this guardian.
    fixtureEvent('kill_intent');
    sendGuardianMessage({ type: 'cleanup_kill_intent' });
    attemptOwnGroupSignal('SIGKILL');
    stop(0);
  }, grace);
}
process.on('SIGTERM', () => {
  if (state === 'granted' || state === 'shell_spawned' || state === 'cleaning')
    cleanup(false);
  else stop(1);
});
async function runProbe(psPath: string, pid: number): Promise<number | null> {
  const probe = startProcessGroupProbe(psPath, pid);
  activeProbe = probe;
  const result = await probe.result;
  if (activeProbe === probe) activeProbe = undefined;
  return result;
}
function isStopped(): boolean {
  return state === 'exited' || state === 'refused';
}
async function verifyTopology(
  runnerPid: number,
  psPath: string,
): Promise<void> {
  const own = await runProbe(psPath, process.pid);
  if (isStopped()) return;
  const runner = await runProbe(psPath, runnerPid);
  if (isStopped()) return;
  const ok =
    own !== null && runner !== null && own === process.pid && own !== runner;
  sendGuardianMessage(
    ok
      ? { type: 'topology', ok: true }
      : { type: 'topology', ok: false, reason: 'topology' },
  );
  if (!ok) {
    state = 'refused';
    stop(1);
    return;
  }
  state = 'ready';
}
function handleGrant(): void {
  if (state !== 'ready' || helloReply === undefined) {
    violation();
    return;
  }
  state = 'granted';
  if (fixtureMode === 'disconnect-before-shell') fixtureEvent('grant_received');
  const reply = helloReply;
  if (fixtureMode === 'disconnect-before-shell') {
    process.disconnect?.();
    return;
  }
  // deadlineAtMs is immutable wall-clock store data; cleanup grace below is monotonic.
  const delay = reply.deadlineAtMs - Date.now();
  if (delay <= 0) {
    fixtureEvent('deadline_trigger');
    sendGuardianMessage({ type: 'deadline' });
    sendGuardianMessage({
      type: 'shell_error',
      reason: 'expired_before_spawn',
    });
    stop(1);
    return;
  }
  deadlineTimer = setTimeout(() => cleanup(true), delay);
  try {
    shell = spawn(reply.shPath, ['-c', reply.command], {
      cwd: reply.cwd,
      detached: false,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('PI_WATCH_'),
        ),
      ),
      stdio: ['ignore', 4, 5],
    });
  } catch {
    closeOutputDescriptors();
    sendGuardianMessage({ type: 'shell_error', reason: 'spawn' });
    stop(1);
    return;
  }
  shell.once('spawn', () => {
    state = 'shell_spawned';
    if (fixtureMode !== 'withhold-spawn') {
      sendGuardianMessage({ type: 'shell_spawned', pid: shell?.pid ?? 0 });
    }
    if (
      fixtureMode === 'disconnect-after-spawn' ||
      fixtureMode === 'disconnect-and-hold'
    ) {
      fixtureEvent('spawn_receipt_sent');
      setImmediate(() => process.disconnect?.());
    }
    try {
      closeOutputDescriptors();
    } catch {
      /* descriptors may already be closed */
    }
  });
  shell.once('error', () => {
    if (!shellExited) {
      closeOutputDescriptors();
      sendGuardianMessage({ type: 'shell_error', reason: 'spawn' });
      stop(1);
    }
  });
  shell.once('exit', (code, signal) => {
    shellExited = true;
    if (fixtureMode !== 'withhold-exit') {
      fixtureEvent('shell_exit_receipt');
      sendGuardianMessage({ type: 'shell_exit', code, signal });
      cleanup(false);
    }
  });
}
if (typeof process.send !== 'function' || !process.connected) {
  state = 'refused';
  process.exitCode = 1;
} else {
  fixtureEvent(`guardian_pid ${process.pid}`);
  sendGuardianMessage({ type: 'hello', pid: process.pid });
  readinessTimer = setTimeout(() => {
    state = 'refused';
    stop(1);
  }, 2_000);
  process.on('disconnect', () => {
    const handleDisconnect = (): void => {
      if (state === 'shell_spawned' || state === 'granted') cleanup(false);
      else if (state !== 'exited') stop(1);
    };
    if (fixtureMode === 'delay-disconnect') setTimeout(handleDisconnect, 1_000);
    else if (fixtureMode === 'disconnect-and-hold')
      setTimeout(handleDisconnect, 10_000);
    else handleDisconnect();
  });
  process.on('message', (raw: unknown) => {
    if (!isGuardianMessage(raw)) return;
    const message = raw as GuardianMessage;
    if (message.type === 'hello_reply' && state === 'starting') {
      helloReply = message;
      if (readinessTimer !== undefined) clearTimeout(readinessTimer);
      if (fixtureMode === 'late-topology') {
        setTimeout(
          () => void verifyTopology(message.runnerPid, message.psPath),
          3_100,
        );
      } else {
        void verifyTopology(message.runnerPid, message.psPath);
      }
    } else if (message.type === 'grant') {
      handleGrant();
    }
  });
}
