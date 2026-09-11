import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRuntimeSupport, type ReservationResult } from './job-store.ts';
import type { StoreClient } from './store-client.ts';

export interface LaunchRunnerOptions {
  dbPath: string;
  trustedRoot: string;
  runnerEntry?: string;
  executable?: string;
}

export class LaunchError extends Error {
  readonly code = 'LAUNCH_FAILED' as const;

  constructor() {
    super('Runner launch preflight failed.');
    this.name = 'LaunchError';
  }
}

export type LaunchReceipt =
  | { status: 'spawned' }
  | { status: 'error'; code: 'LAUNCH_FAILED' };

function defaultRunnerEntry(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../dist/runner.js');
}

export function preflightLauncher(options: LaunchRunnerOptions): void {
  checkRuntimeSupport();
  if (
    typeof options.dbPath !== 'string' ||
    typeof options.trustedRoot !== 'string' ||
    !existsSync(options.runnerEntry ?? defaultRunnerEntry())
  ) {
    throw new LaunchError();
  }
}

/** Start the detached runner; this function has no shell or guardian knowledge. */
export async function launchRunner(
  _store: StoreClient,
  reservation: ReservationResult,
  options: LaunchRunnerOptions,
): Promise<LaunchReceipt> {
  preflightLauncher(options);
  if (!reservation.created || reservation.runnerToken === null) {
    throw new LaunchError();
  }
  const entry = options.runnerEntry ?? defaultRunnerEntry();
  const executable = options.executable ?? process.execPath;
  return new Promise<LaunchReceipt>((resolveReceipt) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(
        executable,
        [
          entry,
          '--db',
          options.dbPath,
          '--root',
          options.trustedRoot,
          '--owner',
          reservation.job.ownerUuid,
          '--job',
          reservation.job.jobId,
        ],
        {
          detached: true,
          stdio: ['pipe', 'ignore', 'ignore'],
          env: { ...process.env },
        },
      );
    } catch {
      resolveReceipt({ status: 'error', code: 'LAUNCH_FAILED' });
      return;
    }
    const finish = (receipt: LaunchReceipt): void => {
      if (settled) return;
      settled = true;
      child.unref();
      resolveReceipt(receipt);
    };
    child.stdin?.on('error', () => undefined);
    child.once('spawn', () => {
      try {
        child.stdin?.end(reservation.runnerToken);
      } catch {
        /* the runner will remain an ambiguous startup */
      }
      finish({ status: 'spawned' });
    });
    child.once('error', () =>
      finish({ status: 'error', code: 'LAUNCH_FAILED' }),
    );
  });
}
