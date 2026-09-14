import { type ChildProcess, spawn } from 'node:child_process';
import type { TestContext } from 'node:test';

export interface OwnedProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflowed: boolean;
  errorCode: string | null;
  errorStack: string;
  errorCause: string;
}

export interface OwnedProcessRegistry {
  trackChild(child: ChildProcess, options?: { pgid?: number }): void;
  recordPid(pid: number): void;
  recordGroup(pgid: number): void;
  signalPid(pid: number, signal: NodeJS.Signals): void;
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
  run(
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; timeoutMs: number; detached?: boolean },
  ): Promise<OwnedProcessResult>;
  reap(): Promise<void>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function killExact(child: ChildProcess, pgid: number | undefined): void {
  try {
    if (pgid !== undefined) process.kill(-pgid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // The exact recorded process or group already exited.
  }
}

/** Per-test ownership ledger. It never discovers or reconstructs identities. */
export function useOwnedProcessRegistry(
  context: TestContext,
): OwnedProcessRegistry {
  const children = new Set<ChildProcess>();
  const pids = new Set<number>();
  const groups = new Set<number>();
  let reaped = false;

  const trackChild = (
    child: ChildProcess,
    options: { pgid?: number } = {},
  ): void => {
    children.add(child);
    if (child.pid !== undefined) pids.add(child.pid);
    if (options.pgid !== undefined) groups.add(options.pgid);
    child.once('close', () => children.delete(child));
  };

  const reap = async (): Promise<void> => {
    if (reaped) return;
    reaped = true;
    for (const group of groups) {
      if (group <= 1 || group === process.pid) continue;
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // The exact recorded group already exited.
      }
    }
    for (const child of children) killExact(child, undefined);
    for (const pid of pids) {
      if (pid <= 1 || pid === process.pid || !alive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The exact recorded process already exited.
      }
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const retainedGone = [...children].every(
        (child) =>
          child.exitCode !== null ||
          child.signalCode !== null ||
          child.pid === undefined ||
          !alive(child.pid),
      );
      const pidsGone = [...pids].every((pid) => !alive(pid));
      const groupsGone = [...groups].every((group) => !groupAlive(group));
      if (retainedGone && pidsGone && groupsGone) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const retainedLive = [...children].some(
      (child) =>
        child.exitCode === null &&
        child.signalCode === null &&
        child.pid !== undefined &&
        alive(child.pid),
    );
    const pidLive = [...pids].some((pid) => alive(pid));
    const groupLive = [...groups].some((group) => groupAlive(group));
    if (retainedLive || pidLive || groupLive)
      throw new Error('owned process cleanup left a recorded actor alive');
  };

  const registry: OwnedProcessRegistry = {
    trackChild,
    recordPid(pid) {
      if (Number.isInteger(pid) && pid > 1) pids.add(pid);
    },
    recordGroup(pgid) {
      if (Number.isInteger(pgid) && pgid > 1) groups.add(pgid);
    },
    signalPid(pid, signal) {
      if (!pids.has(pid))
        throw new Error('refusing to signal an unrecorded process');
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
    signalGroup(pgid, signal) {
      if (!groups.has(pgid))
        throw new Error('refusing to signal an unrecorded process group');
      try {
        process.kill(-pgid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
    run(command, args, options) {
      return new Promise((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(command, args, {
            env: options.env ?? process.env,
            detached: options.detached ?? false,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          const record = error as Error & { code?: string; cause?: unknown };
          resolve({
            code: null,
            signal: null,
            stdout: '',
            stderr: '',
            timedOut: false,
            overflowed: false,
            errorCode: record.code ?? null,
            errorStack: record.stack ?? '',
            errorCause: record.cause === undefined ? '' : String(record.cause),
          });
          return;
        }
        const pgid =
          options.detached && child.pid !== undefined ? child.pid : undefined;
        trackChild(child, pgid === undefined ? {} : { pgid });
        const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
        let outputBytes = 0;
        let timedOut = false;
        let overflowed = false;
        let terminationStarted = false;
        let spawnError: Error | undefined;
        const terminate = (): void => {
          if (terminationStarted) return;
          terminationStarted = true;
          killExact(child, pgid);
        };
        const collect = (target: keyof typeof chunks, chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > 65_536) {
            overflowed = true;
            terminate();
            return;
          }
          chunks[target].push(chunk);
        };
        child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
        child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
        child.on('error', (error) => {
          spawnError = error;
        });
        const timer = setTimeout(() => {
          timedOut = true;
          terminate();
        }, options.timeoutMs);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          const record = spawnError as
            | (Error & { code?: string; cause?: unknown })
            | undefined;
          resolve({
            code,
            signal,
            stdout: Buffer.concat(chunks.stdout).toString('utf8'),
            stderr: Buffer.concat(chunks.stderr).toString('utf8'),
            timedOut,
            overflowed,
            errorCode: record?.code ?? null,
            errorStack: record?.stack ?? '',
            errorCause: record?.cause === undefined ? '' : String(record.cause),
          });
        });
      });
    },
    reap,
  };
  context.after(reap);
  return registry;
}
