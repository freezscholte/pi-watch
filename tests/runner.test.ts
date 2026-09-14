import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRuntimeSupport } from '../src/job-store.ts';
import { launchRunner } from '../src/launch.ts';
import { OUTPUT_CAPTURE_LIMIT } from '../src/output-capture.ts';
import { openStoreClient } from '../src/store-client.ts';
import { utilityPaths } from '../src/test-seams.ts';
import {
  type OwnedProcessRegistry,
  useOwnedProcessRegistry,
} from './fixtures/owned-process-registry.ts';

const owner = '11111111-2222-4333-8444-555555555555';
const runtimeSupported = (() => {
  try {
    checkRuntimeSupport();
    return true;
  } catch {
    return false;
  }
})();
const runtimeSkip = runtimeSupported
  ? false
  : 'requires Node 26 with linked SQLite >= 3.51.3';
const commandChild = join(process.cwd(), 'tests/fixtures/command-child.ts');
const unsupportedNode = process.env.PI_WATCH_UNSUPPORTED_NODE;
const rootDir = () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-watch-runner-'));
  mkdirSync(join(root, 'cwd'));
  return root;
};
const waitFor = async (fn: () => Promise<boolean>, timeout = 20_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('timed out waiting for durable lifecycle result');
};
function command(args: string[]): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(commandChild)} -- ${args.map((arg) => JSON.stringify(arg)).join(' ')}`;
}
function firstDifference(actual: Uint8Array, expected: Uint8Array): number {
  const shared = Math.min(actual.byteLength, expected.byteLength);
  for (let index = 0; index < shared; index += 1)
    if (actual[index] !== expected[index]) return index;
  return actual.byteLength === expected.byteLength ? -1 : shared;
}
function assertCapturedBytes(
  actual: Uint8Array,
  expected: Uint8Array | string,
): void {
  const wanted =
    typeof expected === 'string' ? Buffer.from(expected) : expected;
  const expectedDigest = createHash('sha256').update(wanted).digest('hex');
  assert.deepEqual(
    {
      bytes: actual.byteLength,
      digest: createHash('sha256').update(actual).digest('hex'),
      firstDifference: firstDifference(actual, wanted),
    },
    {
      bytes: wanted.byteLength,
      digest: expectedDigest,
      firstDifference: -1,
    },
  );
}
async function registerLoggedRunner(
  registry: OwnedProcessRegistry,
  log: string,
): Promise<number> {
  const runnerPid = await waitForLoggedPid(log, 'runner');
  registry.recordPid(runnerPid);
  registry.recordGroup(runnerPid);
  return runnerPid;
}
async function registerLoggedGuardian(
  registry: OwnedProcessRegistry,
  log: string,
): Promise<number> {
  const guardianPid = await waitForLoggedPid(log, 'guardian');
  registry.recordPid(guardianPid);
  registry.recordGroup(guardianPid);
  return guardianPid;
}
async function registerLoggedActors(
  registry: OwnedProcessRegistry,
  log: string,
): Promise<{ runnerPid: number; guardianPid: number }> {
  const runnerPid = await registerLoggedRunner(registry, log);
  const guardianPid = await registerLoggedGuardian(registry, log);
  return { runnerPid, guardianPid };
}
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitForGone(pid: number, timeout = 10_000): Promise<void> {
  await waitFor(async () => !processExists(pid), timeout);
}
async function waitForLoggedPid(
  log: string,
  actor: 'runner' | 'guardian',
  timeout = 10_000,
): Promise<number> {
  let pid: number | undefined;
  await waitFor(async () => {
    if (!existsSync(log)) return false;
    const match = readFileSync(log, 'utf8').match(
      new RegExp(`(?:^|\\n)${actor}_pid (\\d+)(?: |\\n|$)`),
    );
    if (match?.[1] === undefined) return false;
    pid = Number(match[1]);
    return Number.isInteger(pid) && pid > 1;
  }, timeout);
  assert.ok(pid !== undefined);
  return pid;
}
function assertSingleEscalation(log: string): void {
  const events = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(' '));
  const terms = events.filter(([name]) => name?.startsWith('term_'));
  const kills = events.filter(([name]) => name === 'kill_intent');
  assert.equal(terms.length, 1);
  assert.equal(kills.length, 1);
  const term = Number(terms[0]?.[1]);
  const kill = Number(kills[0]?.[1]);
  assert.ok(Number.isFinite(term) && Number.isFinite(kill));
  assert.ok(kill - term >= 5_000);
}
function processArgs(pid: number): string {
  return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
    encoding: 'utf8',
  }).trim();
}
async function setEnvLaunch(
  values: Record<string, string | undefined>,
  launch: () => Promise<void>,
): Promise<void> {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await launch();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
async function launchTracked(
  registry: OwnedProcessRegistry,
  job: Awaited<ReturnType<typeof createJob>>,
  env: Record<string, string | undefined> = {},
  guardianExpected = true,
) {
  const log =
    env.PI_WATCH_TEST_RUNNER_LOG ??
    join(job.root, `owned-actors-${crypto.randomUUID()}.log`);
  let receipt: Awaited<ReturnType<typeof launchRunner>> | undefined;
  await setEnvLaunch(
    {
      ...env,
      PI_WATCH_TEST_RUNNER_LOG: log,
      PI_WATCH_TEST_GUARDIAN_LOG: env.PI_WATCH_TEST_GUARDIAN_LOG ?? log,
    },
    async () => {
      receipt = await launchRunner(job.client, job.reservation, {
        dbPath: job.db,
        trustedRoot: job.root,
      });
    },
  );
  if (guardianExpected) await registerLoggedActors(registry, log);
  else await registerLoggedRunner(registry, log);
  assert.ok(receipt !== undefined);
  return receipt;
}

async function createJob(
  commandText: string,
  options: { cwd?: string; deadlineMs?: number } = {},
) {
  const root = rootDir();
  const db = join(root, 'state', 'jobs.sqlite');
  const client = await openStoreClient(db, { trustedRoot: root });
  const reservation = await client.reserve({
    ownerUuid: owner,
    sessionPath: join(root, 'session.jsonl'),
    namespace: 'tool_call',
    requestKey: crypto.randomUUID(),
    command: commandText,
    cwd: options.cwd ?? join(root, 'cwd'),
    deadlineMs: options.deadlineMs ?? 20_000,
  });
  return { root, db, client, reservation };
}

test('store client retains one canonical fixed-layout capability', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async () => {
  const container = mkdtempSync(join(tmpdir(), 'pi-watch-layout-client-'));
  const root = join(container, 'real');
  const alias = join(container, 'alias');
  mkdirSync(root, { mode: 0o700 });
  symlinkSync(root, alias, 'dir');
  const db = join(alias, 'state', 'jobs.sqlite');
  const client = await openStoreClient(db, { trustedRoot: alias });
  try {
    const reservation = await client.reserve({
      ownerUuid: owner,
      sessionPath: join(root, 'session.jsonl'),
      namespace: 'tool_call',
      requestKey: crypto.randomUUID(),
      command: 'exit 0',
      cwd: root,
    });
    const capability = client.fixedLayout;
    assert.equal(client.fixedLayout, capability);
    assert.equal(
      capability.databasePath,
      join(realpathSync(root), 'state', 'jobs.sqlite'),
    );
    assert.equal(
      capability.workspacePath(reservation.job.jobId),
      join(realpathSync(root), 'state', 'jobs', reservation.job.jobId),
    );
  } finally {
    await client.close();
    rmSync(container, { recursive: true, force: true });
  }
});

test('capture emits only launch and terminal revisions', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const job = await createJob(`printf out; printf err >&2`);
  const { root, client, reservation } = job;
  try {
    assert.equal(reservation.created, true);
    const started = await launchTracked(registry, job);
    assert.equal(started.status, 'spawned');
    await waitFor(
      async () =>
        (await client.observeJob(owner, reservation.job.jobId)).finalized,
    );
    const observation = await client.observeJob(owner, reservation.job.jobId);
    assert.equal(observation.evidence.launch, 'launched');
    assert.equal(observation.evidence.shellCode, 0);
    assert.deepEqual(observation.evidence.stdout, {
      available: true,
      truncated: false,
      incomplete: false,
      openAtCutover: false,
    });
    assert.deepEqual(observation.evidence.stderr, {
      available: true,
      truncated: false,
      incomplete: false,
      openAtCutover: false,
    });
    const workspace = join(root, 'state', 'jobs', reservation.job.jobId);
    assertCapturedBytes(readFileSync(join(workspace, 'stdout.raw')), 'out');
    assertCapturedBytes(readFileSync(join(workspace, 'stderr.raw')), 'err');
    assert.equal(
      (await client.listResults(owner, reservation.job.jobId)).length,
      2,
    );
    assert.equal(
      (await client.listNotices(owner, reservation.job.jobId)).length,
      2,
    );
  } finally {
    await registry.reap();
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean EOF closes capture without finalizing lifecycle', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const job = await createJob('printf done');
  try {
    await launchTracked(registry, job);
    const workspace = join(
      job.root,
      'state',
      'jobs',
      job.reservation.job.jobId,
    );
    await waitFor(
      async () =>
        existsSync(join(workspace, 'stdout.closed.json')) &&
        existsSync(join(workspace, 'stderr.closed.json')),
    );
    const stdoutReceipt = JSON.parse(
      readFileSync(join(workspace, 'stdout.closed.json'), 'utf8'),
    );
    const stderrReceipt = JSON.parse(
      readFileSync(join(workspace, 'stderr.closed.json'), 'utf8'),
    );
    assert.equal(stdoutReceipt.retainedBytes, 4);
    assert.equal(stdoutReceipt.reason, 'eof');
    assert.equal(stderrReceipt.retainedBytes, 0);
    assert.equal(stderrReceipt.reason, 'eof');
    const beforeCutover = await job.client.observeJob(
      owner,
      job.reservation.job.jobId,
    );
    assert.equal(beforeCutover.finalized, false);
    assert.equal(beforeCutover.evidence.cleanupState, 'not_requested');
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('capture retains both exact capped prefixes and drains overflow before one side effect', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const sideEffect = join(
    tmpdir(),
    `pi-watch-output-side-effect-${crypto.randomUUID()}`,
  );
  const job = await createJob(
    command([
      '--stdout-bytes',
      String(OUTPUT_CAPTURE_LIMIT + 17),
      '--stderr-bytes',
      String(OUTPUT_CAPTURE_LIMIT + 31),
      '--side-effect',
      sideEffect,
    ]),
  );
  try {
    await launchTracked(registry, job);
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      20_000,
    );
    const workspace = join(
      job.root,
      'state',
      'jobs',
      job.reservation.job.jobId,
    );
    const stdout = readFileSync(join(workspace, 'stdout.raw'));
    const stderr = readFileSync(join(workspace, 'stderr.raw'));
    const digest = (value: Buffer) =>
      createHash('sha256').update(value).digest('hex');
    assert.equal(stdout.length, OUTPUT_CAPTURE_LIMIT);
    assert.equal(stderr.length, OUTPUT_CAPTURE_LIMIT);
    assert.equal(
      digest(stdout),
      digest(Buffer.alloc(OUTPUT_CAPTURE_LIMIT, 'o')),
    );
    assert.equal(
      digest(stderr),
      digest(Buffer.alloc(OUTPUT_CAPTURE_LIMIT, 'e')),
    );
    assert.equal(readFileSync(sideEffect).byteLength, 1);
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    assert.equal(evidence.stdout.truncated, true);
    assert.equal(evidence.stderr.truncated, true);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(sideEffect, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('unsafe capture setup still grants exactly one command and publishes unavailable streams', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const sideEffect = join(
    tmpdir(),
    `pi-watch-unsafe-capture-${crypto.randomUUID()}`,
  );
  const job = await createJob(
    command(['--stdout-bytes', '13', '--side-effect', sideEffect]),
  );
  const jobsDirectory = join(job.root, 'state', 'jobs');
  const workspace = join(jobsDirectory, job.reservation.job.jobId);
  mkdirSync(jobsDirectory, { mode: 0o700 });
  chmodSync(jobsDirectory, 0o700);
  mkdirSync(workspace, { mode: 0o700 });
  chmodSync(workspace, 0o700);
  try {
    await launchTracked(registry, job);
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
    assert.equal(readFileSync(sideEffect).byteLength, 1);
    const results = await job.client.listResults(
      owner,
      job.reservation.job.jobId,
    );
    assert.equal(results.length, 2);
    assert.equal(results[0]?.evidence.launch, 'launched');
    assert.deepEqual(results[1]?.evidence.stdout, {
      available: false,
      truncated: false,
      incomplete: true,
      openAtCutover: false,
    });
    assert.deepEqual(results[1]?.evidence.stderr, results[1]?.evidence.stdout);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(sideEffect, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('replay does not launch a second command', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(tmpdir(), `pi-watch-marker-${crypto.randomUUID()}`);
  const { root, client, reservation } = await createJob(
    `printf x >> ${marker}`,
  );
  try {
    const replay = await client.reserve({
      ownerUuid: owner,
      sessionPath: join(root, 'session.jsonl'),
      namespace: 'tool_call',
      requestKey: reservation.job.requestKey,
      command: reservation.job.command,
      cwd: reservation.job.cwd,
      deadlineMs: 20_000,
    });
    assert.equal(replay.created, false);
    await launchTracked(registry, {
      root,
      db: join(root, 'state', 'jobs.sqlite'),
      client,
      reservation,
    });
    await waitFor(
      async () =>
        (await client.observeJob(owner, reservation.job.jobId)).finalized,
    );
    // Replay rejection happens before spawn because it has no runner token.
    await assert.rejects(() =>
      launchRunner(client, replay, {
        dbPath: join(root, 'state', 'jobs.sqlite'),
        trustedRoot: root,
      }),
    );
    assert.equal(readFileSync(marker).byteLength, 1);
  } finally {
    await registry.reap();
    await client.close();
    rmSync(marker, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('before-start cancellation suppresses command', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(tmpdir(), `pi-watch-marker-${crypto.randomUUID()}`);
  const { root, client, reservation } = await createJob(`touch ${marker}`);
  try {
    await client.requestCancellation(owner, reservation.job.jobId);
    await launchTracked(
      registry,
      {
        root,
        db: join(root, 'state', 'jobs.sqlite'),
        client,
        reservation,
      },
      {},
      false,
    );
    await waitFor(
      async () =>
        (await client.observeJob(owner, reservation.job.jobId)).finalized,
    );
    const result = await client.observeJob(owner, reservation.job.jobId);
    assert.equal(result.evidence.launch, 'suppressed_cancelled');
    assert.deepEqual(result.evidence.stdout, {
      available: false,
      truncated: false,
      incomplete: false,
      openAtCutover: false,
    });
    assert.deepEqual(result.evidence.stderr, result.evidence.stdout);
    assert.equal(
      existsSync(join(root, 'state', 'jobs', reservation.job.jobId)),
      false,
    );
    assert.equal(existsSync(marker), false);
  } finally {
    await registry.reap();
    await client.close();
    rmSync(marker, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('held command returns early and records root-exit escalation timing', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(tmpdir(), `pi-watch-release-${crypto.randomUUID()}`);
  const log = join(tmpdir(), `pi-watch-guardian-log-${crypto.randomUUID()}`);
  const job = await createJob(command(['--marker', marker]));
  try {
    const started = await launchTracked(registry, job, {
      PI_WATCH_TEST_RUNNER_LOG: log,
      PI_WATCH_TEST_GUARDIAN_LOG: log,
    });
    assert.equal(started.status, 'spawned');
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId)).evidence
          .launch === 'launched',
    );
    assert.equal(
      (await job.client.observeJob(owner, job.reservation.job.jobId)).finalized,
      false,
    );
    writeFileSync(marker, 'release');
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
    const result = await job.client.observeJob(
      owner,
      job.reservation.job.jobId,
    );
    assert.equal(result.evidence.shellCode, 0);
    assertSingleEscalation(log);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(log, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('distinct exit, signal, and missing-cwd outcomes are evidenced', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async (context) => {
  const cases: Array<{
    command: string;
    cwd?: string;
    launch: string;
    code?: number;
    signal?: string;
  }> = [
    { command: 'exit 3', launch: 'launched', code: 3 },
    { command: 'kill -TERM $$', launch: 'launched', signal: 'SIGTERM' },
    {
      command: 'exit 0',
      cwd: join(tmpdir(), `pi-watch-missing-${crypto.randomUUID()}`),
      launch: 'spawn_failed',
    },
  ];
  for (const item of cases) {
    const registry = useOwnedProcessRegistry(context);
    const job = await createJob(
      item.command,
      item.cwd === undefined ? {} : { cwd: item.cwd },
    );
    try {
      await launchTracked(registry, job);
      await waitFor(
        async () =>
          (await job.client.observeJob(owner, job.reservation.job.jobId))
            .finalized,
        15_000,
      );
      const evidence = (
        await job.client.observeJob(owner, job.reservation.job.jobId)
      ).evidence;
      assert.equal(evidence.launch, item.launch);
      if (item.code !== undefined) assert.equal(evidence.shellCode, item.code);
      if (item.signal !== undefined)
        assert.equal(evidence.shellSignal, item.signal);
      if (item.launch === 'spawn_failed') {
        assert.equal(evidence.shellCode, null);
        assert.deepEqual(evidence.stdout, {
          available: false,
          truncated: false,
          incomplete: false,
          openAtCutover: false,
        });
        assert.deepEqual(evidence.stderr, evidence.stdout);
        const workspace = join(
          job.root,
          'state',
          'jobs',
          job.reservation.job.jobId,
        );
        assert.equal(existsSync(join(workspace, 'stdout.raw')), false);
        assert.equal(existsSync(join(workspace, 'stderr.raw')), false);
        assert.equal(existsSync(join(workspace, 'stdout.closed.json')), false);
        assert.equal(existsSync(join(workspace, 'stderr.closed.json')), false);
      }
    } finally {
      await registry.reap();
      await job.client.close();
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('expired deadline suppresses and cancellation wins the same boundary', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  for (const both of [false, true]) {
    const registry = useOwnedProcessRegistry(context);
    const marker = join(tmpdir(), `pi-watch-deadline-${crypto.randomUUID()}`);
    const job = await createJob(`touch ${marker}`, { deadlineMs: 1 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (both)
        await job.client.requestCancellation(owner, job.reservation.job.jobId);
      await launchTracked(registry, job, {}, false);
      await waitFor(
        async () =>
          (await job.client.observeJob(owner, job.reservation.job.jobId))
            .finalized,
      );
      const evidence = (
        await job.client.observeJob(owner, job.reservation.job.jobId)
      ).evidence;
      assert.equal(
        evidence.launch,
        both ? 'suppressed_cancelled' : 'suppressed_deadline',
      );
      assert.equal(existsSync(marker), false);
    } finally {
      await registry.reap();
      await job.client.close();
      rmSync(marker, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('wrapper can exit while detached job completes, and killed wrapper does not relaunch', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const root = rootDir();
  const db = join(root, 'state', 'jobs.sqlite');
  const controller = join(process.cwd(), 'tests/fixtures/launch-controller.ts');
  const naturalActorLog = join(root, 'wrapper-natural-actors.log');
  const args = [
    controller,
    '--db',
    db,
    '--root',
    root,
    '--command',
    'exit 0',
    '--key',
    'wrapper-natural',
  ];
  const natural = await registry.run(process.execPath, args, {
    timeoutMs: 10_000,
    env: {
      ...process.env,
      PI_WATCH_TEST_RUNNER_LOG: naturalActorLog,
      PI_WATCH_TEST_GUARDIAN_LOG: naturalActorLog,
    },
  });
  await registerLoggedActors(registry, naturalActorLog);
  assert.equal(natural.timedOut, false);
  assert.equal(natural.code, 0, natural.stderr);
  const report = JSON.parse(natural.stdout.trim());
  const client = await openStoreClient(db, { trustedRoot: root });
  let killedRunnerPid: number | undefined;
  try {
    await waitFor(
      async () => (await client.observeJob(owner, report.jobId)).finalized,
    );
    const marker = join(root, 'wrapper-append-marker');
    const runnerLog = join(root, 'wrapper-runner.log');
    const killedCommand = `printf x >> ${marker}`;
    const killed = spawn(
      process.execPath,
      [
        controller,
        '--db',
        db,
        '--root',
        root,
        '--command',
        killedCommand,
        '--key',
        'wrapper-killed',
      ],
      {
        env: {
          ...process.env,
          PI_WATCH_TEST_RUNNER_LOG: runnerLog,
          PI_WATCH_TEST_GUARDIAN_LOG: runnerLog,
          PI_WATCH_TEST_PAUSE_CONTROLLER_AFTER_LAUNCH: '1',
        },
      },
    );
    registry.trackChild(killed);
    const killedActors = await registerLoggedActors(registry, runnerLog);
    killedRunnerPid = killedActors.runnerPid;
    const killedExit = new Promise<void>((resolve) => {
      if (killed.exitCode !== null || killed.signalCode !== null) resolve();
      else killed.once('exit', () => resolve());
    });
    assert.ok(killed.pid !== undefined);
    registry.signalPid(killed.pid, 'SIGKILL');
    await killedExit;
    const replay = await client.reserve({
      ownerUuid: owner,
      sessionPath: join(root, 'session.jsonl'),
      namespace: 'tool_call',
      requestKey: 'wrapper-killed',
      command: killedCommand,
      cwd: root,
      deadlineMs: 30_000,
    });
    assert.equal(replay.created, false);
    await waitFor(
      async () =>
        (await client.observeJob(owner, replay.job.jobId)).evidence.launch ===
        'launched',
      15_000,
    );
    await waitFor(
      async () => (await client.observeJob(owner, replay.job.jobId)).finalized,
      15_000,
    );
    assert.equal(readFileSync(marker).byteLength, 1);
    assert.ok(killedRunnerPid !== undefined);
  } finally {
    await registry.reap();
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('nonexistent runner entry is typed and cannot respawn a reservation', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async () => {
  const job = await createJob('exit 0');
  try {
    // Both calls fail existence preflight before launchRunner can spawn.
    await assert.rejects(
      () =>
        launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
          runnerEntry: join(job.root, 'missing-runner.js'),
        }),
      (error: unknown) => (error as { code?: string }).code === 'LAUNCH_FAILED',
    );
    const before = await job.client.observeJob(
      owner,
      job.reservation.job.jobId,
    );
    assert.equal(before.evidence.launch, 'unknown');
    await assert.rejects(
      () =>
        launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
          runnerEntry: join(job.root, 'missing-runner.js'),
        }),
      (error: unknown) => (error as { code?: string }).code === 'LAUNCH_FAILED',
    );
  } finally {
    await job.client.close();
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('decision failure and committed response loss grant nothing', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  for (const mode of ['before', 'after'] as const) {
    const registry = useOwnedProcessRegistry(context);
    const marker = join(tmpdir(), `pi-watch-decision-${crypto.randomUUID()}`);
    const runnerLog = join(
      tmpdir(),
      `pi-watch-decision-runner-${crypto.randomUUID()}`,
    );
    const job = await createJob(`touch ${marker}`);
    let runnerPid: number | undefined;
    try {
      await setEnvLaunch(
        {
          PI_WATCH_TEST_DECISION_FAILURE: mode,
          PI_WATCH_TEST_RUNNER_LOG: runnerLog,
        },
        async () => {
          await launchRunner(job.client, job.reservation, {
            dbPath: job.db,
            trustedRoot: job.root,
          });
        },
      );
      runnerPid = await registerLoggedRunner(registry, runnerLog);
      await waitFor(
        async () =>
          existsSync(runnerLog) &&
          readFileSync(runnerLog, 'utf8').includes(
            `decision_error_caught_${mode}`,
          ),
      );
      await waitForGone(runnerPid);
      const observation = await job.client.observeJob(
        owner,
        job.reservation.job.jobId,
      );
      assert.equal(existsSync(marker), false);
      assert.equal(observation.evidence.launch, 'unknown');
      assert.equal(observation.finalized, false);
      assert.equal(
        observation.control.launchDecision,
        mode === 'after' ? 'authorized' : null,
      );
    } finally {
      await registry.reap();
      await job.client.close();
      rmSync(marker, { force: true });
      rmSync(runnerLog, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('runner killed before or after live decision never grants shell', {
  timeout: 40_000,
  skip: runtimeSkip,
}, async (context) => {
  for (const pause of [
    'PI_WATCH_TEST_PAUSE_BEFORE_DECIDE',
    'PI_WATCH_TEST_PAUSE_AFTER_AUTHORIZED',
  ]) {
    const registry = useOwnedProcessRegistry(context);
    const marker = join(tmpdir(), `pi-watch-pause-${crypto.randomUUID()}`);
    const runnerLog = join(
      tmpdir(),
      `pi-watch-runner-pid-${crypto.randomUUID()}`,
    );
    const job = await createJob(`touch ${marker}`);
    let runnerPid: number | undefined;
    try {
      await setEnvLaunch(
        { [pause]: '1', PI_WATCH_TEST_RUNNER_LOG: runnerLog },
        async () => {
          await launchRunner(job.client, job.reservation, {
            dbPath: job.db,
            trustedRoot: job.root,
          });
        },
      );
      runnerPid = await registerLoggedRunner(registry, runnerLog);
      if (pause === 'PI_WATCH_TEST_PAUSE_AFTER_AUTHORIZED') {
        await waitFor(
          async () =>
            (await job.client.observeJob(owner, job.reservation.job.jobId))
              .control.launchDecision === 'authorized',
        );
      }
      registry.signalGroup(runnerPid, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const observation = await job.client.observeJob(
        owner,
        job.reservation.job.jobId,
      );
      assert.equal(existsSync(marker), false);
      assert.equal(observation.evidence.launch, 'unknown');
      if (pause === 'PI_WATCH_TEST_PAUSE_BEFORE_DECIDE')
        assert.equal(observation.control.launchDecision, null);
    } finally {
      await registry.reap();
      await job.client.close();
      rmSync(marker, { force: true });
      rmSync(runnerLog, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

function hardProbeFixture(root: string, pidLog: string): string {
  const path = join(root, 'ps-ignore-term.sh');
  const fifo = join(root, 'ps-hold.fifo');
  writeFileSync(
    path,
    `#!/bin/sh
