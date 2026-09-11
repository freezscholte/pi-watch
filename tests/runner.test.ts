import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRuntimeSupport } from '../src/job-store.ts';
import { launchRunner } from '../src/launch.ts';
import { openStoreClient } from '../src/store-client.ts';
import { utilityPaths } from '../src/test-seams.ts';

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
function processGroup(pid: number): number {
  return Number(
    execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim(),
  );
}
function killGroup(pid: number): void {
  try {
    const pgid = processGroup(pid);
    if (pgid > 1 && pgid !== process.pid) process.kill(-pgid, 'SIGKILL');
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already exited */
  }
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

test('runner executes one held command and publishes shell outcome', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async () => {
  const { root, client, reservation } = await createJob('exit 0');
  try {
    assert.equal(reservation.created, true);
    const started = await launchRunner(client, reservation, {
      dbPath: join(root, 'state', 'jobs.sqlite'),
      trustedRoot: root,
    });
    assert.equal(started.status, 'spawned');
    await waitFor(
      async () =>
        (await client.observeJob(owner, reservation.job.jobId)).finalized,
    );
    const observation = await client.observeJob(owner, reservation.job.jobId);
    assert.equal(observation.evidence.launch, 'launched');
    assert.equal(observation.evidence.shellCode, 0);
    assert.equal(observation.evidence.stdout.available, false);
    assert.equal(observation.evidence.stderr.available, false);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('replay does not launch a second command', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async () => {
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
    await launchRunner(client, reservation, {
      dbPath: join(root, 'state', 'jobs.sqlite'),
      trustedRoot: root,
    });
    await waitFor(
      async () =>
        (await client.observeJob(owner, reservation.job.jobId)).finalized,
    );
    await assert.rejects(() =>
      launchRunner(client, replay, {
        dbPath: join(root, 'state', 'jobs.sqlite'),
        trustedRoot: root,
      }),
    );
    assert.equal(readFileSync(marker, 'utf8'), 'x');
  } finally {
    await client.close();
    rmSync(marker, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('before-start cancellation suppresses command', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async () => {
  const marker = join(tmpdir(), `pi-watch-marker-${crypto.randomUUID()}`);
  const { root, client, reservation } = await createJob(`touch ${marker}`);
  try {
    await client.requestCancellation(owner, reservation.job.jobId);
    await launchRunner(client, reservation, {
      dbPath: join(root, 'state', 'jobs.sqlite'),
      trustedRoot: root,
    });
    await waitFor(
      async () =>
        (await client.observeJob(owner, reservation.job.jobId)).finalized,
    );
    const result = await client.observeJob(owner, reservation.job.jobId);
    assert.equal(result.evidence.launch, 'suppressed_cancelled');
    assert.equal(existsSync(marker), false);
  } finally {
    await client.close();
    rmSync(marker, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('held command returns early and records root-exit escalation timing', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
  const marker = join(tmpdir(), `pi-watch-release-${crypto.randomUUID()}`);
  const log = join(tmpdir(), `pi-watch-guardian-log-${crypto.randomUUID()}`);
  const job = await createJob(command(['--marker', marker]));
  try {
    await setEnvLaunch({ PI_WATCH_TEST_GUARDIAN_LOG: log }, async () => {
      const started = await launchRunner(job.client, job.reservation, {
        dbPath: job.db,
        trustedRoot: job.root,
      });
      assert.equal(started.status, 'spawned');
    });
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
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(log, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('distinct exit, signal, and missing-cwd outcomes are evidenced', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async () => {
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
    const job = await createJob(
      item.command,
      item.cwd === undefined ? {} : { cwd: item.cwd },
    );
    try {
      await launchRunner(job.client, job.reservation, {
        dbPath: job.db,
        trustedRoot: job.root,
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
      assert.equal(evidence.launch, item.launch);
      if (item.code !== undefined) assert.equal(evidence.shellCode, item.code);
      if (item.signal !== undefined)
        assert.equal(evidence.shellSignal, item.signal);
      if (item.launch === 'spawn_failed')
        assert.equal(evidence.shellCode, null);
    } finally {
      await job.client.close();
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('expired deadline suppresses and cancellation wins the same boundary', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
  for (const both of [false, true]) {
    const marker = join(tmpdir(), `pi-watch-deadline-${crypto.randomUUID()}`);
    const job = await createJob(`touch ${marker}`, { deadlineMs: 1 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (both)
        await job.client.requestCancellation(owner, job.reservation.job.jobId);
      await launchRunner(job.client, job.reservation, {
        dbPath: job.db,
        trustedRoot: job.root,
      });
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
      await job.client.close();
      rmSync(marker, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('wrapper can exit while detached job completes, and killed wrapper does not relaunch', {
  timeout: 60_000,
  skip: runtimeSkip,
}, async () => {
  const root = rootDir();
  const db = join(root, 'state', 'jobs.sqlite');
  const controller = join(process.cwd(), 'tests/fixtures/launch-controller.ts');
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
  const natural = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env },
  });
  assert.equal(natural.status, 0, natural.stderr);
  const report = JSON.parse(natural.stdout.trim());
  const client = await openStoreClient(db, { trustedRoot: root });
  let killedRunnerPid: number | undefined;
  try {
    await waitFor(
      async () => (await client.observeJob(owner, report.jobId)).finalized,
    );
    const marker = join(root, 'wrapper-append-marker');
    const runnerLog = join(root, 'wrapper-runner.log');
    const guardianLog = join(root, 'wrapper-guardian.log');
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
          PI_WATCH_TEST_GUARDIAN_LOG: guardianLog,
          PI_WATCH_TEST_PAUSE_CONTROLLER_AFTER_LAUNCH: '1',
        },
      },
    );
    killedRunnerPid = await waitForLoggedPid(runnerLog, 'runner');
    const killedExit = new Promise<void>((resolve) => {
      if (killed.exitCode !== null || killed.signalCode !== null) resolve();
      else killed.once('exit', () => resolve());
    });
    assert.equal(killed.kill('SIGKILL'), true);
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
    assert.equal(readFileSync(marker, 'utf8'), 'x');
    assert.ok(killedRunnerPid !== undefined);
  } finally {
    if (killedRunnerPid !== undefined) killGroup(killedRunnerPid);
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
}, async () => {
  for (const mode of ['before', 'after'] as const) {
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
      runnerPid = await waitForLoggedPid(runnerLog, 'runner');
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
      if (runnerPid !== undefined) killGroup(runnerPid);
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
}, async () => {
  for (const pause of [
    'PI_WATCH_TEST_PAUSE_BEFORE_DECIDE',
    'PI_WATCH_TEST_PAUSE_AFTER_AUTHORIZED',
  ]) {
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
      runnerPid = await waitForLoggedPid(runnerLog, 'runner');
      if (pause === 'PI_WATCH_TEST_PAUSE_AFTER_AUTHORIZED') {
        await waitFor(
          async () =>
            (await job.client.observeJob(owner, job.reservation.job.jobId))
              .control.launchDecision === 'authorized',
        );
      }
      killGroup(runnerPid);
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
      if (runnerPid !== undefined) killGroup(runnerPid);
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
}, async () => {
  for (const mode of ['garbage', 'hang', 'large'] as const) {
    const job = await createJob('exit 0');
    try {
      const ps = utilityFixture(job.root, mode);
      await setEnvLaunch({ PI_WATCH_TEST_PS_PATH: ps }, async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      });
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
      await job.client.close();
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('TERM-ignoring topology probe cannot retain guardian or runner', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async () => {
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
    runnerPid = await waitForLoggedPid(actorLog, 'runner');
    guardianPid = await waitForLoggedPid(actorLog, 'guardian');
    await waitFor(async () => existsSync(probeLog));
    probePid = Number(readFileSync(probeLog, 'utf8').trim());
    assert.ok(Number.isInteger(probePid));
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
    if (probePid !== undefined) {
      try {
        process.kill(probePid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    if (guardianPid !== undefined) killGroup(guardianPid);
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(probeLog, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('SIGTERM during topology probe stops guardian, probe, and runner', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async () => {
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
    runnerPid = await waitForLoggedPid(actorLog, 'runner');
    guardianPid = await waitForLoggedPid(actorLog, 'guardian');
    await waitFor(async () => existsSync(probeLog));
    probePid = Number(readFileSync(probeLog, 'utf8').trim());
    assert.ok(Number.isInteger(probePid));

    process.kill(guardianPid, 'SIGTERM');

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
    if (probePid !== undefined && processExists(probePid)) {
      try {
        process.kill(probePid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    if (guardianPid !== undefined) killGroup(guardianPid);
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(probeLog, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('missing sh and ps fail before guardian spawn', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
  for (const key of ['PI_WATCH_TEST_SH_PATH', 'PI_WATCH_TEST_PS_PATH']) {
    const job = await createJob('exit 0');
    const guardianLog = join(
      tmpdir(),
      `pi-watch-missing-utility-${crypto.randomUUID()}`,
    );
    try {
      await setEnvLaunch(
        {
          [key]: join(job.root, 'does-not-exist'),
          PI_WATCH_TEST_GUARDIAN_LOG: guardianLog,
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
      await job.client.close();
      rmSync(guardianLog, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
});

test('runner loss lets guardian escalate while store remains launched and open', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
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
    runnerPid = await waitForLoggedPid(log, 'runner');
    killGroup(runnerPid);
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
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(log, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('withheld spawn receipt finalizes honestly as unknown', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
  const marker = join(tmpdir(), `pi-watch-withheld-${crypto.randomUUID()}`);
  const job = await createJob(`touch ${marker}`);
  try {
    await setEnvLaunch(
      { PI_WATCH_TEST_GUARDIAN_MODE: 'withhold-spawn' },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      15_000,
    );
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    assert.equal(evidence.launch, 'unknown');
    assert.equal(evidence.shellCode, null);
    assert.equal(existsSync(marker), true);
  } finally {
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('grant arriving after the guardian deadline fails before shell spawn', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async () => {
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
    runnerPid = await waitForLoggedPid(actorLog, 'runner');
    guardianPid = await waitForLoggedPid(actorLog, 'guardian');
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
    if (guardianPid !== undefined) killGroup(guardianPid);
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('guardian deadline records trigger and unconfirmed cleanup', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
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
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
  try {
    await setEnvLaunch(
      {
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
    runnerPid = await waitForLoggedPid(actorLog, 'runner');
    guardianPid = await waitForLoggedPid(actorLog, 'guardian');
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
    if (guardianPid !== undefined) killGroup(guardianPid);
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('root exit before deadline does not fabricate deadline trigger evidence', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
  const actorLog = join(
    tmpdir(),
    `pi-watch-predeadline-exit-${crypto.randomUUID()}`,
  );
  const job = await createJob('sleep 1; exit 0', { deadlineMs: 2_000 });
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
  const startedAt = Date.now();
  try {
    await setEnvLaunch(
      {
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
    runnerPid = await waitForLoggedPid(actorLog, 'runner');
    guardianPid = await waitForLoggedPid(actorLog, 'guardian');
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
    if (guardianPid !== undefined) killGroup(guardianPid);
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('withheld guardian deadline receipt is not inferred from runner clock', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
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
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
  try {
    await setEnvLaunch(
      {
        PI_WATCH_TEST_GUARDIAN_MODE: 'withhold-deadline',
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
    runnerPid = await waitForLoggedPid(actorLog, 'runner');
    guardianPid = await waitForLoggedPid(actorLog, 'guardian');
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
    if (guardianPid !== undefined) killGroup(guardianPid);
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('guardian loss after root exit finalizes without pipe EOF', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async () => {
  const log = join(tmpdir(), `pi-watch-guardian-pid-${crypto.randomUUID()}`);
  const job = await createJob(command(['--spawn-holder']));
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
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
    runnerPid = await waitForLoggedPid(log, 'runner');
    guardianPid = await waitForLoggedPid(log, 'guardian');
    await waitFor(
      async () =>
        existsSync(log) &&
        readFileSync(log, 'utf8').includes('shell_exit_receipt'),
      10_000,
    );
    assert.equal(
      (await job.client.observeJob(owner, job.reservation.job.jobId)).finalized,
      false,
    );
    killGroup(guardianPid);
    await waitFor(
      async () =>
        (await job.client.observeJob(owner, job.reservation.job.jobId))
          .finalized,
      5_000,
    );
    const evidence = (
      await job.client.observeJob(owner, job.reservation.job.jobId)
    ).evidence;
    assert.equal(evidence.shellCode, 0);
    assert.equal(evidence.cleanupState, 'unconfirmed');
    await waitForGone(runnerPid);
  } finally {
    if (guardianPid !== undefined) killGroup(guardianPid);
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(log, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('runner budget finalizes when guardian withholds exit receipts', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
  const job = await createJob('exit 0', { deadlineMs: 2_000 });
  try {
    await setEnvLaunch(
      { PI_WATCH_TEST_GUARDIAN_MODE: 'withhold-exit' },
      async () => {
        await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
        });
      },
    );
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
    await job.client.close();
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('missing guardian entry and readiness timeout publish spawn_failed', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
  const readinessFixture = join(
    tmpdir(),
    `pi-watch-readiness-${crypto.randomUUID()}.mjs`,
  );
  writeFileSync(
    readinessFixture,
    "setInterval(() => undefined, 1000); process.on('disconnect', () => process.exit(0));\n",
  );
  for (const guardianPath of [
    join(tmpdir(), `pi-watch-missing-guardian-${crypto.randomUUID()}.js`),
    readinessFixture,
  ]) {
    const runnerLog = join(
      tmpdir(),
      `pi-watch-readiness-runner-${crypto.randomUUID()}`,
    );
    const job = await createJob('exit 0');
    let runnerPid: number | undefined;
    try {
      await setEnvLaunch(
        {
          PI_WATCH_TEST_GUARDIAN_PATH: guardianPath,
          PI_WATCH_TEST_RUNNER_LOG: runnerLog,
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
          (await job.client.observeJob(owner, job.reservation.job.jobId))
            .finalized,
        10_000,
      );
      runnerPid = await waitForLoggedPid(runnerLog, 'runner');
      const evidence = (
        await job.client.observeJob(owner, job.reservation.job.jobId)
      ).evidence;
      assert.equal(evidence.launch, 'spawn_failed');
      assert.equal(evidence.cleanupState, 'not_required');
      await waitForGone(runnerPid, 5_000);
    } finally {
      if (runnerPid !== undefined) killGroup(runnerPid);
      await job.client.close();
      rmSync(runnerLog, { force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }
  rmSync(readinessFixture, { force: true });
});

test('readiness timeout latches before delayed publication and rejects late topology', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async () => {
  const marker = join(
    tmpdir(),
    `pi-watch-late-topology-${crypto.randomUUID()}`,
  );
  const job = await createJob(`touch ${marker}`);
  try {
    await setEnvLaunch(
      {
        PI_WATCH_TEST_GUARDIAN_MODE: 'late-topology',
        PI_WATCH_TEST_PUBLISH_DELAY_MS: '1000',
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
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('guardian disconnect starts runner budget even while guardian stays alive', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async () => {
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
    runnerPid = await waitForLoggedPid(actorLog, 'runner');
    guardianPid = await waitForLoggedPid(actorLog, 'guardian');
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
    if (guardianPid !== undefined) killGroup(guardianPid);
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(actorLog, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('post-grant guardian disconnect preserves phase-appropriate evidence', {
  timeout: 30_000,
  skip: runtimeSkip,
}, async () => {
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
          PI_WATCH_TEST_GUARDIAN_LOG: log,
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
}, async () => {
  const marker = join(
    tmpdir(),
    `pi-watch-grant-callback-error-${crypto.randomUUID()}`,
  );
  const actorLog = join(
    tmpdir(),
    `pi-watch-grant-callback-actors-${crypto.randomUUID()}`,
  );
  const job = await createJob(`touch ${marker}`);
  let runnerPid: number | undefined;
  let guardianPid: number | undefined;
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
    runnerPid = await waitForLoggedPid(actorLog, 'runner');
    guardianPid = await waitForLoggedPid(actorLog, 'guardian');
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
    if (guardianPid !== undefined) killGroup(guardianPid);
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(actorLog, { force: true });
    rmSync(marker, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('utility resolution and early runner stdin closure remain bounded', {
  timeout: 20_000,
  skip: runtimeSkip,
}, async () => {
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
  writeFileSync(entry, 'process.exit(0);\n');
  try {
    const receipt = await launchRunner(job.client, job.reservation, {
      dbPath: job.db,
      trustedRoot: job.root,
      runnerEntry: entry,
    });
    assert.equal(receipt.status, 'spawned');
  } finally {
    await job.client.close();
    rmSync(job.root, { recursive: true, force: true });
  }
});

test('runner exits when launcher keeps token stdin open', {
  timeout: 10_000,
  skip: runtimeSkip,
}, async () => {
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
  try {
    child.stdin?.write('partial-token');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    assert.equal(processExists(pid), false);
  } finally {
    if (processExists(pid)) killGroup(pid);
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
}, async () => {
  assert.ok(unsupportedNode !== undefined);
  const job = await createJob('exit 0');
  const executedBy = join(job.root, 'runner-executable');
  const entry = join(job.root, 'record-runner-executable.mjs');
  writeFileSync(
    entry,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(executedBy)}, process.execPath);\n`,
  );
  try {
    await setEnvLaunch(
      { PI_WATCH_TEST_RUNNER_EXECUTABLE: unsupportedNode },
      async () => {
        const receipt = await launchRunner(job.client, job.reservation, {
          dbPath: job.db,
          trustedRoot: job.root,
          runnerEntry: entry,
        });
        assert.equal(receipt.status, 'spawned');
      },
    );
    await waitFor(async () => existsSync(executedBy), 5_000);
    assert.equal(readFileSync(executedBy, 'utf8'), unsupportedNode);
  } finally {
    await job.client.close();
    rmSync(job.root, { recursive: true, force: true });
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
}, async () => {
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
    runnerPid = await waitForLoggedPid(actorLog, 'runner');
    guardianPid = await waitForLoggedPid(actorLog, 'guardian');
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
    if (guardianPid !== undefined) killGroup(guardianPid);
    if (runnerPid !== undefined) killGroup(runnerPid);
    await job.client.close();
    rmSync(marker, { force: true });
    rmSync(envFile, { force: true });
    rmSync(actorLog, { force: true });
    rmSync(job.root, { recursive: true, force: true });
  }
});
