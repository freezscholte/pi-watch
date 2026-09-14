import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  type GuardianMessage,
  isGuardianMessage,
} from './guardian-protocol.ts';
import { checkRuntimeSupport, type JobRecord } from './job-store.ts';
import {
  type CaptureResult,
  createOutputCapture,
  type OutputCapture,
} from './output-capture.ts';
import { prepareCaptureWorkspace } from './private-path.ts';
import { openStoreClient, type StoreClient } from './store-client.ts';
import type { StreamCaptureFacts } from './store-evidence.ts';
import {
  decideLaunchAtTestBoundary,
  internalSeams,
  recordRunnerEvent,
  recordRunnerPid,
  utilityPaths,
  waitAtSeam,
} from './test-seams.ts';

const CAPTURE_CUTOVER_MS = 1_000;

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

interface AttachedCapture {
  capture: OutputCapture | undefined;
  stream: NodeJS.ReadableStream | null;
  ended: boolean;
  failed: boolean;
  onData: (chunk: Buffer | string) => void;
  onEnd: () => void;
  onError: () => void;
}

type CoordinatorState =
  | 'observing'
  | 'cutting_over'
  | 'freezing'
  | 'publishing'
  | 'closed';

const UNAVAILABLE_COMPLETE: StreamCaptureFacts = {
  available: false,
  truncated: false,
  incomplete: false,
  openAtCutover: false,
};