trap '' TERM
mkfifo ${JSON.stringify(fifo)}
exec 3<>${JSON.stringify(fifo)}
rm -f ${JSON.stringify(fifo)}
printf '%s\\n' "$$" > ${JSON.stringify(pidLog)}
read line <&3
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function utilityFixture(
  root: string,
  mode: 'garbage' | 'hang' | 'large',
): string {
  const path = join(root, `ps-${mode}.sh`);
  const body =
    mode === 'garbage'
      ? 'printf "garbage\\n"'
      : mode === 'large'
        ? 'printf "%8192s" x'
        : 'sleep 3';
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

test('topology garbage, timeout, and oversized ps output fail closed', {
  timeout: 40_000,
  skip: runtimeSkip,
}, async (context) => {
  for (const mode of ['garbage', 'hang', 'large'] as const) {
    const registry = useOwnedProcessRegistry(context);
    const job = await createJob('exit 0');
    try {
      const ps = utilityFixture(job.root, mode);
      await launchTracked(registry, job, { PI_WATCH_TEST_PS_PATH: ps });
      await waitFor(
        async () =>
          (await job.client.observeJob(owner, job.reservation.job.jobId))
            .finalized,
        12_000,
      );
      assert.equal(
        (await job.client.observeJob(owner, job.reservation.job.jobId)).evidence
          .launch,
        'spawn_failed',
      );
    } finally {
      await registry.reap();
      await job.client.close();
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('TERM-ignoring topology probe cannot retain guardian or runner', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const actorLog = join(tmpdir(), `pi-watch-hard-probe-${crypto.randomUUID()}`);
  const probeLog = join(
    tmpdir(),
    `pi-watch-hard-probe-pids-${crypto.randomUUID()}`,
  );
  const job = await createJob('exit 0');
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
  let probePid: number | undefined;
  try {
    const ps = hardProbeFixture(job.root, probeLog);
    await setEnvLaunch(
      {
        PI_WATCH_TEST_PS_PATH: ps,
        PI_WATCH_TEST_RUNNER_LOG: actorLog,
        PI_WATCH_TEST_GUARDIAN_LOG: actorLog,
      },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    ({ runnerPid, guardianPid } = await registerLoggedActors(
      registry,
      actorLog,
    ));
    await waitFor(async () => existsSync(probeLog));
    probePid = Number(readFileSync(probeLog, 'utf8').trim());
    assert.ok(Number.isInteger(probePid) && probePid > 1);
    registry.recordPid(probePid);
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      8_000,
    );
    assert.equal(
      (await job.client.observeJob(owner, job.reservation.job.jobId)).evidence
        .launch,
      'spawn_failed',
    );
    await waitForGone(probePid, 5_000);
    await waitForGone(guardianPid, 5_000);
    await waitForGone(runnerPid, 5_000);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(probeLog, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('SIGTERM during topology probe stops guardian, probe, and runner', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const actorLog = join(
    tmpdir(),
    `pi-watch-signaled-probe-${crypto.randomUUID()}`,
  );
  const probeLog = join(
    tmpdir(),
    `pi-watch-signaled-probe-pid-${crypto.randomUUID()}`,
  );
  const job = await createJob('exit 0');
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
  let probePid: number | undefined;
  try {
    const ps = hardProbeFixture(job.root, probeLog);
    await setEnvLaunch(
      {
        PI_WATCH_TEST_PS_PATH: ps,
        PI_WATCH_TEST_RUNNER_LOG: actorLog,
        PI_WATCH_TEST_GUARDIAN_LOG: actorLog,
      },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    ({ runnerPid, guardianPid } = await registerLoggedActors(
      registry,
      actorLog,
    ));
    await waitFor(async () => existsSync(probeLog));
    probePid = Number(readFileSync(probeLog, 'utf8').trim());
    assert.ok(Number.isInteger(probePid) && probePid > 1);
    registry.recordPid(probePid);

    registry.signalPid(guardianPid, 'SIGTERM');

    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      8_000,
    );
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    assert.equal(evidence.launch, 'spawn_failed');
    await waitForGone(guardianPid, 5_000);
    await waitForGone(probePid, 5_000);
    await waitForGone(runnerPid, 5_000);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(probeLog, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('missing sh and ps fail before guardian spawn', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  for (const key of ['PI_WATCH_TEST_SH_PATH', 'PI_WATCH_TEST_PS_PATH']) {
    const registry = useOwnedProcessRegistry(context);
    const job = await createJob('exit 0');
    const guardianLog = join(
      tmpdir(),
      `pi-watch-missing-utility-${crypto.randomUUID()}`,
    );
    const runnerLog = join(job.root, 'missing-utility-runner.log');
    try {
      await launchTracked(
        registry,
        job,
        {
          [key]: join(job.root, 'does-not-exist'),
          PI_WATCH_TEST_RUNNER_LOG: runnerLog,
          PI_WATCH_TEST_GUARDIAN_LOG: guardianLog,
        },
        false,
      );
      await waitFor(
        async () =>
          (await job.client.observeJob(owner, job.reservation.job.jobId))
            .finalized,
      );
      assert.equal(
        (await job.client.observeJob(owner, job.reservation.job.jobId)).evidence
          .launch,
        'spawn_failed',
      );
      assert.equal(existsSync(guardianLog), false);
    } finally {
      await registry.reap();
      await job.client.close();
      rmSync(guardianLog, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('runner loss lets guardian escalate while store remains launched and open', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(tmpdir(), `pi-watch-never-${crypto.randomUUID()}`);
  const log = join(tmpdir(), `pi-watch-guardian-loss-${crypto.randomUUID()}`);
  const job = await createJob(
    command(['--marker', marker, '--ignore-term', '--spawn-holder']),
  );
  let runnerPid: number | undefined;
  try {
    await setEnvLaunch(
      {
        PI_WATCH_TEST_GUARDIAN_LOG: log,
        PI_WATCH_TEST_GUARDIAN_MODE: 'delay-disconnect',
        PI_WATCH_TEST_RUNNER_LOG: log,
      },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId)).evidence
          .launch === 'launched',
    );
    ({ runnerPid } = await registerLoggedActors(registry, log));
    registry.signalGroup(runnerPid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      existsSync(log) && readFileSync(log, 'utf8').includes('kill_intent'),
      false,
    );
    await waitFor(async () => existsSync(log), 10_000);
    await waitFor(
      async () => readFileSync(log, 'utf8').includes('kill_intent'),
      15_000,
    );
    const observation = await job.client.observeJob(
      owner,
      job.reservation.job.jobId,
    );
    assert.equal(observation.evidence.launch, 'launched');
    assert.equal(observation.finalized, false);
    assertSingleEscalation(log);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(log, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('withheld spawn receipt finalizes honestly as unknown', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const log = join(tmpdir(), `pi-watch-withheld-${crypto.randomUUID()}.log`);
  const sideEffect = join(
    tmpdir(),
    `pi-watch-withheld-effect-${crypto.randomUUID()}`,
  );
  const job = await createJob(command(['--side-effect', sideEffect]));
  let runnerPid: number | undefined;
  try {
    await launchTracked(registry, job, {
      PI_WATCH_TEST_GUARDIAN_MODE: 'withhold-spawn',
      PI_WATCH_TEST_RUNNER_LOG: log,
      PI_WATCH_TEST_GUARDIAN_LOG: log,
    });
    runnerPid = await waitForLoggedPid(log, 'runner');
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
    await waitForGone(runnerPid, 5_000);
    const observation = await job.client.observeJob(
      owner,
      job.reservation.job.jobId,
    );
    const results = await job.client.listResults(
      owner,
      job.reservation.job.jobId,
    );
    const notices = await job.client.listNotices(
      owner,
      job.reservation.job.jobId,
    );
    assert.equal(readFileSync(sideEffect).byteLength, 1);
    assert.equal(results.length, 1);
    assert.equal(notices.length, 1);
    assert.equal(observation.latestRevision, results[0]?.revision);
    assert.equal(observation.evidence.launch, 'unknown');
    assert.equal(observation.evidence.shellCode, null);
    assert.equal(observation.evidence.shellSignal, null);
    assert.equal(observation.evidence.cleanupState, 'unconfirmed');
    assert.equal(observation.evidence.cleanupTermObservation, 'returned');
    assert.equal(observation.evidence.cleanupKillIntentObserved, true);
    assertSingleEscalation(log);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(log, { force: true });
    rmSync(sideEffect, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('grant arriving after the guardian deadline fails before shell spawn', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(
    tmpdir(),
    `pi-watch-expired-before-spawn-${crypto.randomUUID()}`,
  );
  const actorLog = join(
    tmpdir(),
    `pi-watch-expired-before-spawn-actors-${crypto.randomUUID()}`,
  );
  const job = await createJob(`printf x >> ${marker}`, { deadlineMs: 3_000 });
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
  try {
    await setEnvLaunch(
      {
        PI_WATCH_TEST_PAUSE_AFTER_AUTHORIZED_MS: '3500',
        PI_WATCH_TEST_RUNNER_LOG: actorLog,
        PI_WATCH_TEST_GUARDIAN_LOG: actorLog,
      },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    ({ runnerPid, guardianPid } = await registerLoggedActors(
      registry,
      actorLog,
    ));
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      10_000,
    );
    const observation = await job.client.observeJob(
      owner,
      job.reservation.job.jobId,
    );
    assert.equal(observation.control.launchDecision, 'authorized');
    assert.equal(observation.evidence.launch, 'spawn_failed');
    assert.equal(observation.evidence.deadlineTriggerObserved, true);
    assert.equal(observation.evidence.shellCode, null);
    assert.equal(existsSync(marker), false);
    await waitForGone(guardianPid, 5_000);
    await waitForGone(runnerPid, 5_000);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('guardian deadline records trigger and unconfirmed cleanup', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(
    tmpdir(),
    `pi-watch-deadline-hold-${crypto.randomUUID()}`,
  );
  const actorLog = join(
    tmpdir(),
    `pi-watch-deadline-actors-${crypto.randomUUID()}`,
  );
  const job = await createJob(command(['--marker', marker, '--ignore-term']), {
    deadlineMs: 2_000,
  });
  try {
    await launchTracked(registry, job, {
      PI_WATCH_TEST_RUNNER_LOG: actorLog,
      PI_WATCH_TEST_GUARDIAN_LOG: actorLog,
    });
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    assert.equal(evidence.launch, 'launched');
    assert.equal(evidence.deadlineTriggerObserved, true);
    assert.equal(evidence.cleanupState, 'unconfirmed');
    assert.match(readFileSync(actorLog, 'utf8'), /^deadline_trigger /m);
    assertSingleEscalation(actorLog);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('root exit before deadline does not fabricate deadline trigger evidence', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const actorLog = join(
    tmpdir(),
    `pi-watch-predeadline-exit-${crypto.randomUUID()}`,
  );
  const job = await createJob('sleep 1; exit 0', { deadlineMs: 2_000 });
  const startedAt = Date.now();
  try {
    await launchTracked(registry, job, {
      PI_WATCH_TEST_RUNNER_LOG: actorLog,
      PI_WATCH_TEST_GUARDIAN_LOG: actorLog,
    });
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    assert.ok(Date.now() - startedAt >= 2_000);
    assert.equal(evidence.launch, 'launched');
    assert.equal(evidence.shellCode, 0);
    assert.equal(evidence.deadlineTriggerObserved, false);
    assert.doesNotMatch(readFileSync(actorLog, 'utf8'), /^deadline_trigger /m);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('withheld guardian deadline receipt is not inferred from runner clock', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(
    tmpdir(),
    `pi-watch-withheld-deadline-${crypto.randomUUID()}`,
  );
  const actorLog = join(
    tmpdir(),
    `pi-watch-withheld-deadline-actors-${crypto.randomUUID()}`,
  );
  const job = await createJob(command(['--marker', marker, '--ignore-term']), {
    deadlineMs: 2_000,
  });
  try {
    await launchTracked(registry, job, {
      PI_WATCH_TEST_GUARDIAN_MODE: 'withhold-deadline',
      PI_WATCH_TEST_RUNNER_LOG: actorLog,
      PI_WATCH_TEST_GUARDIAN_LOG: actorLog,
    });
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    assert.match(readFileSync(actorLog, 'utf8'), /^deadline_trigger /m);
    assert.equal(evidence.launch, 'launched');
    assert.equal(evidence.deadlineTriggerObserved, false);
    assert.equal(evidence.cleanupState, 'unconfirmed');
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('guardian loss cuts over after one second with live writers', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const log = join(tmpdir(), `pi-watch-guardian-pid-${crypto.randomUUID()}`);
  const holderPids = join(
    tmpdir(),
    `pi-watch-holder-pid-${crypto.randomUUID()}`,
  );
  const heartbeat = join(
    tmpdir(),
    `pi-watch-holder-heartbeat-${crypto.randomUUID()}`,
  );
  const holderReady = join(
    tmpdir(),
    `pi-watch-holder-ready-${crypto.randomUUID()}`,
  );
  const job = await createJob(
    command([
      '--spawn-holder',
      '--hold-ms',
      '4000',
      '--heartbeat-file',
      heartbeat,
      '--heartbeat-ms',
      '2500',
      '--holder-pid-file',
      holderPids,
      '--holder-ready-file',
      holderReady,
    ]),
  );
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
  let holderPid: number | undefined;
  try {
    await setEnvLaunch(
      {
        PI_WATCH_TEST_GUARDIAN_LOG: log,
        PI_WATCH_TEST_RUNNER_LOG: log,
      },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    ({ runnerPid, guardianPid } = await registerLoggedActors(registry, log));
    await waitFor(async () => existsSync(holderPids));
    holderPid = Number(readFileSync(holderPids, 'utf8').trim());
    assert.ok(Number.isInteger(holderPid) && holderPid > 1);
    registry.recordPid(holderPid);
    await waitFor(
      async () => readFileSync(log, 'utf8').includes('shell_exit_receipt'),
      10_000,
    );
    assert.equal(readFileSync(holderReady).byteLength, 1);
    const cutoverStartedAt = performance.now();
    registry.signalPid(guardianPid, 'SIGKILL');
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      5_000,
    );
    assert.ok(performance.now() - cutoverStartedAt >= 1_000);
    assert.equal(existsSync(heartbeat), false);
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    assert.equal(evidence.shellCode, 0);
    assert.equal(evidence.cleanupState, 'unconfirmed');
    assert.equal(evidence.stdout.openAtCutover, true);
    assert.equal(evidence.stderr.openAtCutover, true);
    assert.equal(evidence.stdout.incomplete, true);
    assert.equal(evidence.stderr.incomplete, true);
    await waitForGone(runnerPid);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(log, { force: true });
    rmSync(holderPids, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(holderReady, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('runner budget finalizes when guardian withholds exit receipts', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const job = await createJob('exit 0', { deadlineMs: 2_000 });
  try {
    await launchTracked(registry, job, {
      PI_WATCH_TEST_GUARDIAN_MODE: 'withhold-exit',
    });
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    assert.equal(evidence.launch, 'launched');
    assert.equal(evidence.shellCode, null);
    assert.equal(evidence.finalized, true);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('cleanup budget starts one full cutover without guardian evidence and stream error waits for freeze', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const log = join(tmpdir(), `pi-watch-budget-cutover-${crypto.randomUUID()}`);
  const holderPids = join(
    tmpdir(),
    `pi-watch-budget-holder-${crypto.randomUUID()}`,
  );
  const heartbeat = join(
    tmpdir(),
    `pi-watch-budget-heartbeat-${crypto.randomUUID()}`,
  );
  const job = await createJob(
    command([
      '--spawn-holder',
      '--hold-ms',
      '12000',
      '--heartbeat-file',
      heartbeat,
      '--heartbeat-ms',
      '10500',
      '--holder-pid-file',
      holderPids,
    ]),
    { deadlineMs: 1_000 },
  );
  try {
    await setEnvLaunch(
      {
        PI_WATCH_INTERNAL_TEST_SEAMS: '1',
        PI_WATCH_TEST_STREAM_ERROR: 'stdout',
        PI_WATCH_TEST_GUARDIAN_MODE: 'withhold-all-and-hold',
        PI_WATCH_TEST_RUNNER_LOG: log,
        PI_WATCH_TEST_GUARDIAN_LOG: log,
      },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    const actors = await registerLoggedActors(registry, log);
    await waitFor(async () => existsSync(holderPids));
    const holderPid = Number(readFileSync(holderPids, 'utf8').trim());
    registry.recordPid(holderPid);
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
    const events = readFileSync(log, 'utf8').trim().split('\n');
    const starts = events.filter((line) =>
      line.startsWith('capture_cutover_started '),
    );
    const freezes = events.filter((line) =>
      line.startsWith('capture_freezing '),
    );
    assert.equal(starts.length, 1);
    assert.equal(freezes.length, 1);
    const startedAt = Number(starts[0]?.split(' ')[1]);
    const frozenAt = Number(freezes[0]?.split(' ')[1]);
    assert.ok(frozenAt - startedAt >= 1_000);
    const cutoverIndex = events.findIndex((line) =>
      line.startsWith('capture_cutover_started '),
    );
    const freezeIndex = events.findIndex((line) =>
      line.startsWith('capture_freezing '),
    );
    const terminalPublishIndex = events.indexOf('terminal_publish_attempt');
    assert.equal(
      events.filter((line) => line === 'terminal_publish_attempt').length,
      1,
    );
    assert.ok(cutoverIndex < freezeIndex);
    assert.ok(freezeIndex < terminalPublishIndex);
    assert.equal(
      events.some((line) => line.startsWith('shell_exit_receipt ')),
      false,
    );
    assert.equal(
      events.some((line) => line.startsWith('deadline_trigger ')),
      false,
    );
    assert.equal(
      events
        .slice(0, terminalPublishIndex + 1)
        .some((line) => line.startsWith('term_')),
      false,
    );
    assert.equal(existsSync(heartbeat), false);
    assert.equal(processExists(actors.guardianPid), true);
    const observation = await job.client.observeJob(
      owner,
      job.reservation.job.jobId,
    );
    assert.equal(observation.evidence.shellCode, null);
    assert.equal(observation.evidence.cleanupTermObservation, null);
    assert.equal(observation.evidence.cleanupKillIntentObserved, false);
    assert.equal(observation.evidence.deadlineTriggerObserved, false);
    assert.equal(observation.evidence.stdout.incomplete, true);
    assert.equal(observation.evidence.stdout.openAtCutover, true);
    const workspace = join(
      job.root,
      'state',
      'jobs',
      job.reservation.job.jobId,
    );
    const receipt = JSON.parse(
      readFileSync(join(workspace, 'stdout.closed.json'), 'utf8'),
    );
    assert.equal(receipt.reason, 'capture_error');
    assert.equal(receipt.incomplete, true);
    assert.equal(receipt.openAtCutover, true);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(log, { force: true });
    rmSync(holderPids, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('terminal coordinator fences duplicate trigger and freeze callback races', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const log = join(tmpdir(), `pi-watch-freeze-race-${crypto.randomUUID()}`);
  const holderPids = join(
    tmpdir(),
    `pi-watch-freeze-holder-${crypto.randomUUID()}`,
  );
  const sideEffect = join(
    tmpdir(),
    `pi-watch-freeze-effect-${crypto.randomUUID()}`,
  );
  const job = await createJob(
    command([
      '--ignore-term',
      '--spawn-holder',
      '--hold-ms',
      '1200',
      '--holder-pid-file',
      holderPids,
      '--side-effect',
      sideEffect,
    ]),
  );
  try {
    await setEnvLaunch(
      {
        PI_WATCH_INTERNAL_TEST_SEAMS: '1',
        PI_WATCH_TEST_GUARDIAN_MODE: 'disconnect-and-hold',
        PI_WATCH_TEST_STREAM_ERROR: 'stdout',
        PI_WATCH_TEST_FREEZE_DELAY_MS: '500',
        PI_WATCH_TEST_RACE_COORDINATOR: '1',
        PI_WATCH_TEST_PUBLICATION_FAILURE: 'launch_after',
        PI_WATCH_TEST_RUNNER_LOG: log,
        PI_WATCH_TEST_GUARDIAN_LOG: log,
      },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    await registerLoggedActors(registry, log);
    await waitFor(async () => existsSync(holderPids));
    registry.recordPid(Number(readFileSync(holderPids, 'utf8').trim()));
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      8_000,
    );
    const events = readFileSync(log, 'utf8').trim().split('\n');
    for (const name of [
      'capture_freeze_seam',
      'capture_seal_complete',
      'capture_frozen_snapshot',
      'post_freeze_callbacks_probed',
      'terminal_publish_attempt',
      'runner_closed',
    ])
      assert.equal(events.filter((line) => line === name).length, 1);
    assert.equal(
      events.filter((line) => line.startsWith('capture_cutover_started '))
        .length,
      1,
    );
    assert.equal(
      events.filter((line) => line.startsWith('capture_freezing ')).length,
      1,
    );
    const results = await job.client.listResults(
      owner,
      job.reservation.job.jobId,
    );
    const notices = await job.client.listNotices(
      owner,
      job.reservation.job.jobId,
    );
    assert.equal(results.length, 2);
    assert.equal(notices.length, 2);
    assert.equal(results[1]?.evidence.stdout.incomplete, true);
    assert.equal(results[1]?.evidence.stdout.openAtCutover, false);
    assert.equal(results[1]?.evidence.stderr.available, true);
    assert.equal(results[1]?.evidence.stderr.incomplete, false);
    assert.equal(results[1]?.evidence.stderr.openAtCutover, false);
    assert.equal(readFileSync(sideEffect).byteLength, 1);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(log, { force: true });
    rmSync(holderPids, { force: true });
    rmSync(sideEffect, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('lost launch acknowledgement still orders one terminal publication and terminal failure exits', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async (context) => {
  for (const failure of [
    'launch_before',
    'launch_after',
    'terminal',
  ] as const) {
    const registry = useOwnedProcessRegistry(context);
    const log = join(
      tmpdir(),
      `pi-watch-publication-${failure}-${crypto.randomUUID()}`,
    );
    const sideEffect = join(
      tmpdir(),
      `pi-watch-publication-effect-${failure}-${crypto.randomUUID()}`,
    );
    const job = await createJob(
      command(['--stdout-text', 'durable', '--side-effect', sideEffect]),
    );
    let runnerPid: number | undefined;
    try {
      await launchTracked(registry, job, {
        PI_WATCH_INTERNAL_TEST_SEAMS: '1',
        PI_WATCH_TEST_PUBLICATION_FAILURE: failure,
        PI_WATCH_TEST_RUNNER_LOG: log,
        PI_WATCH_TEST_GUARDIAN_LOG: log,
      });
      runnerPid = await waitForLoggedPid(log, 'runner');
      await waitForGone(runnerPid, 15_000);
      const results = await job.client.listResults(
        owner,
        job.reservation.job.jobId,
      );
      const notices = await job.client.listNotices(
        owner,
        job.reservation.job.jobId,
      );
      const workspace = join(
        job.root,
        'state',
        'jobs',
        job.reservation.job.jobId,
      );
      assert.equal(readFileSync(sideEffect).byteLength, 1);
      assertCapturedBytes(
        readFileSync(join(workspace, 'stdout.raw')),
        'durable',
      );
      assert.equal(
        JSON.parse(readFileSync(join(workspace, 'stdout.closed.json'), 'utf8'))
          .retainedBytes,
        7,
      );
      if (failure === 'launch_before') {
        assert.equal(results.length, 1);
        assert.equal(notices.length, 1);
        assert.equal(results[0]?.evidence.finalized, true);
        assert.equal(results[0]?.evidence.launch, 'launched');
        assert.equal(results[0]?.evidence.shellCode, 0);
        assert.equal(results[0]?.evidence.shellSignal, null);
        assert.deepEqual(results[0]?.evidence.stdout, {
          available: true,
          truncated: false,
          incomplete: false,
          openAtCutover: false,
        });
        assert.deepEqual(results[0]?.evidence.stderr, {
          available: true,
          truncated: false,
          incomplete: false,
          openAtCutover: false,
        });
      } else if (failure === 'launch_after') {
        assert.equal(results.length, 2);
        assert.equal(notices.length, 2);
        assert.equal(results[1]?.evidence.finalized, true);
        assert.equal(results[1]?.evidence.launch, 'launched');
      } else {
        assert.equal(results.length, 1);
        assert.equal(notices.length, 1);
        assert.equal(results[0]?.evidence.finalized, false);
      }
    } finally {
      await registry.reap();
      await job.client.close();
      rmSync(log, { force: true });
      rmSync(sideEffect, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('runner capture durability stages stay independent and publish only after seal', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async (context) => {
  const stages = [
    'raw-write',
    'raw-sync',
    'raw-close',
    'marker-write',
    'marker-sync',
    'marker-close',
    'receipt-write',
    'receipt-sync',
    'receipt-close',
    'receipt-rename',
    'directory-sync',
    'final-identity',
  ] as const;
  for (const stage of stages) {
    const registry = useOwnedProcessRegistry(context);
    const log = join(
      tmpdir(),
      `pi-watch-stage-${stage}-${crypto.randomUUID()}`,
    );
    const sideEffect = join(
      tmpdir(),
      `pi-watch-stage-effect-${stage}-${crypto.randomUUID()}`,
    );
    const job = await createJob(
      command([
        '--ignore-term',
        '--stdout-bytes',
        String(OUTPUT_CAPTURE_LIMIT + 1),
        '--stderr-bytes',
        '17',
        '--side-effect',
        sideEffect,
      ]),
    );
    try {
      await launchTracked(registry, job, {
        PI_WATCH_INTERNAL_TEST_SEAMS: '1',
        PI_WATCH_TEST_CAPTURE_FAULT: `stdout:${stage}`,
        PI_WATCH_TEST_GUARDIAN_MODE: 'disconnect-after-exit',
        PI_WATCH_TEST_RUNNER_LOG: log,
        PI_WATCH_TEST_GUARDIAN_LOG: log,
      });
      await waitFor(
        async () =>
          existsSync(sideEffect) && readFileSync(sideEffect).byteLength === 1,
        8_000,
      );
      await waitFor(
        async () =>
          (await job.client.observeJob(owner, job.reservation.job.jobId))
            .finalized,
        8_000,
      );
      assert.equal(readFileSync(sideEffect).byteLength, 1);
      const results = await job.client.listResults(
        owner,
        job.reservation.job.jobId,
      );
      const notices = await job.client.listNotices(
        owner,
        job.reservation.job.jobId,
      );
      assert.equal(results.length, 2);
      assert.equal(notices.length, 2);
      const terminal = results[1]?.evidence;
      assert.equal(terminal?.shellCode, 0);
      assert.equal(terminal?.shellSignal, null);
      assert.equal(terminal?.stdout.incomplete, true);
      assert.equal(terminal?.stdout.available, stage === 'raw-write');
      assert.equal(terminal?.stderr.available, true);
      assert.equal(terminal?.stderr.incomplete, false);
      const events = readFileSync(log, 'utf8').trim().split('\n');
      assert.ok(
        events.indexOf('capture_seal_complete') <
          events.indexOf('terminal_publish_attempt'),
      );
      assert.equal(
        events.filter((line) => line === 'terminal_publish_attempt').length,
        1,
      );
    } finally {
      await registry.reap();
      await job.client.close();
      rmSync(log, { force: true });
      rmSync(sideEffect, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('missing guardian entry and readiness timeout publish spawn_failed', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const readinessFixture = join(
    tmpdir(),
    `pi-watch-readiness-${crypto.randomUUID()}.mjs`,
  );
  writeFileSync(
    readinessFixture,
    "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PI_WATCH_TEST_GUARDIAN_LOG, 'guardian_pid ' + process.pid + '\\n');\nsetInterval(() => undefined, 1000); process.on('disconnect', () => process.exit(0));\n",
  );
  for (const guardianPath of [
    join(tmpdir(), `pi-watch-missing-guardian-${crypto.randomUUID()}.js`),
    readinessFixture,
  ]) {
    const registry = useOwnedProcessRegistry(context);
    const actorLog = join(
      tmpdir(),
      `pi-watch-readiness-actors-${crypto.randomUUID()}`,
    );
    const job = await createJob('exit 0');
    let runnerPid: number | undefined;
    try {
      await setEnvLaunch(
        {
          PI_WATCH_TEST_GUARDIAN_PATH: guardianPath,
          PI_WATCH_TEST_RUNNER_LOG: actorLog,
          PI_WATCH_TEST_GUARDIAN_LOG: actorLog,
        },
        async () => {
          await launchRunner(job.client, job.reservation, {
            dbPath: job.db,
            trustedRoot: job.root,
          });
        },
      );
      runnerPid = await registerLoggedRunner(registry, actorLog);
      if (guardianPath === readinessFixture)
        await registerLoggedGuardian(registry, actorLog);
      await waitFor(
        async () =>
          (await job.client.observeJob(owner, job.reservation.job.jobId))
            .finalized,
        10_000,
      );
      const evidence = (
        await job.client.observeJob(owner, job.reservation.job.jobId)
      ).evidence;
      assert.equal(evidence.launch, 'spawn_failed');
      assert.equal(evidence.cleanupState, 'not_required');
      await waitForGone(runnerPid, 5_000);
    } finally {
      await registry.reap();
      await job.client.close();
      rmSync(actorLog, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
  rmSync(readinessFixture, { force: true });
});

test('readiness timeout latches before delayed publication and rejects late topology', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(
    tmpdir(),
    `pi-watch-late-topology-${crypto.randomUUID()}`,
  );
  const job = await createJob(`touch ${marker}`);
  try {
    await launchTracked(registry, job, {
      PI_WATCH_TEST_GUARDIAN_MODE: 'late-topology',
      PI_WATCH_TEST_PUBLISH_DELAY_MS: '1000',
    });
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      10_000,
    );
    const observation = await job.client.observeJob(
      owner,
      job.reservation.job.jobId,
    );
    assert.equal(observation.evidence.launch, 'spawn_failed');
    assert.equal(observation.evidence.cleanupState, 'not_required');
    assert.equal(observation.control.launchDecision, null);
    assert.equal(existsSync(marker), false);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('guardian disconnect starts runner budget even while guardian stays alive', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(
    tmpdir(),
    `pi-watch-disconnect-hold-${crypto.randomUUID()}`,
  );
  const actorLog = join(
    tmpdir(),
    `pi-watch-disconnect-hold-actors-${crypto.randomUUID()}`,
  );
  const job = await createJob(command(['--marker', marker, '--ignore-term']));
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
  try {
    await setEnvLaunch(
      {
        PI_WATCH_TEST_GUARDIAN_MODE: 'disconnect-and-hold',
        PI_WATCH_TEST_RUNNER_LOG: actorLog,
        PI_WATCH_TEST_GUARDIAN_LOG: actorLog,
      },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    ({ runnerPid, guardianPid } = await registerLoggedActors(
      registry,
      actorLog,
    ));
    await waitFor(
      async () =>
        existsSync(actorLog) &&
        readFileSync(actorLog, 'utf8').includes('spawn_receipt_sent'),
    );
    const disconnectedAt = Date.now();
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      5_000,
    );
    await waitForGone(runnerPid, 5_000);
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    assert.equal(evidence.launch, 'launched');
    assert.equal(evidence.cleanupState, 'unconfirmed');
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, disconnectedAt + 7_500 - Date.now())),
    );
    assert.equal(processExists(guardianPid), true);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(actorLog, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('post-grant guardian disconnect preserves phase-appropriate evidence', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const cases = [
    {
      mode: 'disconnect-before-shell',
      expectedLaunch: 'unknown',
      expectedCleanup: 'not_requested',
    },
    {
      mode: 'disconnect-after-spawn',
      expectedLaunch: 'launched',
      expectedCleanup: 'unconfirmed',
    },
  ] as const;
  for (const item of cases) {
    const registry = useOwnedProcessRegistry(context);
    const marker = join(
      tmpdir(),
      `pi-watch-guardian-disconnect-${crypto.randomUUID()}`,
    );
    const log = join(
      tmpdir(),
      `pi-watch-guardian-disconnect-log-${crypto.randomUUID()}`,
    );
    const commandText =
      item.mode === 'disconnect-before-shell'
        ? `touch ${marker}`
        : command(['--marker', marker]);
    const job = await createJob(commandText);
    try {
      await setEnvLaunch(
        {
          PI_WATCH_TEST_GUARDIAN_MODE: item.mode,
          PI_WATCH_TEST_RUNNER_LOG: log,
          PI_WATCH_TEST_GUARDIAN_LOG: log,
        },
        async () => {
          await launchRunner(job.client, job.reservation, {
            dbPath: job.db,
            trustedRoot: job.root,
          });
        },
      );
      await registerLoggedActors(registry, log);
      await waitFor(
        async () =>
          (await job.client.observeJob(owner, job.reservation.job.jobId))
            .finalized,
        12_000,
      );
      const evidence = (
        await job.client.observeJob(owner, job.reservation.job.jobId)
      ).evidence;
      assert.equal(evidence.launch, item.expectedLaunch);
      assert.equal(evidence.cleanupState, item.expectedCleanup);
      assert.notEqual(evidence.launch, 'spawn_failed');
      const fixtureEvents = readFileSync(log, 'utf8');
      if (item.mode === 'disconnect-before-shell') {
        assert.match(fixtureEvents, /^grant_received /m);
        assert.equal(existsSync(marker), false);
      } else {
        assert.match(fixtureEvents, /^spawn_receipt_sent /m);
      }
    } finally {
      await registry.reap();
      await job.client.close();
      rmSync(log, { force: true });
      rmSync(marker, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('grant-send callback error finalizes unknown without spawn_failed', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(
    tmpdir(),
    `pi-watch-grant-callback-error-${crypto.randomUUID()}`,
  );
  const actorLog = join(
    tmpdir(),
    `pi-watch-grant-callback-actors-${crypto.randomUUID()}`,
  );
  const job = await createJob(`touch ${marker}`);
  try {
    await setEnvLaunch(
      {
        PI_WATCH_TEST_DISCONNECT_BEFORE_GRANT_SEND: '1',
        PI_WATCH_TEST_GUARDIAN_MODE: 'delay-disconnect',
        PI_WATCH_TEST_RUNNER_LOG: actorLog,
        PI_WATCH_TEST_GUARDIAN_LOG: actorLog,
      },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    await registerLoggedActors(registry, actorLog);
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      12_000,
    );
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    const callbackErrors = readFileSync(actorLog, 'utf8').match(
      /^grant_send_callback_error$/gm,
    );
    assert.equal(callbackErrors?.length, 1);
    assert.equal(evidence.launch, 'unknown');
    assert.equal(evidence.cleanupState, 'not_requested');
    assert.notEqual(evidence.launch, 'spawn_failed');
    assert.equal(existsSync(marker), false);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('utility resolution and early runner stdin closure remain bounded', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const paths = utilityPaths();
  assert.equal(paths.sh, '/bin/sh');
  assert.equal(
    paths.ps,
    process.platform === 'linux' && !existsSync('/bin/ps')
      ? '/usr/bin/ps'
      : '/bin/ps',
  );
  const job = await createJob('exit 0');
  const entry = join(job.root, 'early-exit-runner.mjs');
  const runnerLog = join(job.root, 'early-exit-runner.log');
  writeFileSync(
    entry,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(runnerLog)}, \`runner_pid \${process.pid}\\n\`);\nprocess.exit(0);\n`,
  );
  try {
    let receipt: Awaited<ReturnType<typeof launchRunner>> | undefined;
    await setEnvLaunch({ PI_WATCH_TEST_RUNNER_LOG: runnerLog }, async () => {
      receipt = await launchRunner(job.client, job.reservation, {
        dbPath: job.db,
        trustedRoot: job.root,
        runnerEntry: entry,
      });
    });
    await registerLoggedRunner(registry, runnerLog);
    assert.equal(receipt?.status, 'spawned');
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('runner exits when launcher keeps token stdin open', {
  timeout: 10_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const root = rootDir();
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), 'dist/runner.js'),
      '--db',
      join(root, 'state', 'jobs.sqlite'),
      '--root',
      root,
      '--owner',
      owner,
      '--job',
      crypto.randomUUID(),
    ],
    { detached: true, stdio: ['pipe', 'ignore', 'ignore'] },
  );
  const pid = child.pid;
  assert.ok(pid !== undefined);
  registry.trackChild(child, { pgid: pid });
  try {
    child.stdin?.write('partial-token');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    assert.equal(processExists(pid), false);
  } finally {
    await registry.reap();
    child.stdin?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner executable override is confined to the internal environment seam', {
  timeout: 20_000,
  skip:
    runtimeSkip || unsupportedNode === undefined
      ? 'requires Node 26 and PI_WATCH_UNSUPPORTED_NODE'
      : false,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  assert.ok(unsupportedNode !== undefined);
  const job = await createJob('exit 0');
  const executedBy = join(job.root, 'runner-executable');
  const runnerLog = join(job.root, 'runner-executable.log');
  const entry = join(job.root, 'record-runner-executable.mjs');
  writeFileSync(
    entry,
    `import { appendFileSync, writeFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(runnerLog)}, \`runner_pid \${process.pid}\\n\`);\nwriteFileSync(${JSON.stringify(executedBy)}, process.execPath);\n`,
  );
  try {
    await setEnvLaunch(
      {
        PI_WATCH_TEST_RUNNER_EXECUTABLE: unsupportedNode,
        PI_WATCH_TEST_RUNNER_LOG: runnerLog,
      },
      async () => {
        const receipt = await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
          runnerEntry: entry,
        });
        assert.equal(receipt.status, 'spawned');
      },
    );
    await registerLoggedRunner(registry, runnerLog);
    await waitFor(async () => existsSync(executedBy), 5_000);
    assert.equal(readFileSync(executedBy, 'utf8'), unsupportedNode);
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('owned process registry reaps actors after injected test failure', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const privateSentinel = 'LIFECYCLE_PRIVATE_PATH_SENTINEL';
  const ownerSentinel = '7e570001-2222-4333-8444-555555555555';
  const nativeErrorSentinel = 'LIFECYCLE_NATIVE_ERROR_SENTINEL';
  const sentinels = [
    'LIFECYCLE_COMMAND_SENTINEL',
    'LIFECYCLE_ENVIRONMENT_SENTINEL',
    'LIFECYCLE_OUTPUT_SENTINEL',
    'LIFECYCLE_CWD_SENTINEL',
    ownerSentinel,
    privateSentinel,
    nativeErrorSentinel,
  ];
  const root = mkdtempSync(join(tmpdir(), `${privateSentinel}-`));
  const cwd = join(root, 'LIFECYCLE_CWD_SENTINEL');
  mkdirSync(cwd, { mode: 0o700 });
  const log = join(root, 'actors.log');
  const ledger = join(root, 'owned-pids');
  const holderLedger = join(root, 'holder-pid');
  const sideEffect = join(root, 'side-effect');
  const diagnosticLog = join(root, 'diagnostic.log');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PI_WATCH_INTERNAL_TEST_SEAMS: '1',
    PI_WATCH_TEST_STREAM_ERROR: 'stderr',
    PI_WATCH_TEST_STREAM_ERROR_DETAIL: nativeErrorSentinel,
    PI_WATCH_TEST_RUNNER_LOG: log,
    PI_WATCH_TEST_GUARDIAN_LOG: log,
    LIFECYCLE_ENV_SECRET: 'LIFECYCLE_ENVIRONMENT_SENTINEL',
    OWNED_FAILURE_ROOT: root,
    OWNED_FAILURE_CWD: cwd,
    OWNED_FAILURE_LOG: log,
    OWNED_FAILURE_LEDGER: ledger,
    OWNED_FAILURE_HOLDER_LEDGER: holderLedger,
    OWNED_FAILURE_SIDE_EFFECT: sideEffect,
    OWNED_FAILURE_DIAGNOSTIC_LOG: diagnosticLog,
    OWNED_FAILURE_COMMAND_CHILD: commandChild,
  };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    const result = await registry.run(
      process.execPath,
      [
        '--test',
        '--test-timeout=20000',
        join(process.cwd(), 'tests/fixtures/owned-registry-failure.test.ts'),
      ],
      { timeoutMs: 25_000, env: childEnv, detached: true },
    );
    assert.equal(result.timedOut, false);
    assert.equal(result.overflowed, false);
    assert.notEqual(result.code, 0);
    const pids = readFileSync(ledger, 'utf8').trim().split('\n').map(Number);
    assert.equal(pids.length, 4);
    await waitFor(async () => pids.every((pid) => !processExists(pid)), 5_000);
    assert.equal(readFileSync(sideEffect).byteLength, 1);
    const surfaces = [
      result.stdout,
      result.stderr,
      result.errorStack,
      result.errorCause,
      existsSync(log) ? readFileSync(log, 'utf8') : '',
      existsSync(diagnosticLog) ? readFileSync(diagnosticLog, 'utf8') : '',
    ];
    const leakCount = surfaces.reduce(
      (count, surface) =>
        count +
        sentinels.filter((sentinel) => surface.includes(sentinel)).length,
      0,
    );
    assert.equal(leakCount, 0);
  } finally {
    await registry.reap();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported runtime rejects launch preflight before reservation or actors', {
  timeout: 20_000,
  skip: unsupportedNode === undefined ? 'set PI_WATCH_UNSUPPORTED_NODE' : false,
}, () => {
  assert.ok(unsupportedNode !== undefined);
  const dir = mkdtempSync(join(tmpdir(), 'pi-watch-unsupported-launch-'));
  const db = join(dir, 'jobs.sqlite');
  const marker = join(dir, 'side-effect');
  const runnerLog = join(dir, 'runner.log');
  const guardianLog = join(dir, 'guardian.log');
  const controller = join(process.cwd(), 'tests/fixtures/launch-controller.ts');
  try {
    const result = spawnSync(
      unsupportedNode,
      [
        controller,
        '--db',
        db,
        '--root',
        dir,
        '--session',
        join(dir, 'session.jsonl'),
        '--command',
        `touch ${marker}`,
        '--key',
        'unsupported-preflight',
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PI_WATCH_TEST_RUNNER_LOG: runnerLog,
          PI_WATCH_TEST_GUARDIAN_LOG: guardianLog,
        },
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^RUNTIME_UNSUPPORTED(?:\n|$)/);
    assert.equal(existsSync(db), false);
    assert.equal(existsSync(runnerLog), false);
    assert.equal(existsSync(guardianLog), false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('command environment and actor argv exclude token and internal variables', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const marker = join(tmpdir(), `pi-watch-env-release-${crypto.randomUUID()}`);
  const envFile = join(tmpdir(), `pi-watch-environment-${crypto.randomUUID()}`);
  const job = await createJob(
    command(['--marker', marker, '--env-file', envFile]),
  );
  const token = job.reservation.runnerToken;
  const actorLog = join(tmpdir(), `pi-watch-actor-pids-${crypto.randomUUID()}`);
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
  try {
    await setEnvLaunch(
      {
        PI_WATCH_TEST_SECRET: 'not-for-command',
        PI_WATCH_TEST_RUNNER_LOG: actorLog,
        PI_WATCH_TEST_GUARDIAN_LOG: actorLog,
      },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    ({ runnerPid, guardianPid } = await registerLoggedActors(
      registry,
      actorLog,
    ));
    const args = `${processArgs(runnerPid)}\n${processArgs(guardianPid)}`;
    assert.doesNotMatch(args, new RegExp(token ?? 'never-match'));
    writeFileSync(marker, 'release');
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
    const environment = readFileSync(envFile, 'utf8');
    assert.doesNotMatch(environment, /PI_WATCH_/);
    assert.doesNotMatch(environment, new RegExp(token ?? 'never-match'));
  } finally {
    await registry.reap();
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(envFile, { force: true });
    rmSync(actorLog, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});
