import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  type GuardianMessage,
  isGuardianMessage,
} from './guardian-protocol.ts';
import { checkRuntimeSupport, type JobRecord } from './job-store.ts';
import { openStoreClient, type StoreClient } from './store-client.ts';
import {
  decideLaunchAtTestBoundary,
  internalSeams,
  recordRunnerEvent,
  recordRunnerPid,
  utilityPaths,
  waitAtSeam,
} from './test-seams.ts';

function destroyReadStream(
  stream: NodeJS.ReadableStream | null | undefined,
): void {
  if (
    stream !== null &&
    stream !== undefined &&
    'destroy' in stream &&
    typeof stream.destroy === 'function'
  )
    stream.destroy();
}

interface Args {
  db: string;
  root: string;
  owner: string;
  job: string;
}
function args(): Args {
  const result = { db: '', root: '', owner: '', job: '' };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, '') as keyof Args;
    if (key in result) result[key] = process.argv[i + 1] ?? '';
  }
  return result;
}
function tokenFromStdin(timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (token: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      resolve(token);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      bytes += buffer.length;
      if (bytes > 4_096) {
        process.stdin.destroy();
        finish(Buffer.concat(chunks).toString('utf8').slice(0, 4_096));
      }
    };
    const onEnd = (): void =>
      finish(Buffer.concat(chunks).toString('utf8').slice(0, 4_096));
    const onError = (): void => finish('');
    const timer = setTimeout(() => {
      process.stdin.destroy();
      finish('');
    }, timeoutMs);
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}
async function run(): Promise<void> {
  checkRuntimeSupport();
  const parsed = args();
  if (!parsed.db || !parsed.root || !parsed.owner || !parsed.job) return;
  const runnerToken = await tokenFromStdin();
  if (!runnerToken) return;
  const seams = internalSeams();
  recordRunnerPid(seams.runnerLog, process.pid);
  const store = await openStoreClient(parsed.db, { trustedRoot: parsed.root });
  const claimId = randomUUID();
  let guardian: ChildProcess | undefined;
  let record: JobRecord;
  let revision: number | null = null;
  let grantSent = false;
  let grantAttempted = false;
  let launched = false;
  let shellCode: number | null = null;
  let shellSignal: string | null = null;
  let term: 'returned' | 'error' | null = null;
  let killIntent = false;
  let deadlineObserved = false;
  let stopping = false;
  let settled = false;
  let budget: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let readinessTimer: NodeJS.Timeout | undefined;
  let stdout: NodeJS.ReadableStream | null = null;
  let stderr: NodeJS.ReadableStream | null = null;
  let topologySucceeded = false;
  let closed = false;
  const streams = { available: false, incomplete: true } as const;
  const SPAWN_FAILED_EVIDENCE = {
    launch: 'spawn_failed' as const,
    cleanupState: 'not_required' as const,
    stdout: { available: false as const },
    stderr: { available: false as const },
    finalized: true as const,
  };

  let publication = Promise.resolve();
  const publish = (
    input: Parameters<StoreClient['publishResult']>[4],
    final: boolean,
  ): Promise<void> => {
    const task = publication.then(async () => {
      if ((settled && !final) || closed) return;
      if (seams.publishDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, seams.publishDelayMs),
        );
      }
      if ((settled && !final) || closed) return;
      try {
        const result = await store.publishResult(
          parsed.owner,
          parsed.job,
          claimId,
          revision,
          input,
          runnerToken,
        );
        revision = result.revision;
        if (final) settled = true;
      } catch {
        /* a lost writer cannot invent evidence */
      }
    });
    publication = task.catch(() => undefined);
    return task;
  };
  const latchStopping = (): boolean => {
    if (stopping || settled || closed) return false;
    stopping = true;
    return true;
  };
  const finalize = async (): Promise<void> => {
    if (!latchStopping()) return;
    const input: Parameters<StoreClient['publishResult']>[4] = {
      ...(grantSent && !launched ? { launch: 'unknown' as const } : {}),
      shellCode,
      shellSignal,
      cleanupState: launched ? 'unconfirmed' : 'not_requested',
      cleanupTermObservation: term,
      cleanupKillIntentObserved: killIntent,
      deadlineTriggerObserved: deadlineObserved,
      stdout: streams,
      stderr: streams,
      finalized: true,
    };
    await publish(input, true);
  };
  const beginBudget = (): void => {
    if (budget !== undefined || stopping) return;
    budget = setTimeout(() => {
      void finalize().finally(() => void close());
    }, 7_000);
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    stopping = true;
    closed = true;
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (readinessTimer !== undefined) clearTimeout(readinessTimer);
    if (budget !== undefined) clearTimeout(budget);
    destroyReadStream(stdout);
    destroyReadStream(stderr);
    if (guardian !== undefined) {
      try {
        guardian.disconnect();
      } catch {
        /* already disconnected */
      }
      guardian.unref();
    }
    await store.close();
  };
  const abandon = async (): Promise<void> => {
    stopping = true;
    await close();
  };
  const publishSpawnFailure = async (): Promise<void> => {
    if (!latchStopping()) return;
    await publish(
      {
        ...SPAWN_FAILED_EVIDENCE,
        deadlineTriggerObserved: deadlineObserved,
      },
      true,
    );
    await close();
  };
  try {
    await store.claimRunner(parsed.owner, parsed.job, claimId, runnerToken);
    record = await store.getJob(parsed.owner, parsed.job);
    const utilities = utilityPaths();
    if (!existsSync(utilities.sh) || !existsSync(utilities.ps)) {
      await publishSpawnFailure();
      return;
    }
    const guardianEntry =
      seams.guardianPath ?? new URL('./guardian.js', import.meta.url).pathname;
    const guardianEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('PI_WATCH_'),
      ),
    );
    // Internal fixture-only controls are explicitly allowlisted at this boundary;
    // all other pi-watch variables remain excluded from guardian and shell env.
    if (seams.guardianMode !== undefined)
      guardianEnv.PI_WATCH_TEST_GUARDIAN_MODE = seams.guardianMode;
    if (seams.guardianLog !== undefined)
      guardianEnv.PI_WATCH_TEST_GUARDIAN_LOG = seams.guardianLog;
    guardian = spawn(process.execPath, [guardianEntry, '--job', parsed.job], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
      env: guardianEnv,
    });
    guardian.unref();
    // SAFETY: slots 4 and 5 are the two Readable pipes requested in spawn stdio.
    const streamsForDrain =
      guardian.stdio as unknown as Array<NodeJS.ReadableStream | null>;
    stdout = streamsForDrain[4] ?? null;
    stderr = streamsForDrain[5] ?? null;
    stdout?.on('data', () => undefined);
    stderr?.on('data', () => undefined);
    let ready = false;
    let topology = false;
    readinessTimer = setTimeout(() => {
      if (topologySucceeded || stopping) return;
      void publishSpawnFailure();
    }, 3_000);
    guardian.on('message', (raw: unknown) => {
      if (stopping || !isGuardianMessage(raw)) return;
      const message = raw as GuardianMessage;
      if (message.type === 'hello') {
        guardian?.send({
          type: 'hello_reply',
          runnerPid: process.pid,
          command: record.command,
          cwd: record.cwd,
          deadlineAtMs: record.deadlineAtMs,
          psPath: utilities.ps,
          shPath: utilities.sh,
        });
      } else if (message.type === 'topology') {
        topology = message.ok;
        if (!topology) {
          void publishSpawnFailure();
        } else {
          topologySucceeded = true;
          ready = true;
          void decide();
        }
      } else if (message.type === 'shell_spawned') {
        launched = true;
        void publish(
          {
            launch: 'launched',
            cleanupState: 'not_requested',
            stdout: streams,
            stderr: streams,
            finalized: false,
          },
          false,
        );
      } else if (message.type === 'shell_error') {
        if (message.reason === 'expired_before_spawn') deadlineObserved = true;
        void publishSpawnFailure();
      } else if (message.type === 'shell_exit') {
        // A shell outcome without the shell-spawn receipt is ambiguous by
        // contract (the guardian fixture can intentionally withhold it).
        if (launched) {
          shellCode = message.code;
          shellSignal = message.signal;
        }
        beginBudget();
      } else if (message.type === 'cleanup_term') term = message.observation;
      else if (message.type === 'cleanup_kill_intent') killIntent = true;
      else if (message.type === 'deadline') {
        deadlineObserved = true;
        beginBudget();
      }
    });
    const decide = async (): Promise<void> => {
      if (!ready || !topology || grantSent || stopping) return;
      waitAtSeam(seams.pauseBeforeDecide);
      if (stopping) return;
      let decision: Awaited<ReturnType<StoreClient['decideLaunch']>>;
      try {
        decision = await decideLaunchAtTestBoundary(seams.decisionFailure, () =>
          store.decideLaunch(parsed.owner, parsed.job, claimId, runnerToken),
        );
      } catch {
        recordRunnerEvent(
          seams.runnerLog,
          `decision_error_caught_${seams.decisionFailure ?? 'store'}`,
        );
        await abandon();
        return;
      }
      if (stopping) return;
      if (decision.disposition === 'suppressed_now') {
        stopping = true;
        settled = true;
        await close();
        return;
      }
      if (decision.disposition !== 'authorized_now') {
        await abandon();
        return;
      }
      waitAtSeam(
        seams.pauseAfterAuthorized || seams.pauseAfterAuthorizedMs > 0,
        seams.pauseAfterAuthorizedMs || undefined,
      );
      if (stopping || !guardian?.connected || grantSent) return;
      grantAttempted = true;
      grantSent = true;
      if (seams.disconnectBeforeGrantSend) guardian.disconnect();
      try {
        guardian.send({ type: 'grant' }, (error) => {
          if (error === null || error === undefined || stopping) return;
          recordRunnerEvent(seams.runnerLog, 'grant_send_callback_error');
          void finalize().finally(() => void close());
        });
      } catch {
        void finalize().finally(() => void close());
      }
    };
    deadlineTimer = setTimeout(
      () => {
        if (stopping) return;
        beginBudget();
      },
      Math.max(0, record.deadlineAtMs - Date.now()),
    );
    const handleGuardianLoss = (): void => {
      if (stopping) return;
      if (!topologySucceeded) {
        void publishSpawnFailure();
      } else if (grantAttempted) {
        beginBudget();
        void finalize().finally(() => void close());
      } else {
        void abandon();
      }
    };
    guardian.once('disconnect', () => {
      if (!seams.disconnectBeforeGrantSend) handleGuardianLoss();
    });
    guardian.once('error', handleGuardianLoss);
    guardian.once('exit', () => {
      if (stopping) return;
      if (!topologySucceeded) {
        void publishSpawnFailure();
        return;
      }
      if (!grantSent) {
        void abandon();
        return;
      }
      void finalize().finally(() => void close());
    });
  } catch {
    await close();
  }
}
void run().catch(() => undefined);
