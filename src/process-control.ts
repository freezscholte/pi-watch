import { type ChildProcess, spawn } from 'node:child_process';

export function monotonicNow(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export function attemptOwnGroupSignal(
  signal: NodeJS.Signals,
): 'returned' | 'error' {
  try {
    process.kill(0, signal);
    return 'returned';
  } catch {
    return 'error';
  }
}

export interface ProcessGroupProbe {
  result: Promise<number | null>;
  stop(): void;
}

function destroyProbeStdio(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export function startProcessGroupProbe(
  psPath: string,
  pid: number,
  timeoutMs = 1_000,
): ProcessGroupProbe {
  let child: ChildProcess | undefined;
  let stop = (): void => undefined;
  const result = new Promise<number | null>((resolve) => {
    let settled = false;
    let stdout = '';
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: number | null, kill: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (child !== undefined) {
        if (kill && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* the exact owned probe already exited */
          }
        }
        destroyProbeStdio(child);
        child.unref();
      }
      resolve(value);
    };
    stop = () => finish(null, true);
    try {
      child = spawn(psPath, ['-o', 'pgid=', '-p', String(pid)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      finish(null, false);
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 4_096) finish(null, true);
    });
    child.once('error', () => finish(null, true));
    child.once('close', (code) => {
      if (code !== 0 || Buffer.byteLength(stdout) > 4_096) {
        finish(null, false);
        return;
      }
      const value = stdout.trim();
      if (!/^\d+$/.test(value)) {
        finish(null, false);
        return;
      }
      const pgid = Number(value);
      finish(Number.isSafeInteger(pgid) ? pgid : null, false);
    });
    timer = setTimeout(() => finish(null, true), timeoutMs);
  });
  return { result, stop: () => stop() };
}

export function probeProcessGroup(
  psPath: string,
  pid: number,
  timeoutMs = 1_000,
): Promise<number | null> {
  return startProcessGroupProbe(psPath, pid, timeoutMs).result;
}
