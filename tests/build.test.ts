import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRuntimeSupport } from '../src/job-store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run build tests through npm.');

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
const unsupportedNode =
  process.env.PI_WATCH_UNSUPPORTED_NODE ??
  (runtimeSupported ? undefined : process.execPath);
const expectedJavaScript = [
  'job-store.js',
  'job-types.js',
  'owner.js',
  'store-client.js',
  'store-evidence.js',
  'store-worker.js',
  'launch.js',
  'runner.js',
  'guardian.js',
  'guardian-protocol.js',
  'process-control.js',
  'private-path.js',
  'output-capture.js',
  'output.js',
  'test-seams.js',
];

test('a fresh build emits the W4 production ESM closure with rewritten imports', {
  timeout: 60_000,
}, () => {
  const entries = readdirSync(dist).sort();
  assert.deepEqual(
    entries,
    [
      ...expectedJavaScript,
      ...expectedJavaScript.map((name) => name.replace('.js', '.d.ts')),
    ].sort(),
  );

  for (const name of expectedJavaScript) {
    const source = readFileSync(join(dist, name), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from|import\()\s*['"](?:\.[^'"]*\.ts)['"]|sourceMappingURL|tests\/|spikes\/|\.pi\//,
    );
    assert.doesNotMatch(source, /\/Users\/|\\Users\\/);
    for (const specifier of source.matchAll(
      /(?:from|import\()\s*['"](\.[^'"]+)['"]/g,
    )) {
      const relative = specifier[1];
      assert.ok(relative !== undefined);
      assert.ok(relative.endsWith('.js'), `${name} retains ${relative}`);
      assert.ok(existsSync(new URL(relative, pathToFileURL(join(dist, name)))));
    }
  }
});

test('an isolated emitted store client uses its default compiled worker and closes it', {
  skip: runtimeSkip,
  timeout: 60_000,
}, () => {
  const isolated = mkdtempSync(join(tmpdir(), 'pi-watch-compiled-'));
  const caller = mkdtempSync(join(tmpdir(), 'pi-watch-caller-'));
  try {
    cpSync(dist, join(isolated, 'dist'), { recursive: true });
    writeFileSync(join(isolated, 'package.json'), '{"type":"module"}\n');
    const moduleUrl = pathToFileURL(
      join(isolated, 'dist/store-client.js'),
    ).href;
    const trustedRoot = join(isolated, 'state');
    mkdirSync(trustedRoot, { mode: 0o700 });
    const dbPath = join(trustedRoot, 'watch', 'v1', 'jobs.sqlite');
    const script = `
      import { openStoreClient } from ${JSON.stringify(moduleUrl)};
      const ownerUuid = '11111111-2222-4333-8444-555555555555';
      let worker;
      const client = await openStoreClient(${JSON.stringify(dbPath)}, {
        trustedRoot: ${JSON.stringify(trustedRoot)},
        onStartupWorker: (candidate) => {
          worker = candidate;
        }
      });
      const reservation = await client.reserve({
        ownerUuid,
        sessionPath: '/synthetic/compiled-session.jsonl',
        namespace: 'tool_call',
        requestKey: 'compiled-smoke',
        command: 'printf compiled',
        cwd: '/synthetic/cwd'
      });
      const record = await client.getJob(ownerUuid, reservation.job.jobId);
      const exited = new Promise((resolve) => worker.once('exit', resolve));
      await client.close();
      const exitCode = await exited;
      console.log(JSON.stringify({
        jobId: reservation.job.jobId,
        command: record.command,
        ownerUuid: record.ownerUuid,
        workerExitCode: exitCode
      }));
    `;
    const fixture = join(caller, 'compiled-smoke.mjs');
    writeFileSync(fixture, script);
    const result = spawnSync(process.execPath, [fixture], {
      cwd: caller,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const line = result.stdout.trim().split('\n').at(-1);
    assert.ok(line);
    const report = JSON.parse(line) as {
      jobId: string;
      command: string;
      ownerUuid: string;
      workerExitCode: number;
    };
    assert.match(report.jobId, /^[0-9a-f-]+$/);
    assert.deepEqual(report, {
      jobId: report.jobId,
      command: 'printf compiled',
      ownerUuid: '11111111-2222-4333-8444-555555555555',
      workerExitCode: 1,
    });
    assert.equal(existsSync(join(isolated, 'src')), false);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

test('the compiled default worker exposes durable control operations', {
  skip: runtimeSkip,
  timeout: 60_000,
}, () => {
  const isolated = mkdtempSync(join(tmpdir(), 'pi-watch-compiled-control-'));
  const caller = mkdtempSync(
    join(tmpdir(), 'pi-watch-compiled-control-caller-'),
  );
  try {
    cpSync(dist, join(isolated, 'dist'), { recursive: true });
    writeFileSync(join(isolated, 'package.json'), '{"type":"module"}\n');
    const moduleUrl = pathToFileURL(
      join(isolated, 'dist/store-client.js'),
    ).href;
    const trustedRoot = join(isolated, 'state');
    mkdirSync(trustedRoot, { mode: 0o700 });
    const dbPath = join(trustedRoot, 'watch', 'v1', 'jobs.sqlite');
    const script = `
      import { openStoreClient } from ${JSON.stringify(moduleUrl)};
      const ownerUuid = '11111111-2222-4333-8444-555555555555';
      const client = await openStoreClient(${JSON.stringify(dbPath)}, {
        trustedRoot: ${JSON.stringify(trustedRoot)}
      });
      const reservation = await client.reserve({
        ownerUuid,
        sessionPath: '/synthetic/compiled-control.jsonl',
        namespace: 'tool_call',
        requestKey: 'compiled-control',
        command: 'printf compiled-control',
        cwd: '/synthetic/cwd'
      });
      const cancellation = await client.requestCancellation(ownerUuid, reservation.job.jobId);
      const claim = await client.claimRunner(ownerUuid, reservation.job.jobId, 'compiled-control-claim', reservation.runnerToken);
      const decision = await client.decideLaunch(ownerUuid, reservation.job.jobId, claim.claimId, reservation.runnerToken);
      const observation = await client.observeJob(ownerUuid, reservation.job.jobId);
      console.log(JSON.stringify({
        cancellation: cancellation.disposition,
        decision: decision.disposition,
        launchDecision: observation.control.launchDecision,
        finalized: observation.finalized
      }));
      await client.close();
    `;
    const fixture = join(caller, 'compiled-control.mjs');
    writeFileSync(fixture, script);
    const result = spawnSync(process.execPath, [fixture], {
      cwd: caller,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
    assert.deepEqual(report, {
      cancellation: 'recorded',
      decision: 'suppressed_now',
      launchDecision: 'suppressed_cancelled',
      finalized: true,
    });
  } finally {
    rmSync(isolated, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

test('a missing emitted worker fails promptly without a live orphan or path leak', {
  skip: runtimeSkip,
  timeout: 60_000,
}, () => {
  const isolated = mkdtempSync(join(tmpdir(), 'pi-watch-missing-worker-'));
  const caller = mkdtempSync(join(tmpdir(), 'pi-watch-missing-caller-'));
  try {
    cpSync(dist, join(isolated, 'dist'), { recursive: true });
    rmSync(join(isolated, 'dist/store-worker.js'));
    writeFileSync(join(isolated, 'package.json'), '{"type":"module"}\n');
    const moduleUrl = pathToFileURL(
      join(isolated, 'dist/store-client.js'),
    ).href;
    const script = `
      import { openStoreClient } from ${JSON.stringify(moduleUrl)};
      let workerExit;
      let workerExited = false;
      try {
        await openStoreClient(${JSON.stringify(join(isolated, 'jobs.sqlite'))}, {
          trustedRoot: ${JSON.stringify(isolated)},
          onStartupWorker: (worker) => {
            workerExit = new Promise((resolve) => worker.once('exit', (code) => {
              workerExited = true;
              resolve(code);
            }));
          }
        });
        process.exitCode = 2;
      } catch (error) {
        const exitedBeforeRejection = workerExited;
        const workerExitCode = workerExit === undefined ? null : await workerExit;
        console.log(JSON.stringify({
          code: error?.code,
          message: error?.message,
          exitedBeforeRejection,
          workerExitCode
        }));
      }
    `;
    const fixture = join(caller, 'missing-worker.mjs');
    writeFileSync(fixture, script);
    const result = spawnSync(process.execPath, [fixture], {
      cwd: caller,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const diagnostic = JSON.parse(
      result.stdout.trim().split('\n').at(-1) ?? '',
    );
    assert.equal(diagnostic.code, 'STORE_UNAVAILABLE');
    assert.equal(typeof diagnostic.workerExitCode, 'number');
    assert.equal(diagnostic.exitedBeforeRejection, true);
    assert.doesNotMatch(
      diagnostic.message,
      /pi-watch-missing-worker|store-worker\.js/,
    );
  } finally {
    rmSync(isolated, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

test('a source client with URL query and fragment uses its default TypeScript worker', {
  skip: runtimeSkip,
  timeout: 60_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-watch-source-url-'));
  try {
    const moduleUrl = new URL(
      '../src/store-client.ts?u2-query-probe#fragment',
      import.meta.url,
    );
    const { openStoreClient } = await import(moduleUrl.href);
    const client = await openStoreClient(
      join(dir, 'watch', 'v1', 'jobs.sqlite'),
      {
        trustedRoot: dir,
      },
    );
    try {
      const reservation = await client.reserve({
        ownerUuid: '11111111-2222-4333-8444-555555555555',
        sessionPath: '/synthetic/source-session.jsonl',
        namespace: 'tool_call',
        requestKey: 'source-url-query',
        command: 'printf source',
        cwd: '/synthetic/cwd',
      });
      assert.equal(reservation.created, true);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the emitted client refuses unsupported Node before worker or disk use', {
  skip: unsupportedNode === undefined ? 'set PI_WATCH_UNSUPPORTED_NODE' : false,
  timeout: 60_000,
}, () => {
  assert.ok(unsupportedNode !== undefined);
  assert.ok(existsSync(unsupportedNode));
  const isolated = mkdtempSync(join(tmpdir(), 'pi-watch-unsupported-build-'));
  const caller = mkdtempSync(join(tmpdir(), 'pi-watch-unsupported-caller-'));
  try {
    cpSync(dist, join(isolated, 'dist'), { recursive: true });
    writeFileSync(join(isolated, 'package.json'), '{"type":"module"}\n');
    const moduleUrl = pathToFileURL(
      join(isolated, 'dist/store-client.js'),
    ).href;
    const dbPath = join(isolated, 'state', 'jobs.sqlite');
    const script = `
        import { openStoreClient } from ${JSON.stringify(moduleUrl)};
        let workerObserved = false;
        try {
          await openStoreClient(${JSON.stringify(dbPath)}, {
            trustedRoot: ${JSON.stringify(isolated)},
            onStartupWorker: () => { workerObserved = true; }
          });
          process.exitCode = 2;
        } catch (error) {
          console.log(JSON.stringify({ code: error?.code, message: error?.message, workerObserved }));
        }
      `;
    const fixture = join(caller, 'unsupported-compiled.mjs');
    writeFileSync(fixture, script);
    const result = spawnSync(unsupportedNode, [fixture], {
      cwd: caller,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const diagnostic = JSON.parse(
      result.stdout.trim().split('\n').at(-1) ?? '',
    );
    assert.equal(diagnostic.code, 'RUNTIME_UNSUPPORTED');
    assert.equal(diagnostic.workerObserved, false);
    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(join(isolated, 'state')), false);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

test('the built output serializer passes complete envelopes through byte-for-byte', {
  timeout: 60_000,
}, () => {
  const isolated = mkdtempSync(join(tmpdir(), 'pi-watch-compiled-output-'));
  const caller = mkdtempSync(join(tmpdir(), 'pi-watch-output-caller-'));
  try {
    cpSync(dist, join(isolated, 'dist'), { recursive: true });
    writeFileSync(join(isolated, 'package.json'), '{"type":"module"}\n');
    const moduleUrl = pathToFileURL(join(isolated, 'dist/output.js')).href;
    const script = `
      import { OUTPUT_ENVELOPE_LIMIT, readOutputSnapshot } from ${JSON.stringify(moduleUrl)};
      const passThrough = (envelope) => JSON.stringify(envelope);
      const observation = {
        jobId: '11111111-2222-4333-8444-555555555555',
        finalized: true,
        capture: {
          available: false,
          truncated: false,
          incomplete: false,
          openAtCutover: false
        }
      };
      const envelopes = [
        readOutputSnapshot({}, observation, 'stdout', 0),
        readOutputSnapshot({}, observation, 'stdout', 1)
      ];
      const serialized = envelopes.map((envelope) => JSON.stringify(envelope));
      const passed = envelopes.map(passThrough);
      console.log(JSON.stringify({
        limit: OUTPUT_ENVELOPE_LIMIT,
        serialized,
        passed,
        sizes: passed.map((value) => Buffer.byteLength(value, 'utf8'))
      }));
    `;
    const fixture = join(caller, 'compiled-output.mjs');
    writeFileSync(fixture, script);
    const result = spawnSync(process.execPath, [fixture], {
      cwd: caller,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout.trim()) as {
      limit: number;
      serialized: string[];
      passed: string[];
      sizes: number[];
    };
    assert.equal(report.limit, 51_200);
    assert.deepEqual(report.passed, report.serialized);
    assert.deepEqual(
      report.sizes,
      report.passed.map((value) => Buffer.byteLength(value)),
    );
    assert.ok(report.sizes.every((size) => size <= report.limit));
    assert.deepEqual(
      report.passed.map((value) => JSON.parse(value).ok),
      [true, false],
    );
    assert.equal(existsSync(join(isolated, 'src')), false);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

test('the copied parent plan matches the approved byte digest', {
  timeout: 60_000,
}, () => {
  const bytes = readFileSync(
    join(
      root,
      'docs/plans/2026-09-09-1329-feat-v0-1-background-commands-plan.md',
    ),
  );
  assert.equal(bytes.length, 75_433);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '59757b99ec2e991c105d44f295a6c2f849798f0083d7dc844b23488f4a8e68e3',
  );
});

test('W4 documentation states earned behavior and deferred boundaries', {
  timeout: 60_000,
}, () => {
  const documentation = [
    'README.md',
    'docs/development.md',
    'docs/u2-launch.md',
  ]
    .map((path) => readFileSync(join(root, path), 'utf8'))
    .join('\n');
  for (const required of [
    '5,242,880 bytes per stream',
    'not cumulative',
    'unbounded',
    'sidecars',
    'SQLite/WAL',
    'failures',
    'remnants',
    'orphans',
    'indefinitely',
    'same OS user',
    'may contain secrets',
    'EPIPE/SIGPIPE',
    'not hard real-time',
    'all-descendant stop',
    'cancellation delivery',
    'heartbeat/reconciliation',
    'Pi authorization or delivery',
    'reload survival',
    'packed installation',
    'broad OS support',
    'PI_WATCH_INTERNAL_TEST_SEAMS=1',
    'capture fault',
    'publication failure',
    'stream error',
    '128 UTF-8 bytes',
    'freeze delay',
    'race coordinator',
    'withhold-all-and-hold',
    'tests/fixtures/owned-process-registry.ts',
    'per-test PID and known-PGID registry',
    'no process scans',
    'injected-failure reporter',
  ]) {
    assert.ok(
      documentation.includes(required),
      `missing W4 disclosure: ${required}`,
    );
  }
});

test('the actual package file list includes only the emitted closure while release remains blocked', {
  timeout: 60_000,
}, () => {
  const output = execFileSync(
    process.execPath,
    [npmCli, '--ignore-scripts', 'run', 'check:package'],
    { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  assert.match(output, /Package content policy passed/);
  const packedPaths = output
    .slice(output.indexOf('files):\n') + 'files):\n'.length)
    .split('This checks package contents;')[0]
    ?.trim()
    .split('\n');
  assert.deepEqual(
    packedPaths,
    [
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      ...expectedJavaScript.flatMap((name) => [
        `dist/${name.replace('.js', '.d.ts')}`,
        `dist/${name}`,
      ]),
      'package.json',
    ].sort(),
  );
  for (const required of [
    'dist/private-path.js',
    'dist/output-capture.js',
    'dist/output.js',
  ]) {
    assert.ok(packedPaths.includes(required));
  }
  assert.ok(
    packedPaths.every(
      (path) =>
        !/(?:\.raw$|\.closed\.json$|\.truncated$|\.sqlite(?:-wal|-shm)?$|\.log$|\.jsonl$|^\.pi\/)/.test(
          path,
        ),
    ),
  );

  const release = spawnSync(
    process.execPath,
    [npmCli, '--ignore-scripts', 'run', 'check:release'],
    { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(release.error, undefined);
  assert.equal(release.status, 1, release.stdout + release.stderr);
  for (const blocker of [
    'Release needs an implemented extension entry.',
    'Release is blocked while the package is private.',
    'Replace foundation version 0.0.0 with an intentional release version.',
  ]) {
    assert.ok(release.stderr.includes(blocker), release.stderr);
  }
});