function resultFacts(result: CaptureResult): StreamCaptureFacts {
  return {
    available: result.available,
    truncated: result.truncated,
    incomplete: result.incomplete,
    openAtCutover: result.openAtCutover,
  };
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
  let cutoverTimer: NodeJS.Timeout | undefined;
  let cutoverDeadline: number | undefined;
  let freezeDelayApplied = false;
  let stdout: NodeJS.ReadableStream | null = null;
  let stderr: NodeJS.ReadableStream | null = null;
  let stdoutCapture: AttachedCapture | undefined;
  let stderrCapture: AttachedCapture | undefined;
  let captureSetupFailed = false;
  let topologySucceeded = false;
  let closed = false;
  let coordinator: CoordinatorState = 'observing';

  let publication = Promise.resolve();
  const publish = (
    input: Parameters<StoreClient['publishResult']>[4],
    final: boolean,
  ): Promise<void> => {
    const task = publication.then(async () => {
      if ((settled && !final) || closed) return;
      if (seams.publishDelayMs > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, seams.publishDelayMs),
        );
      if ((settled && !final) || closed) return;
      try {
        if (!final && seams.publicationFailure === 'launch_before')
          throw new Error('injected launch publication failure');
        if (final && seams.publicationFailure === 'terminal')
          throw new Error('injected terminal publication failure');
        const result = await store.publishResult(
          parsed.owner,
          parsed.job,
          claimId,
          revision,
          input,
          runnerToken,
        );
        if (!final && seams.publicationFailure === 'launch_after')
          throw new Error('injected launch acknowledgement loss');
        revision = result.revision;
        if (final) settled = true;
      } catch {
        // A committed launch whose acknowledgement was lost is observed, not
        // republished, so the queued terminal write can retain exact ordering.
        if (!final) {
          try {
            const observed = await store.observeJob(parsed.owner, parsed.job);
            if (
              !observed.finalized &&
              input.launch !== undefined &&
              observed.evidence.launch === input.launch
            )
              revision = observed.latestRevision;
          } catch {
            // Unknown storage state cannot authorize a publication retry.
          }
        }
      }
    });
    publication = task.catch(() => undefined);
    return task;
  };

  const detachCapture = (attached: AttachedCapture | undefined): void => {
    if (attached === undefined) return;
    attached.stream?.off('data', attached.onData);
    attached.stream?.off('end', attached.onEnd);
    attached.stream?.off('error', attached.onError);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    stopping = true;
    closed = true;
    coordinator = 'closed';
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (readinessTimer !== undefined) clearTimeout(readinessTimer);
    if (budget !== undefined) clearTimeout(budget);
    if (cutoverTimer !== undefined) clearTimeout(cutoverTimer);
    detachCapture(stdoutCapture);
    detachCapture(stderrCapture);
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

  const latchStopping = (): boolean => {
    if (stopping || settled || closed) return false;
    stopping = true;
    return true;
  };

  const discardCaptureStaging = async (): Promise<void> => {
    detachCapture(stdoutCapture);
    detachCapture(stderrCapture);
    destroyReadStream(stdout);
    destroyReadStream(stderr);
    await Promise.all([
      stdoutCapture?.capture?.invalidateEmptyStaging(),
      stderrCapture?.capture?.invalidateEmptyStaging(),
    ]);
  };

  const publishSpawnFailure = async (): Promise<void> => {
    if (!latchStopping()) return;
    await discardCaptureStaging();
    await publish(
      {
        launch: 'spawn_failed',
        cleanupState: 'not_required',
        stdout: UNAVAILABLE_COMPLETE,
        stderr: UNAVAILABLE_COMPLETE,
        deadlineTriggerObserved: deadlineObserved,
        finalized: true,
      },
      true,
    );
    await close();
  };

  const attach = (
    stream: NodeJS.ReadableStream | null,
    capture: OutputCapture | undefined,
  ): AttachedCapture => {
    const attached: AttachedCapture = {
      capture,
      stream,
      ended: false,
      failed: false,
      onData: (chunk) => {
        if (
          coordinator === 'freezing' ||
          coordinator === 'publishing' ||
          closed
        )
          return;
        capture?.accept(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      },
      onEnd: () => {
        if (
          coordinator === 'freezing' ||
          coordinator === 'publishing' ||
          closed
        )
          return;
        attached.ended = true;
        void capture?.seal({ source: 'eof' });
      },
      onError: () => {
        if (
          coordinator === 'freezing' ||
          coordinator === 'publishing' ||
          closed
        )
          return;
        attached.failed = true;
        // A read error is capture loss, not EOF. Keep draining any later
        // observations; real end or lifecycle freeze owns the seal reason.
        capture?.sourceError();
      },
    };
    stream?.on('data', attached.onData);
    stream?.once('end', attached.onEnd);
    stream?.on('error', attached.onError);
    stream?.resume();
    return attached;
  };

  const prepareCapture = (): void => {
    let stdoutOutput: OutputCapture | undefined;
    let stderrOutput: OutputCapture | undefined;
    try {
      const workspace = prepareCaptureWorkspace(store.fixedLayout, parsed.job);
      stdoutOutput = createOutputCapture(workspace, 'stdout');
      stderrOutput = createOutputCapture(workspace, 'stderr');
    } catch {
      captureSetupFailed = true;
    }
    stdoutCapture = attach(stdout, stdoutOutput);
    stderrCapture = attach(stderr, stderrOutput);
    const selected =
      seams.streamError === 'stdout'
        ? stdout
        : seams.streamError === 'stderr'
          ? stderr
          : null;
    if (selected !== null)
      setImmediate(() => {
        if (!stopping && !closed)
          selected.emit(
            'error',
            new Error(
              seams.streamErrorDetail ?? 'Synthetic stream read error.',
            ),
          );
      });
  };

  const unavailableCutoverFacts = (
    attached: AttachedCapture | undefined,
  ): StreamCaptureFacts => ({
    available: false,
    truncated: false,
    incomplete: true,
    openAtCutover: attached?.ended !== true,
  });

  const freezeCapture = async (
    attached: AttachedCapture | undefined,
  ): Promise<StreamCaptureFacts> => {
    if (attached?.capture === undefined)
      return unavailableCutoverFacts(attached);
    if (attached.failed) attached.capture.sourceError();
    return resultFacts(await attached.capture.seal({ source: 'cutover' }));
  };

  const freezeAndPublish = async (): Promise<void> => {
    if (coordinator !== 'cutting_over' || cutoverDeadline === undefined) return;
    const remaining = cutoverDeadline - performance.now();
    if (remaining > 0) {
      cutoverTimer = setTimeout(() => void freezeAndPublish(), remaining);
      return;
    }
    if (!freezeDelayApplied && seams.freezeDelayMs > 0) {
      freezeDelayApplied = true;
      recordRunnerEvent(seams.runnerLog, 'capture_freeze_seam');
      cutoverTimer = setTimeout(
        () => void freezeAndPublish(),
        seams.freezeDelayMs,
      );
      return;
    }
    coordinator = 'freezing';
    stopping = true;
    recordRunnerEvent(seams.runnerLog, `capture_freezing ${performance.now()}`);
    detachCapture(stdoutCapture);
    detachCapture(stderrCapture);
    destroyReadStream(stdout);
    destroyReadStream(stderr);
    if (seams.raceCoordinator) {
      stdoutCapture?.onData(Buffer.from('late'));
      stdoutCapture?.onError();
      stdoutCapture?.onEnd();
      stderrCapture?.onData(Buffer.from('late'));
      stderrCapture?.onError();
      stderrCapture?.onEnd();
      recordRunnerEvent(seams.runnerLog, 'post_freeze_callbacks_probed');
    }
    const [stdoutFacts, stderrFacts] = await Promise.all([
      freezeCapture(stdoutCapture),
      freezeCapture(stderrCapture),
    ]);
    recordRunnerEvent(seams.runnerLog, 'capture_seal_complete');
    recordRunnerEvent(seams.runnerLog, 'capture_frozen_snapshot');
    coordinator = 'publishing';
    const terminalEvidence: Parameters<StoreClient['publishResult']>[4] = {
      launch: launched ? 'launched' : 'unknown',
      shellCode,
      shellSignal,
      cleanupState:
        launched || deadlineObserved || term !== null || killIntent
          ? 'unconfirmed'
          : 'not_requested',
      cleanupTermObservation: term,
      cleanupKillIntentObserved: killIntent,
      deadlineTriggerObserved: deadlineObserved,
      stdout: captureSetupFailed
        ? unavailableCutoverFacts(stdoutCapture)
        : stdoutFacts,
      stderr: captureSetupFailed
        ? unavailableCutoverFacts(stderrCapture)
        : stderrFacts,
      finalized: true,
    };
    try {
      recordRunnerEvent(seams.runnerLog, 'terminal_publish_attempt');
      await publish(terminalEvidence, true);
    } finally {
      await close();
      recordRunnerEvent(seams.runnerLog, 'runner_closed');
    }
  };

  const beginCutover = (): void => {
    if (coordinator !== 'observing' || stopping || closed) return;
    coordinator = 'cutting_over';
    cutoverDeadline = performance.now() + CAPTURE_CUTOVER_MS;
    recordRunnerEvent(
      seams.runnerLog,
      `capture_cutover_started ${cutoverDeadline - CAPTURE_CUTOVER_MS}`,
    );
    cutoverTimer = setTimeout(
      () => void freezeAndPublish(),
      CAPTURE_CUTOVER_MS,
    );
    if (seams.raceCoordinator) {
      setImmediate(beginCutover);
      setImmediate(beginCutover);
    }
  };

  const beginBudget = (): void => {
    if (budget !== undefined || stopping || coordinator !== 'observing') return;
    budget = setTimeout(beginCutover, 7_000);
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
    if (seams.guardianMode !== undefined) {
      guardianEnv.PI_WATCH_TEST_GUARDIAN_MODE = seams.guardianMode;
      if (seams.guardianMode === 'withhold-all-and-hold')
        guardianEnv.PI_WATCH_INTERNAL_TEST_SEAMS = '1';
    }
    if (seams.guardianLog !== undefined)
      guardianEnv.PI_WATCH_TEST_GUARDIAN_LOG = seams.guardianLog;
    guardian = spawn(process.execPath, [guardianEntry, '--job', parsed.job], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
      env: guardianEnv,
    });
    guardian.unref();
    // SAFETY: slots 4 and 5 are the two Readable pipes requested in spawn stdio.
    const streams =
      guardian.stdio as unknown as Array<NodeJS.ReadableStream | null>;
    stdout = streams[4] ?? null;
    stderr = streams[5] ?? null;
    let ready = false;
    let topology = false;
    readinessTimer = setTimeout(() => {
      if (topologySucceeded || stopping) return;
      void publishSpawnFailure();
    }, 3_000);

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
      prepareCapture();
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
          beginCutover();
        });
      } catch {
        beginCutover();
      }
    };

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
        if (!topology) void publishSpawnFailure();
        else {
          topologySucceeded = true;
          ready = true;
          void decide();
        }
      } else if (message.type === 'shell_spawned') {
        launched = true;
        recordRunnerEvent(seams.runnerLog, `shell_pid ${message.pid}`);
        void publish(
          {
            launch: 'launched',
            cleanupState: 'not_requested',
            finalized: false,
          },
          false,
        );
      } else if (message.type === 'shell_error') {
        if (message.reason === 'expired_before_spawn') deadlineObserved = true;
        void publishSpawnFailure();
      } else if (message.type === 'shell_exit') {
        // A shell outcome without the shell-spawn receipt remains unknown.
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

    deadlineTimer = setTimeout(
      () => {
        if (!stopping) beginBudget();
      },
      Math.max(0, record.deadlineAtMs - Date.now()),
    );
    const handleGuardianLoss = (): void => {
      if (stopping) return;
      if (!topologySucceeded) void publishSpawnFailure();
      else if (grantAttempted) beginCutover();
      else void abandon();
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
      beginCutover();
    });
  } catch {
    await close();
  }
}
void run().catch(() => undefined);
