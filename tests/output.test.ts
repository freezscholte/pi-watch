import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import fs, {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { StoreError, toDiagnostic } from '../src/job-types.ts';
import {
  OUTPUT_ENVELOPE_LIMIT,
  type OutputObservation,
  readOutputSnapshot,
} from '../src/output.ts';
import {
  createOutputCapture,
  inspectClosureReceipt,
  OUTPUT_CAPTURE_LIMIT,
  parseClosureReceipt,
} from '../src/output-capture.ts';
import {
  type CaptureArtifact,
  prepareCaptureWorkspace,
  prepareFixedLayout,
} from '../src/private-path.ts';
import { useOwnedProcessRegistry } from './fixtures/owned-process-registry.ts';

const JOB = 'a1111111-b222-4c33-8d44-e55555555555';

function fixture(): {
  root: string;
  layout: ReturnType<typeof prepareFixedLayout>;
  workspace: ReturnType<typeof prepareCaptureWorkspace>;
} {
  const root = mkdtempSync(join(tmpdir(), 'pi-watch-output-'));
  const database = join(root, 'watch', 'v1', 'jobs.sqlite');
  const layout = prepareFixedLayout(database, root);
  writeFileSync(layout.databasePath, '', { mode: 0o600 });
  return { root, layout, workspace: prepareCaptureWorkspace(layout, JOB) };
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function pattern(length: number, seed: number): Buffer {
  const value = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1)
    value[index] = (index * 31 + seed) & 0xff;
  return value;
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytes(value: string | Uint8Array): Buffer {
  return typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
}

function firstDifference(actual: Uint8Array, expected: Uint8Array): number {
  const shared = Math.min(actual.byteLength, expected.byteLength);
  for (let index = 0; index < shared; index += 1) {
    if (actual[index] !== expected[index]) return index;
  }
  return actual.byteLength === expected.byteLength ? -1 : shared;
}

/** Assertion operands contain only counts, digests, and a differing offset. */
function assertRedactedEqual(
  actualValue: string | Uint8Array,
  expectedValue: string | Uint8Array,
): void {
  const actual = bytes(actualValue);
  const expected = bytes(expectedValue);
  const expectedDigest = digest(expected);
  assert.deepEqual(
    {
      actualBytes: actual.byteLength,
      expectedBytes: expected.byteLength,
      actualDigest: digest(actual),
      expectedDigest,
      firstDifference: firstDifference(actual, expected),
    },
    {
      actualBytes: expected.byteLength,
      expectedBytes: expected.byteLength,
      actualDigest: expectedDigest,
      expectedDigest,
      firstDifference: -1,
    },
  );
}

function assertRedacted(surfaces: string[], sentinels: string[]): void {
  const leakCount = surfaces.reduce(
    (count, surface) =>
      count + sentinels.filter((sentinel) => surface.includes(sentinel)).length,
    0,
  );
  assert.equal(leakCount, 0);
}

async function withMismatchedGetuid<T>(
  passThroughCalls: number,
  action: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  const original = process.getuid;
  if (
    descriptor === undefined ||
    typeof original !== 'function' ||
    (!descriptor.configurable && !descriptor.writable)
  ) {
    throw new Error('process.getuid is not replaceable on this Unix runtime');
  }
  const actual = original.call(process);
  let calls = 0;
  Object.defineProperty(process, 'getuid', {
    ...descriptor,
    value: () => (calls++ < passThroughCalls ? actual : actual + 1),
  });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, 'getuid', descriptor);
  }
}

async function withTestFault<T>(
  fault: string,
  action: () => Promise<T>,
): Promise<T> {
  const beforeGate = process.env.PI_WATCH_INTERNAL_TEST_SEAMS;
  const beforeFault = process.env.PI_WATCH_TEST_CAPTURE_FAULT;
  process.env.PI_WATCH_INTERNAL_TEST_SEAMS = '1';
  process.env.PI_WATCH_TEST_CAPTURE_FAULT = fault;
  try {
    return await action();
  } finally {
    if (beforeGate === undefined)
      delete process.env.PI_WATCH_INTERNAL_TEST_SEAMS;
    else process.env.PI_WATCH_INTERNAL_TEST_SEAMS = beforeGate;
    if (beforeFault === undefined)
      delete process.env.PI_WATCH_TEST_CAPTURE_FAULT;
    else process.env.PI_WATCH_TEST_CAPTURE_FAULT = beforeFault;
  }
}

test('capture retains exact independent prefixes and drains overflow', {
  timeout: 60_000,
}, async () => {
  const { root, workspace } = fixture();
  try {
    const stdoutInput = pattern(OUTPUT_CAPTURE_LIMIT + 97, 7);
    const stderrInput = pattern(OUTPUT_CAPTURE_LIMIT + 53, 19);
    const stdout = createOutputCapture(workspace, 'stdout');
    const stderr = createOutputCapture(workspace, 'stderr');
    stdout.accept(stdoutInput);
    stderr.accept(stderrInput);
    const [stdoutResult, stderrResult] = await Promise.all([
      stdout.seal({ source: 'eof' }),
      stderr.seal({ source: 'eof' }),
    ]);
    assertRedactedEqual(
      readFileSync(workspace.paths('stdout').raw),
      stdoutInput.subarray(0, OUTPUT_CAPTURE_LIMIT),
    );
    assertRedactedEqual(
      readFileSync(workspace.paths('stderr').raw),
      stderrInput.subarray(0, OUTPUT_CAPTURE_LIMIT),
    );
    assert.equal(stdoutResult.retainedBytes, OUTPUT_CAPTURE_LIMIT);
    assert.equal(stderrResult.retainedBytes, OUTPUT_CAPTURE_LIMIT);
    assert.equal(stdoutResult.drainedBytes, stdoutInput.length);
    assert.equal(stderrResult.drainedBytes, stderrInput.length);
    assert.equal(stdoutResult.truncated, true);
    assert.equal(stderrResult.truncated, true);
  } finally {
    cleanup(root);
  }
});

test('source error remains drain-only until lifecycle cutover', {
  timeout: 60_000,
}, async () => {
  const { root, workspace } = fixture();
  try {
    const capture = createOutputCapture(workspace, 'stdout');
    capture.accept(Buffer.from('before'));
    capture.sourceError();
    capture.accept(Buffer.from('after'));
    const result = await capture.seal({ source: 'cutover' });
    assert.equal(result.drainedBytes, 11);
    assert.equal(result.incomplete, true);
    assert.equal(result.openAtCutover, true);
    assert.equal(result.receipt?.reason, 'capture_error');
    assertRedactedEqual(readFileSync(workspace.paths('stdout').raw), 'before');
  } finally {
    cleanup(root);
  }
});

test('exact cap followed by EOF is not truncation', {
  timeout: 60_000,
}, async () => {
  const { root, workspace } = fixture();
  try {
    const capture = createOutputCapture(workspace, 'stdout');
    capture.accept(Buffer.alloc(OUTPUT_CAPTURE_LIMIT, 0x61));
    const result = await capture.seal({ source: 'eof' });
    assert.equal(result.retainedBytes, OUTPUT_CAPTURE_LIMIT);
    assert.equal(result.truncated, false);
    assert.equal(result.incomplete, false);
    assert.equal(existsSync(workspace.paths('stdout').truncated), false);
  } finally {
    cleanup(root);
  }
});

test('cap plus one creates truncation', { timeout: 60_000 }, async () => {
  const { root, workspace } = fixture();
  try {
    const capture = createOutputCapture(workspace, 'stdout');
    capture.accept(Buffer.alloc(OUTPUT_CAPTURE_LIMIT + 1, 0x62));
    const result = await capture.seal({ source: 'eof' });
    const marker = statSync(workspace.paths('stdout').truncated);
    assert.equal(result.truncated, true);
    assert.equal(marker.size, 0);
    assert.equal(marker.mode & 0o7777, 0o600);
    assert.equal(marker.nlink, 1);
  } finally {
    cleanup(root);
  }
});

test('one-byte chunks reach overflow with bounded queue and task cardinality', {
  timeout: 60_000,
}, async () => {
  const { root, workspace } = fixture();
  try {
    const capture = createOutputCapture(workspace, 'stdout');
    const byte = Buffer.of(0x5a);
    for (let index = 0; index <= OUTPUT_CAPTURE_LIMIT; index += 1)
      capture.accept(byte);
    const result = await capture.seal({ source: 'eof' });
    assert.equal(result.retainedBytes, OUTPUT_CAPTURE_LIMIT);
    assert.equal(result.truncated, true);
    assert.equal(result.drainedBytes, OUTPUT_CAPTURE_LIMIT + 1);
    assert.ok(result.telemetry.maxPendingWrites <= 1);
    assert.ok(result.telemetry.maxBuffers <= 2);
    assert.ok(result.telemetry.maxReservedBytes <= OUTPUT_CAPTURE_LIMIT);
    assert.equal(result.telemetry.acceptCallbacks, OUTPUT_CAPTURE_LIMIT + 1);
    assert.ok(result.telemetry.writeAttempts <= 2);
    assert.equal(result.telemetry.pumpStarts, 1);
    capture.accept(Buffer.from('ignored-after-seal'));
    const sealedAgain = await capture.seal({ source: 'cutover' });
    assert.deepEqual(sealedAgain, result);
    assert.equal(
      statSync(workspace.paths('stdout').raw).size,
      OUTPUT_CAPTURE_LIMIT,
    );
  } finally {
    cleanup(root);
  }
});

test('short writes never expose a retained hole', {
  timeout: 60_000,
}, async () => {
  await withTestFault('short-write:17', async () => {
    const { root, workspace } = fixture();
    try {
      const expected = pattern(131_113, 23);
      const capture = createOutputCapture(workspace, 'stdout');
      capture.accept(expected);
      const result = await capture.seal({ source: 'eof' });
      assert.equal(result.available, true);
      assert.equal(result.incomplete, false);
      assertRedactedEqual(
        readFileSync(workspace.paths('stdout').raw),
        expected,
      );
    } finally {
      cleanup(root);
    }
  });
});

test('overflow plus partial short-write failure exposes its durable contiguous prefix', {
  timeout: 60_000,
}, async () => {
  await withTestFault('short-write:17:fail-after:34', async () => {
    const { root, layout, workspace } = fixture();
    try {
      const input = Buffer.alloc(OUTPUT_CAPTURE_LIMIT + 1, 0x61);
      const capture = createOutputCapture(workspace, 'stdout');
      capture.accept(input);
      const result = await capture.seal({ source: 'eof' });
      assert.equal(result.available, true);
      assert.equal(result.retainedBytes, 34);
      assert.equal(result.truncated, true);
      assert.equal(result.incomplete, true);
      assert.equal(result.receipt?.reason, 'capture_error');
      assertRedactedEqual(
        readFileSync(workspace.paths('stdout').raw),
        input.subarray(0, 34),
      );

      const page = successData(
        readOutputSnapshot(
          layout,
          finalizedObservation({ truncated: true, incomplete: true }),
          'stdout',
          0,
        ),
      );
      assert.equal(page.retainedBytes, 34);
      assert.equal(page.truncated, true);
      assert.equal(page.incomplete, true);
      assertRedactedEqual(page.text, 'a'.repeat(34));
    } finally {
      cleanup(root);
    }
  });
});

test('fixed capture artifact paths reject each unsafe pre-existing artifact', {
  timeout: 60_000,
}, async () => {
  const artifacts: CaptureArtifact[] = [
    'raw',
    'truncated',
    'closedTemporary',
    'closed',
  ];
  const hazards = ['symlink', 'hardlink', 'mode', 'directory'] as const;
  for (const artifact of artifacts) {
    for (const hazard of hazards) {
      const { root, workspace } = fixture();
      const outside = join(root, 'outside');
      writeFileSync(outside, 'outside-bytes', { mode: 0o600 });
      const outsideBefore = {
        bytes: statSync(outside).size,
        hash: digest(readFileSync(outside)),
      };
      try {
        const target = workspace.paths('stdout')[artifact];
        const capture =
          artifact === 'raw'
            ? undefined
            : createOutputCapture(workspace, 'stdout');
        if (hazard === 'symlink') symlinkSync(outside, target);
        else if (hazard === 'hardlink') linkSync(outside, target);
        else if (hazard === 'mode') {
          writeFileSync(target, '', { mode: 0o600 });
          chmodSync(target, 0o644);
        } else if (hazard === 'directory') mkdirSync(target, { mode: 0o700 });

        const exercise = async () => {
          const active = capture ?? createOutputCapture(workspace, 'stdout');
          active.accept(
            artifact === 'truncated'
              ? Buffer.alloc(OUTPUT_CAPTURE_LIMIT + 1, 0x61)
              : Buffer.from('bounded-prefix'),
          );
          return active.seal({ source: 'eof' });
        };
        const result = await exercise();
        assert.equal(result.available, false);
        assert.equal(result.incomplete, true);
        assert.deepEqual(
          {
            bytes: statSync(outside).size,
            hash: digest(readFileSync(outside)),
          },
          outsideBefore,
        );
      } finally {
        cleanup(root);
      }
    }
  }
});

test('fixed workspace components reject unsafe entries at the intended boundary', {
  timeout: 60_000,
}, () => {
  const hazards = ['symlink', 'file', 'mode'] as const;
  for (const component of ['jobs', 'workspace'] as const) {
    for (const hazard of hazards) {
      const root = mkdtempSync(join(tmpdir(), 'pi-watch-component-'));
      const outsideDirectory = join(root, 'outside-directory');
      const outsideSentinel = join(outsideDirectory, 'sentinel');
      mkdirSync(outsideDirectory, { mode: 0o700 });
      writeFileSync(outsideSentinel, 'outside-bytes', { mode: 0o600 });
      const outsideBefore = {
        bytes: statSync(outsideSentinel).size,
        hash: digest(readFileSync(outsideSentinel)),
      };
      try {
        const layout = prepareFixedLayout(
          join(root, 'watch', 'v1', 'jobs.sqlite'),
          root,
        );
        writeFileSync(layout.databasePath, '', { mode: 0o600 });
        const workspacePath = layout.workspacePath(JOB);
        const target =
          component === 'jobs' ? dirname(workspacePath) : workspacePath;
        if (component === 'workspace')
          mkdirSync(dirname(target), { mode: 0o700 });
        if (hazard === 'symlink') symlinkSync(outsideDirectory, target, 'dir');
        else if (hazard === 'file') writeFileSync(target, '', { mode: 0o600 });
        else {
          mkdirSync(target, { mode: 0o700 });
          chmodSync(target, 0o755);
        }

        assert.throws(
          () => prepareCaptureWorkspace(layout, JOB),
          (error: unknown) =>
            error instanceof StoreError && error.code === 'PATH_UNSAFE',
        );
        assert.deepEqual(
          {
            bytes: statSync(outsideSentinel).size,
            hash: digest(readFileSync(outsideSentinel)),
          },
          outsideBefore,
        );
      } finally {
        cleanup(root);
      }
    }
  }
});

test('FIFO raw artifacts return finitely without a writer', {
  timeout: 60_000,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const value = fixture();
  try {
    rmSync(value.workspace.paths('stdout').raw, { force: true });
    const fifo = await registry.run(
      'mkfifo',
      [value.workspace.paths('stdout').raw],
      { timeoutMs: 5_000 },
    );
    if (fifo.errorCode === 'ENOENT') {
      context.skip('mkfifo is unavailable on PATH');
      return;
    }
    assert.equal(fifo.timedOut, false);
    assert.equal(fifo.overflowed, false);
    assert.equal(fifo.code, 0);
    chmodSync(value.workspace.paths('stdout').raw, 0o600);
    const fifoStat = statSync(value.workspace.paths('stdout').raw);
    assert.equal(fifoStat.isFIFO(), true);
    assert.equal(fifoStat.mode & 0o7777, 0o600);
    assert.equal(fifoStat.nlink, 1);
    if (typeof process.getuid === 'function')
      assert.equal(fifoStat.uid, process.getuid());

    const probe = [
      'const {prepareFixedLayout}=await import(process.env.PRIVATE_PATH_MODULE);',
      'const {readOutputSnapshot}=await import(process.env.OUTPUT_MODULE);',
      'const layout=prepareFixedLayout(process.env.DATABASE_PATH,process.env.TRUSTED_ROOT);',
      `const observation={jobId:'${JOB}',finalized:false,capture:{available:null,truncated:false,incomplete:false,openAtCutover:false}};`,
      "const envelope=readOutputSnapshot(layout,observation,'stdout',0);",
      "process.exitCode=!envelope.ok&&envelope.error.code==='CAPTURE_UNAVAILABLE'?0:1;",
    ].join('');
    const child = await registry.run(
      process.execPath,
      ['--input-type=module', '--eval', probe],
      {
        timeoutMs: 2_000,
        detached: true,
        env: {
          ...process.env,
          PRIVATE_PATH_MODULE: new URL(
            '../src/private-path.ts',
            import.meta.url,
          ).href,
          OUTPUT_MODULE: new URL('../src/output.ts', import.meta.url).href,
          DATABASE_PATH: value.layout.databasePath,
          TRUSTED_ROOT: value.root,
        },
      },
    );
    assert.equal(child.timedOut, false);
    assert.equal(child.overflowed, false);
    assert.equal(child.code, 0);
    assert.equal(child.stdout.length + child.stderr.length, 0);
  } finally {
    cleanup(value.root);
  }
});

test('fixed layout rejects wrong-owner derived directories but keeps trusted root aliases exempt', {
  timeout: 60_000,
  concurrency: false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-watch-layout-owner-'));
  const real = join(root, 'real');
  const alias = join(root, 'alias');
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, alias, 'dir');
  const database = join(alias, 'watch', 'v1', 'jobs.sqlite');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  try {
    const initial = prepareFixedLayout(database, alias);
    const jobs = dirname(initial.workspacePath(JOB));
    await withMismatchedGetuid(0, async () => {
      assert.throws(
        () => prepareFixedLayout(database, alias),
        (error: unknown) =>
          error instanceof StoreError && error.code === 'PATH_UNSAFE',
      );
    });
    assert.equal(existsSync(jobs), false);
    const safe = prepareFixedLayout(database, alias);
    assert.ok(safe.databasePath.startsWith(realpathSync(real)));
  } finally {
    cleanup(root);
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(process, 'getuid'),
    descriptor,
  );
});

test('real UID comparisons reject directory and artifact owner mismatches with redacted reporting', {
  timeout: 60_000,
  concurrency: false,
}, async () => {
  const pathSentinel = 'PRIVATE_PATH_DOMAIN_SENTINEL';
  const root = mkdtempSync(join(tmpdir(), `${pathSentinel}-`));
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  try {
    const layout = prepareFixedLayout(
      join(root, 'watch', 'v1', 'jobs.sqlite'),
      root,
    );
    writeFileSync(layout.databasePath, '', { mode: 0o600 });
    let diagnostic = '';
    await withMismatchedGetuid(0, async () => {
      assert.throws(
        () => prepareCaptureWorkspace(layout, JOB),
        (error: unknown) => {
          diagnostic = JSON.stringify(toDiagnostic(error));
          return error instanceof StoreError && error.code === 'PATH_UNSAFE';
        },
      );
    });
    assertRedacted([diagnostic], [pathSentinel]);

    const workspace = prepareCaptureWorkspace(layout, JOB);
    await withMismatchedGetuid(1, async () => {
      const capture = createOutputCapture(workspace, 'stdout');
      capture.accept(Buffer.from('owner-check'));
      const result = await capture.seal({ source: 'eof' });
      assert.equal(result.available, false);
      assert.equal(result.incomplete, true);
    });
  } finally {
    cleanup(root);
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(process, 'getuid'),
    originalDescriptor,
  );
});

test('fixed layout canonicalizes a root alias, requires lowercase UUIDs, and accepts safe jobs EEXIST', {
  timeout: 60_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-watch-layout-root-'));
  const real = join(root, 'real');
  const alias = join(root, 'alias');
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, alias, 'dir');
  try {
    const layout = prepareFixedLayout(
      join(alias, 'watch', 'v1', 'jobs.sqlite'),
      alias,
    );
    assert.ok(layout.databasePath.startsWith(realpathSync(real)));
    assert.throws(
      () => layout.workspacePath(JOB.toUpperCase()),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'PATH_UNSAFE',
    );
    mkdirSync(dirname(layout.workspacePath(JOB)), { mode: 0o700 });
    const workspace = prepareCaptureWorkspace(layout, JOB);
    assert.equal(workspace.verify(), true);
  } finally {
    cleanup(root);
  }
});

test('replaced raw, workspace, and parent artifacts are never trusted as evidence', {
  timeout: 60_000,
}, async () => {
  for (const replacementKind of [
    'raw',
    'hardlink',
    'workspace',
    'parent',
  ] as const) {
    const { root, workspace } = fixture();
    try {
      const capture = createOutputCapture(workspace, 'stdout');
      capture.accept(Buffer.from('trusted-prefix'));
      if (replacementKind === 'raw') {
        const replacement = join(workspace.directory, 'replacement');
        writeFileSync(replacement, 'replacement', { mode: 0o600 });
        renameSync(replacement, workspace.paths('stdout').raw);
      } else if (replacementKind === 'hardlink') {
        linkSync(
          workspace.paths('stdout').raw,
          join(workspace.directory, 'unexpected-link'),
        );
      } else if (replacementKind === 'workspace') {
        renameSync(workspace.directory, `${workspace.directory}-original`);
        mkdirSync(workspace.directory, { mode: 0o700 });
      } else {
        const jobs = dirname(workspace.directory);
        renameSync(jobs, `${jobs}-original`);
        mkdirSync(jobs, { mode: 0o700 });
        mkdirSync(workspace.directory, { mode: 0o700 });
      }
      const result = await capture.seal({ source: 'eof' });
      assert.equal(result.available, false);
      assert.equal(result.incomplete, true);
      assert.equal(inspectClosureReceipt(workspace, 'stdout'), null);
    } finally {
      cleanup(root);
    }
  }
});

test('ordered capture failures keep unaffected stream usable and shutdown finite', {
  timeout: 60_000,
}, async () => {
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
    await withTestFault(`stdout:${stage}`, async () => {
      const { root, workspace } = fixture();
      try {
        const stdout = createOutputCapture(workspace, 'stdout');
        const stderr = createOutputCapture(workspace, 'stderr');
        stdout.accept(
          stage.startsWith('marker-')
            ? Buffer.alloc(OUTPUT_CAPTURE_LIMIT + 1, 0x61)
            : Buffer.from('first-stream'),
        );
        stderr.accept(Buffer.from('second-stream'));
        const [failed, usable] = await Promise.all([
          stdout.seal({ source: 'cutover' }),
          stderr.seal({ source: 'eof' }),
        ]);
        assert.equal(
          failed.available,
          stage === 'raw-write',
          `${stage} availability`,
        );
        assert.equal(failed.incomplete, true, `${stage} incompleteness`);
        assert.equal(usable.available, true, `${stage} stderr availability`);
        assert.equal(usable.incomplete, false, `${stage} stderr completeness`);
        assertRedactedEqual(
          readFileSync(workspace.paths('stderr').raw),
          'second-stream',
        );
      } finally {
        cleanup(root);
      }
    });
  }
});

test('terminal publication follows durable coherent capture artifacts', {
  timeout: 60_000,
}, async () => {
  const { root, workspace } = fixture();
  try {
    const capture = createOutputCapture(workspace, 'stdout');
    capture.accept(Buffer.from('sealed'));
    const result = await capture.seal({ source: 'eof' });
    const receipt = inspectClosureReceipt(workspace, 'stdout');
    assert.equal(result.available, true);
    assert.deepEqual(receipt, result.receipt);
    assert.equal(
      statSync(workspace.paths('stdout').closed).mode & 0o7777,
      0o600,
    );
    assert.equal(statSync(workspace.directory).mode & 0o7777, 0o700);
  } finally {
    cleanup(root);
  }
});

test('closure receipts reject duplicate unknown trailing and noncanonical data', {
  timeout: 60_000,
}, async () => {
  const mutations = [
    (value: string) => `${value} `,
    (value: string) =>
      value.replace('{"version":1', '{"version":1,"version":1'),
    (value: string) => value.replace(',"stream"', ',"unknown":0,"stream"'),
    (value: string) => JSON.stringify(JSON.parse(value), null, 2),
    () => 'x'.repeat(513),
  ];
  for (const mutate of mutations) {
    const { root, workspace } = fixture();
    try {
      const capture = createOutputCapture(workspace, 'stdout');
      capture.accept(Buffer.from('receipt-prefix'));
      const result = await capture.seal({ source: 'eof' });
      assert.equal(result.available, true);
      const path = workspace.paths('stdout').closed;
      writeFileSync(path, mutate(readFileSync(path, 'utf8')), { flag: 'w' });
      assert.equal(inspectClosureReceipt(workspace, 'stdout'), null);
    } finally {
      cleanup(root);
    }
  }
});

test('artifact crash states never invent a final result', {
  timeout: 60_000,
}, () => {
  const { root, workspace } = fixture();
  try {
    writeFileSync(workspace.paths('stdout').raw, 'partial', {
      mode: 0o600,
      flag: 'wx',
    });
    assert.equal(inspectClosureReceipt(workspace, 'stdout'), null);
    writeFileSync(workspace.paths('stdout').closedTemporary, '{"version":1}', {
      mode: 0o600,
      flag: 'wx',
    });
    assert.equal(inspectClosureReceipt(workspace, 'stdout'), null);
  } finally {
    cleanup(root);
  }
});

const activeObservation: OutputObservation = {
  jobId: JOB,
  finalized: false,
  capture: {
    available: null,
    truncated: false,
    incomplete: false,
    openAtCutover: false,
  },
};

function finalizedObservation(
  overrides: Partial<OutputObservation['capture']> = {},
): OutputObservation {
  return {
    jobId: JOB,
    finalized: true,
    capture: {
      available: true,
      truncated: false,
      incomplete: false,
      openAtCutover: false,
      ...overrides,
    },
  };
}

async function sealedFixture(
  bytes: Uint8Array,
  stream: 'stdout' | 'stderr' = 'stdout',
): Promise<ReturnType<typeof fixture>> {
  const value = fixture();
  const capture = createOutputCapture(value.workspace, stream);
  capture.accept(bytes);
  const result = await capture.seal({ source: 'eof' });
  assert.equal(result.available, true);
  return value;
}

function successData(
  envelope: ReturnType<typeof readOutputSnapshot>,
): Extract<typeof envelope, { ok: true }>['data'] {
  assert.equal(envelope.ok, true);
  if (!envelope.ok) throw new Error('expected success envelope');
  return envelope.data;
}

function assertError(
  envelope: ReturnType<typeof readOutputSnapshot>,
  code: string,
): void {
  assert.equal(envelope.ok, false);
  if (envelope.ok) throw new Error('expected error envelope');
  assert.equal(envelope.error.code, code);
  assert.ok(
    Buffer.byteLength(JSON.stringify(envelope)) <= OUTPUT_ENVELOPE_LIMIT,
  );
}

test('snapshot offsets cover empty end above min max fraction negative and non-number', {
  timeout: 60_000,
}, async () => {
  const empty = await sealedFixture(Buffer.alloc(0));
  try {
    const data = successData(
      readOutputSnapshot(empty.layout, finalizedObservation(), 'stdout', 0),
    );
    assertRedactedEqual(data.text, '');
    assert.equal(data.retainedBytes, 0);
    assert.equal(data.nextOffsetBytes, 0);
  } finally {
    cleanup(empty.root);
  }

  const { root, layout } = await sealedFixture(Buffer.from('abc'));
  try {
    const first = successData(
      readOutputSnapshot(layout, finalizedObservation(), 'stdout', 0),
    );
    assertRedactedEqual(first.text, 'abc');
    assert.deepEqual(
      { ...first, text: undefined },
      {
        stream: 'stdout',
        offsetBytes: 0,
        nextOffsetBytes: 3,
        retainedBytes: 3,
        hasMore: false,
        canGrow: false,
        available: true,
        truncated: false,
        incomplete: false,
        openAtCutover: false,
        text: undefined,
      },
    );
    assertRedactedEqual(
      successData(
        readOutputSnapshot(layout, finalizedObservation(), 'stdout', 3),
      ).text,
      '',
    );
    assertError(
      readOutputSnapshot(layout, finalizedObservation(), 'stdout', 4),
      'OFFSET_OUT_OF_RANGE',
    );
    assertError(
      readOutputSnapshot(layout, finalizedObservation(), 'stdout', -1),
      'INVALID_OFFSET',
    );
    assertError(
      readOutputSnapshot(layout, finalizedObservation(), 'stdout', 0.5),
      'INVALID_OFFSET',
    );
    assertError(
      readOutputSnapshot(layout, finalizedObservation(), 'stdout', Number.NaN),
      'INVALID_OFFSET',
    );
    assertError(
      readOutputSnapshot(layout, finalizedObservation(), 'stdout', '0'),
      'INVALID_OFFSET',
    );
    assertError(
      readOutputSnapshot(
        layout,
        finalizedObservation(),
        'stdout',
        OUTPUT_CAPTURE_LIMIT + 1,
      ),
      'INVALID_OFFSET',
    );
  } finally {
    cleanup(root);
  }
});

test('independent raw offsets resume without loss duplication or interleaving', {
  timeout: 60_000,
}, async () => {
  const value = fixture();
  try {
    for (const [stream, bytes] of [
      ['stdout', Buffer.from('out-α-out')] as const,
      ['stderr', Buffer.from('err-β-err')] as const,
    ]) {
      const capture = createOutputCapture(value.workspace, stream);
      capture.accept(bytes);
      assert.equal((await capture.seal({ source: 'eof' })).available, true);
    }
    const stdout = successData(
      readOutputSnapshot(value.layout, finalizedObservation(), 'stdout', 4),
    );
    const stderr = successData(
      readOutputSnapshot(value.layout, finalizedObservation(), 'stderr', 0),
    );
    assertRedactedEqual(stdout.text, 'α-out');
    assert.equal(stdout.nextOffsetBytes, Buffer.byteLength('out-α-out'));
    assertRedactedEqual(stderr.text, 'err-β-err');
    assert.equal(stderr.nextOffsetBytes, Buffer.byteLength('err-β-err'));
  } finally {
    cleanup(value.root);
  }
});

test('mid-sequence and malformed UTF-8 preserve raw offset accounting', {
  timeout: 60_000,
}, async () => {
  const bytes = Buffer.from([
    0x61, 0xc2, 0xa2, 0xe2, 0x82, 0xac, 0xf0, 0x90, 0x8d, 0x88, 0x80, 0xc0,
    0xe2, 0x28, 0xa1,
  ]);
  const { root, layout } = await sealedFixture(bytes);
  try {
    const whole = successData(
      readOutputSnapshot(layout, finalizedObservation(), 'stdout', 0),
    );
    assertRedactedEqual(whole.text, 'a¢€𐍈���(�');
    assert.equal(whole.nextOffsetBytes, bytes.length);
    for (const offset of [2, 4, 5, 7, 8, 9]) {
      const page = successData(
        readOutputSnapshot(layout, finalizedObservation(), 'stdout', offset),
      );
      assert.ok(page.text.startsWith('�'));
      assert.equal(page.nextOffsetBytes, bytes.length);
    }
  } finally {
    cleanup(root);
  }
});

test('server-selected byte ends never split complete one-to-four-byte scalars', {
  timeout: 60_000,
}, async () => {
  const baselineBytes = Buffer.alloc(60_000, 0x61);
  const baseline = await sealedFixture(baselineBytes);
  let boundary: number;
  try {
    boundary = successData(
      readOutputSnapshot(baseline.layout, finalizedObservation(), 'stdout', 0),
    ).nextOffsetBytes;
  } finally {
    cleanup(baseline.root);
  }

  for (const scalar of ['z', '¢', '€', '𐍈']) {
    const input = Buffer.concat([
      Buffer.alloc(boundary - 1, 0x61),
      Buffer.from(scalar),
      Buffer.alloc(32, 0x62),
    ]);
    const value = await sealedFixture(input);
    try {
      const page = successData(
        readOutputSnapshot(value.layout, finalizedObservation(), 'stdout', 0),
      );
      const scalarStart = boundary - 1;
      const scalarEnd = scalarStart + Buffer.byteLength(scalar);
      assert.ok(
        page.nextOffsetBytes <= scalarStart ||
          page.nextOffsetBytes >= scalarEnd,
      );
      assert.equal(page.text.endsWith('�'), false);
    } finally {
      cleanup(value.root);
    }
  }
});

test('growing and closed incomplete UTF-8 tails diverge correctly', {
  timeout: 60_000,
}, () => {
  const { root, layout, workspace } = fixture();
  try {
    writeFileSync(workspace.paths('stdout').raw, Buffer.from([0xe2, 0x82]), {
      mode: 0o600,
      flag: 'wx',
    });
    const growing = successData(
      readOutputSnapshot(layout, activeObservation, 'stdout', 0),
    );
    assertRedactedEqual(growing.text, '');
    assert.equal(growing.nextOffsetBytes, 0);
    assert.equal(growing.hasMore, true);
    assert.equal(growing.canGrow, true);
    appendFileSync(workspace.paths('stdout').raw, Buffer.from([0xac]));
    const complete = successData(
      readOutputSnapshot(
        layout,
        activeObservation,
        'stdout',
        growing.nextOffsetBytes,
      ),
    );
    assertRedactedEqual(complete.text, '€');
    assert.equal(complete.nextOffsetBytes, 3);

    const closed = fixture();
    try {
      writeFileSync(
        closed.workspace.paths('stdout').raw,
        Buffer.from([0xe2, 0x82]),
        { mode: 0o600, flag: 'wx' },
      );
      const stat = statSync(closed.workspace.paths('stdout').raw);
      writeFileSync(
        closed.workspace.paths('stdout').closed,
        JSON.stringify({
          version: 1,
          stream: 'stdout',
          retainedBytes: 2,
          truncated: false,
          incomplete: true,
          openAtCutover: true,
          reason: 'cutover',
          rawDev: stat.dev,
          rawIno: stat.ino,
        }),
        { mode: 0o600, flag: 'wx' },
      );
      const ended = successData(
        readOutputSnapshot(
          closed.layout,
          finalizedObservation({ incomplete: true, openAtCutover: true }),
          'stdout',
          0,
        ),
      );
      assertRedactedEqual(ended.text, '�');
      assert.equal(ended.nextOffsetBytes, 2);
      assert.equal(ended.canGrow, false);
    } finally {
      cleanup(closed.root);
    }
  } finally {
    cleanup(root);
  }
});

test('output pages preserve LF and tab but contain no disallowed terminal controls', {
  timeout: 60_000,
}, async () => {
  const bytes = Buffer.from([
    0x00, 0x08, 0x09, 0x0a, 0x0d, 0x1b, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x1f,
    0x20, 0x7e, 0x7f, 0xc2, 0x80, 0xc2, 0x9f, 0xc2, 0xa0, 0x22, 0x5c,
  ]);
  const { root, layout } = await sealedFixture(bytes);
  try {
    const page = successData(
      readOutputSnapshot(layout, finalizedObservation(), 'stdout', 0),
    );
    assertRedactedEqual(
      page.text,
      '\\x00\\x08\t\n\\r\\x1b\\x1b[31m\\x1f ~\\x7f\\x80\\x9f "\\',
    );
    assert.equal(
      [...page.text].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return (
          (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
          (code >= 0x7f && code <= 0x9f)
        );
      }),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('success envelope line and byte bounds are exact and resumable', {
  timeout: 60_000,
}, async () => {
  for (const bytes of [
    Buffer.from('x\n'.repeat(2_001)),
    Buffer.alloc(60_000, 0x61),
    Buffer.alloc(60_000, 0x5c),
  ]) {
    const { root, layout } = await sealedFixture(bytes);
    try {
      const first = readOutputSnapshot(
        layout,
        finalizedObservation(),
        'stdout',
        0,
      );
      const firstData = successData(first);
      assert.ok(
        Buffer.byteLength(JSON.stringify(first)) <= OUTPUT_ENVELOPE_LIMIT,
      );
      const lines =
        (firstData.text.match(/\n/g) ?? []).length +
        (firstData.text.length > 0 && !firstData.text.endsWith('\n') ? 1 : 0);
      assert.ok(lines <= 2_000);
      if (bytes[0] === 0x78) {
        assert.equal(lines, 2_000);
        assert.equal(firstData.nextOffsetBytes, 4_000);
      } else {
        if (bytes[0] === 0x61) {
          assert.equal(
            Buffer.byteLength(JSON.stringify(first)),
            OUTPUT_ENVELOPE_LIMIT,
          );
        }
        const nextToken = bytes[0] === 0x5c ? '\\' : 'a';
        const withOneMoreToken = {
          ...first,
          data: { ...firstData, text: `${firstData.text}${nextToken}` },
        };
        assert.ok(
          Buffer.byteLength(JSON.stringify(withOneMoreToken)) >
            OUTPUT_ENVELOPE_LIMIT,
        );
      }
      assert.equal(firstData.hasMore, true);
      let cursor = firstData.nextOffsetBytes;
      let pages = 1;
      while (cursor < bytes.length) {
        const next = successData(
          readOutputSnapshot(layout, finalizedObservation(), 'stdout', cursor),
        );
        assert.ok(next.nextOffsetBytes > cursor);
        cursor = next.nextOffsetBytes;
        pages += 1;
      }
      assert.equal(cursor, bytes.length);
      assert.ok(pages >= 2);
    } finally {
      cleanup(root);
    }
  }
});

test('5 MiB snapshots request only one response window plus UTF-8 lookahead', {
  timeout: 60_000,
  concurrency: false,
}, async () => {
  const value = await sealedFixture(Buffer.alloc(OUTPUT_CAPTURE_LIMIT, 0x61));
  const descriptor = Object.getOwnPropertyDescriptor(fs, 'readSync');
  const originalReadSync = fs.readSync;
  const receiptBytes = statSync(value.workspace.paths('stdout').closed).size;
  let maximumRequested = 0;
  let requestedBytes = 0;
  let returnedBytes = 0;
  let readCalls = 0;
  try {
    assert.notEqual(descriptor, undefined);
    Object.defineProperty(fs, 'readSync', {
      ...descriptor,
      value: (
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        maximumRequested = Math.max(maximumRequested, length);
        requestedBytes += length;
        readCalls += 1;
        const returned = originalReadSync(fd, buffer, offset, length, position);
        returnedBytes += returned;
        return returned;
      },
    });
    syncBuiltinESMExports();
    const envelope = readOutputSnapshot(
      value.layout,
      finalizedObservation(),
      'stdout',
      0,
    );
    const page = successData(envelope);
    assert.equal(maximumRequested, OUTPUT_ENVELOPE_LIMIT + 3);
    assert.equal(readCalls, 2);
    assert.equal(requestedBytes, OUTPUT_ENVELOPE_LIMIT + 3 + receiptBytes);
    assert.equal(returnedBytes, OUTPUT_ENVELOPE_LIMIT + 3 + receiptBytes);
    assert.ok(page.nextOffsetBytes < OUTPUT_CAPTURE_LIMIT);
    assert.ok(
      Buffer.byteLength(JSON.stringify(envelope)) <= OUTPUT_ENVELOPE_LIMIT,
    );
  } finally {
    if (descriptor !== undefined)
      Object.defineProperty(fs, 'readSync', descriptor);
    syncBuiltinESMExports();
    cleanup(value.root);
  }
});

test('nonfinal exact below-cap capture-error receipt is coherent', {
  timeout: 60_000,
}, async () => {
  await withTestFault('short-write:17:fail-after:34', async () => {
    const value = fixture();
    try {
      const capture = createOutputCapture(value.workspace, 'stdout');
      capture.accept(Buffer.alloc(OUTPUT_CAPTURE_LIMIT + 1, 0x61));
      assert.equal((await capture.seal({ source: 'eof' })).available, true);
      const page = successData(
        readOutputSnapshot(value.layout, activeObservation, 'stdout', 0),
      );
      assert.equal(page.retainedBytes, 34);
      assert.equal(page.truncated, true);
      assert.equal(page.incomplete, true);
      assert.equal(page.canGrow, false);
      assertRedactedEqual(page.text, 'a'.repeat(34));
    } finally {
      cleanup(value.root);
    }
  });
});

test('below-cap marker without an exact receipt is future evidence only while growth is permitted', {
  timeout: 60_000,
}, () => {
  const growing = fixture();
  try {
    writeFileSync(growing.workspace.paths('stdout').raw, 'abc', {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(growing.workspace.paths('stdout').truncated, '', {
      mode: 0o600,
      flag: 'wx',
    });
    const page = successData(
      readOutputSnapshot(growing.layout, activeObservation, 'stdout', 0),
    );
    assert.equal(page.retainedBytes, 3);
    assert.equal(page.truncated, false);
    assert.equal(page.canGrow, true);
    assertRedactedEqual(page.text, 'abc');
  } finally {
    cleanup(growing.root);
  }

  for (const observation of [
    finalizedObservation({ truncated: true, incomplete: true }),
    {
      ...activeObservation,
      capture: { ...activeObservation.capture, incomplete: true },
    },
  ]) {
    const noGrowth = fixture();
    try {
      writeFileSync(noGrowth.workspace.paths('stdout').raw, 'abc', {
        mode: 0o600,
        flag: 'wx',
      });
      writeFileSync(noGrowth.workspace.paths('stdout').truncated, '', {
        mode: 0o600,
        flag: 'wx',
      });
      assertError(
        readOutputSnapshot(noGrowth.layout, observation, 'stdout', 0),
        'CAPTURE_CORRUPT',
      );
    } finally {
      cleanup(noGrowth.root);
    }
  }
});

test('EOF and cutover receipts cannot claim truncation below the cap', {
  timeout: 60_000,
}, () => {
  for (const receipt of [
    {
      version: 1,
      stream: 'stdout',
      retainedBytes: 34,
      truncated: true,
      incomplete: false,
      openAtCutover: false,
      reason: 'eof',
      rawDev: 1,
      rawIno: 1,
    },
    {
      version: 1,
      stream: 'stdout',
      retainedBytes: 34,
      truncated: true,
      incomplete: true,
      openAtCutover: true,
      reason: 'cutover',
      rawDev: 1,
      rawIno: 1,
    },
  ]) {
    assert.equal(
      parseClosureReceipt(Buffer.from(JSON.stringify(receipt)), 'stdout'),
      null,
    );
  }
});

test('marker publication between marker and receipt observations reloads once', {
  timeout: 60_000,
  concurrency: false,
}, () => {
  const value = fixture();
  const descriptor = Object.getOwnPropertyDescriptor(fs, 'lstatSync');
  const originalLstatSync = fs.lstatSync;
  let published = false;
  try {
    writeFileSync(
      value.workspace.paths('stdout').raw,
      Buffer.alloc(OUTPUT_CAPTURE_LIMIT, 0x61),
      { mode: 0o600, flag: 'wx' },
    );
    const raw = statSync(value.workspace.paths('stdout').raw);
    Object.defineProperty(fs, 'lstatSync', {
      ...descriptor,
      value: (path: fs.PathLike) => {
        if (path === value.workspace.paths('stdout').closed && !published) {
          published = true;
          writeFileSync(value.workspace.paths('stdout').truncated, '', {
            mode: 0o600,
            flag: 'wx',
          });
          writeFileSync(
            value.workspace.paths('stdout').closed,
            JSON.stringify({
              version: 1,
              stream: 'stdout',
              retainedBytes: OUTPUT_CAPTURE_LIMIT,
              truncated: true,
              incomplete: false,
              openAtCutover: false,
              reason: 'eof',
              rawDev: raw.dev,
              rawIno: raw.ino,
            }),
            { mode: 0o600, flag: 'wx' },
          );
        }
        return originalLstatSync(path);
      },
    });
    syncBuiltinESMExports();
    const envelope = readOutputSnapshot(
      value.layout,
      finalizedObservation({ truncated: true }),
      'stdout',
      0,
    );
    const page = successData(envelope);
    assert.equal(published, true);
    assert.equal(page.truncated, true);
  } finally {
    if (descriptor !== undefined)
      Object.defineProperty(fs, 'lstatSync', descriptor);
    syncBuiltinESMExports();
    cleanup(value.root);
  }

  const incoherent = fixture();
  try {
    writeFileSync(
      incoherent.workspace.paths('stdout').raw,
      Buffer.alloc(OUTPUT_CAPTURE_LIMIT, 0x61),
      { mode: 0o600, flag: 'wx' },
    );
    const raw = statSync(incoherent.workspace.paths('stdout').raw);
    writeFileSync(
      incoherent.workspace.paths('stdout').closed,
      JSON.stringify({
        version: 1,
        stream: 'stdout',
        retainedBytes: OUTPUT_CAPTURE_LIMIT,
        truncated: true,
        incomplete: false,
        openAtCutover: false,
        reason: 'eof',
        rawDev: raw.dev,
        rawIno: raw.ino,
      }),
      { mode: 0o600, flag: 'wx' },
    );
    assertError(
      readOutputSnapshot(
        incoherent.layout,
        finalizedObservation({ truncated: true }),
        'stdout',
        0,
      ),
      'CAPTURE_CORRUPT',
    );
  } finally {
    cleanup(incoherent.root);
  }
});

test('known unavailable and unexpectedly absent captures have distinct envelopes', {
  timeout: 60_000,
}, () => {
  const value = fixture();
  try {
    const unavailable = finalizedObservation({
      available: false,
      incomplete: true,
    });
    const page = successData(
      readOutputSnapshot(value.layout, unavailable, 'stdout', 0),
    );
    assertRedactedEqual(page.text, '');
    assert.deepEqual(
      { ...page, text: undefined },
      {
        stream: 'stdout',
        offsetBytes: 0,
        nextOffsetBytes: 0,
        retainedBytes: 0,
        hasMore: false,
        canGrow: false,
        available: false,
        truncated: false,
        incomplete: true,
        openAtCutover: false,
        text: undefined,
      },
    );
    assertError(
      readOutputSnapshot(value.layout, unavailable, 'stdout', 1),
      'OFFSET_OUT_OF_RANGE',
    );
    assertError(
      readOutputSnapshot(value.layout, activeObservation, 'stdout', 0),
      'CAPTURE_UNAVAILABLE',
    );
  } finally {
    cleanup(value.root);
  }
});

test('every W4 error envelope is fixed, complete, and serialized within bounds', {
  timeout: 60_000,
  concurrency: false,
}, async () => {
  const missing = fixture();
  const oversized = fixture();
  const readFailure = await sealedFixture(Buffer.alloc(60_000, 0x61));
  const descriptor = Object.getOwnPropertyDescriptor(fs, 'readSync');
  const originalReadSync = fs.readSync;
  try {
    writeFileSync(oversized.workspace.paths('stdout').raw, '', {
      mode: 0o600,
      flag: 'wx',
    });
    truncateSync(
      oversized.workspace.paths('stdout').raw,
      OUTPUT_CAPTURE_LIMIT + 1,
    );
    const envelopes: ReturnType<typeof readOutputSnapshot>[] = [
      readOutputSnapshot(missing.layout, activeObservation, 'stdout', -1),
      readOutputSnapshot(
        missing.layout,
        finalizedObservation({ available: false }),
        'stdout',
        1,
      ),
      readOutputSnapshot(missing.layout, activeObservation, 'stdout', 0),
      readOutputSnapshot(oversized.layout, activeObservation, 'stdout', 0),
    ];

    Object.defineProperty(fs, 'readSync', {
      ...descriptor,
      value: (
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        if (length > 512) throw new Error('synthetic private read failure');
        return originalReadSync(fd, buffer, offset, length, position);
      },
    });
    syncBuiltinESMExports();
    envelopes.push(
      readOutputSnapshot(
        readFailure.layout,
        finalizedObservation(),
        'stdout',
        0,
      ),
    );

    const codes: string[] = [];
    for (const envelope of envelopes) {
      assert.equal(envelope.ok, false);
      if (envelope.ok) continue;
      codes.push(envelope.error.code);
      assert.deepEqual(Object.keys(envelope).sort(), [
        'error',
        'ok',
        'schemaVersion',
      ]);
      assert.deepEqual(Object.keys(envelope.error).sort(), ['code', 'message']);
      assert.ok(
        Buffer.byteLength(JSON.stringify(envelope)) <= OUTPUT_ENVELOPE_LIMIT,
      );
    }
    assert.deepEqual(codes.sort(), [
      'CAPTURE_CORRUPT',
      'CAPTURE_UNAVAILABLE',
      'INVALID_OFFSET',
      'OFFSET_OUT_OF_RANGE',
      'OUTPUT_READ_FAILED',
    ]);
  } finally {
    if (descriptor !== undefined)
      Object.defineProperty(fs, 'readSync', descriptor);
    syncBuiltinESMExports();
    cleanup(missing.root);
    cleanup(oversized.root);
    cleanup(readFailure.root);
  }
});

test('oversized or malformed private artifacts are rejected within read ceilings', {
  timeout: 60_000,
}, async () => {
  const oversized = fixture();
  try {
    writeFileSync(oversized.workspace.paths('stdout').raw, '', {
      mode: 0o600,
      flag: 'wx',
    });
    truncateSync(
      oversized.workspace.paths('stdout').raw,
      OUTPUT_CAPTURE_LIMIT + 1,
    );
    assertError(
      readOutputSnapshot(oversized.layout, activeObservation, 'stdout', 0),
      'CAPTURE_CORRUPT',
    );
  } finally {
    cleanup(oversized.root);
  }

  const receiptMutations = [
    (_value: string) => 'x'.repeat(513),
    (value: string) => `${value} `,
    (value: string) =>
      value.replace('{"version":1', '{"version":1,"version":1'),
    (value: string) => value.replace(',"stream"', ',"unknown":0,"stream"'),
    (value: string) => value.replace('"retainedBytes":7', '"retainedBytes":6'),
    (value: string) => value.replace('"retainedBytes":7', '"retainedBytes":-1'),
    (value: string) =>
      value.replace('"retainedBytes":7', '"retainedBytes":5242881'),
    (value: string) => {
      const receipt = JSON.parse(value) as { rawDev: number };
      receipt.rawDev += 1;
      return JSON.stringify(receipt);
    },
    (value: string) => {
      const receipt = JSON.parse(value) as { rawIno: number };
      receipt.rawIno += 1;
      return JSON.stringify(receipt);
    },
  ];
  for (const mutate of receiptMutations) {
    const malformed = await sealedFixture(Buffer.from('receipt'));
    try {
      const path = malformed.workspace.paths('stdout').closed;
      writeFileSync(path, mutate(readFileSync(path, 'utf8')), { flag: 'w' });
      assertError(
        readOutputSnapshot(
          malformed.layout,
          finalizedObservation(),
          'stdout',
          0,
        ),
        'CAPTURE_CORRUPT',
      );
    } finally {
      cleanup(malformed.root);
    }
  }

  const marker = fixture();
  try {
    writeFileSync(marker.workspace.paths('stdout').raw, 'short', {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(marker.workspace.paths('stdout').truncated, 'not-empty', {
      mode: 0o600,
      flag: 'wx',
    });
    assertError(
      readOutputSnapshot(marker.layout, activeObservation, 'stdout', 0),
      'CAPTURE_CORRUPT',
    );
  } finally {
    cleanup(marker.root);
  }
});

test('snapshot receipt count races are conservative only while growth remains possible', {
  timeout: 60_000,
}, () => {
  for (const finalized of [false, true]) {
    const value = fixture();
    try {
      writeFileSync(value.workspace.paths('stdout').raw, 'abc', {
        mode: 0o600,
        flag: 'wx',
      });
      const stat = statSync(value.workspace.paths('stdout').raw);
      writeFileSync(
        value.workspace.paths('stdout').closed,
        JSON.stringify({
          version: 1,
          stream: 'stdout',
          retainedBytes: 4,
          truncated: false,
          incomplete: false,
          openAtCutover: false,
          reason: 'eof',
          rawDev: stat.dev,
          rawIno: stat.ino,
        }),
        { mode: 0o600, flag: 'wx' },
      );
      const page = readOutputSnapshot(
        value.layout,
        finalized ? finalizedObservation() : activeObservation,
        'stdout',
        0,
      );
      if (finalized) assertError(page, 'CAPTURE_CORRUPT');
      else {
        const data = successData(page);
        assertRedactedEqual(data.text, 'abc');
        assert.equal(data.canGrow, true);
      }
    } finally {
      cleanup(value.root);
    }
  }

  const below = fixture();
  try {
    writeFileSync(below.workspace.paths('stdout').raw, 'abc', {
      mode: 0o600,
      flag: 'wx',
    });
    const stat = statSync(below.workspace.paths('stdout').raw);
    writeFileSync(
      below.workspace.paths('stdout').closed,
      JSON.stringify({
        version: 1,
        stream: 'stdout',
        retainedBytes: 2,
        truncated: false,
        incomplete: false,
        openAtCutover: false,
        reason: 'eof',
        rawDev: stat.dev,
        rawIno: stat.ino,
      }),
      { mode: 0o600, flag: 'wx' },
    );
    assertError(
      readOutputSnapshot(below.layout, activeObservation, 'stdout', 0),
      'CAPTURE_CORRUPT',
    );
  } finally {
    cleanup(below.root);
  }
});

test('a deliberately failing child reporter never emits captured output', {
  timeout: 60_000,
}, async (context) => {
  const registry = useOwnedProcessRegistry(context);
  const sentinel = 'OUTPUT_REPORTER_SENTINEL_7f61b0d2';
  const value = await sealedFixture(Buffer.from(sentinel));
  const childTest = join(value.root, 'redacted-reporter.test.mjs');
  const reporterLog = join(value.root, 'redacted-reporter.log');
  try {
    writeFileSync(
      childTest,
      [
        "import assert from 'node:assert/strict';",
        "import {createHash} from 'node:crypto';",
        "import {test} from 'node:test';",
        'const {prepareFixedLayout}=await import(process.env.PRIVATE_PATH_MODULE);',
        'const {readOutputSnapshot}=await import(process.env.OUTPUT_MODULE);',
        "const digest=value=>createHash('sha256').update(value).digest('hex');",
        'const compare=(actual,expected)=>{const a=Buffer.from(actual);const e=Buffer.from(expected);let first=-1;for(let i=0;i<Math.min(a.length,e.length);i+=1){if(a[i]!==e[i]){first=i;break;}}if(first===-1&&a.length!==e.length)first=Math.min(a.length,e.length);return {actualBytes:a.length,expectedBytes:e.length,actualDigest:digest(a),expectedDigest:digest(e),firstDifference:first};};',
        "test('redacted child failure',{timeout:1000},()=>{",
        'const layout=prepareFixedLayout(process.env.DATABASE_PATH,process.env.TRUSTED_ROOT);',
        `const observation={jobId:'${JOB}',finalized:true,capture:{available:true,truncated:false,incomplete:false,openAtCutover:false}};`,
        "const envelope=readOutputSnapshot(layout,observation,'stdout',0);",
        "const text=envelope.ok?envelope.data.text:'';",
        "const expected='reporter-expected';",
        'assert.deepEqual(compare(text,expected),compare(expected,expected));',
        '});',
      ].join('\n'),
      { mode: 0o600 },
    );
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PRIVATE_PATH_MODULE: new URL('../src/private-path.ts', import.meta.url)
        .href,
      OUTPUT_MODULE: new URL('../src/output.ts', import.meta.url).href,
      DATABASE_PATH: value.layout.databasePath,
      TRUSTED_ROOT: value.root,
    };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = await registry.run(
      process.execPath,
      ['--test', '--test-timeout=5000', childTest],
      { timeoutMs: 10_000, detached: true, env: childEnv },
    );
    assert.equal(result.timedOut, false);
    assert.equal(result.overflowed, false);
    assert.equal(result.code === 0, false);
    const surfaces = [
      result.stdout,
      result.stderr,
      result.errorStack,
      result.errorCause,
    ];
    writeFileSync(reporterLog, surfaces.join('\n'), { mode: 0o600 });
    assertRedacted(
      [...surfaces, readFileSync(reporterLog, 'utf8')],
      [sentinel],
    );
  } finally {
    cleanup(value.root);
  }
});

test('U1 failures redact captured output, private paths, and native errors', {
  timeout: 60_000,
}, async () => {
  const outputSentinel = 'OUTPUT_DOMAIN_SENTINEL';
  const pathSentinel = 'PRIVATE_PATH_DOMAIN_SENTINEL';
  const nativeSentinel = 'NATIVE_ERROR_DOMAIN_SENTINEL';
  const sentinels = [outputSentinel, pathSentinel, nativeSentinel];

  const privateRoot = mkdtempSync(join(tmpdir(), `${pathSentinel}-`));
  let pathDiagnostic = '';
  try {
    const layout = prepareFixedLayout(
      join(privateRoot, 'watch', 'v1', 'jobs.sqlite'),
      privateRoot,
    );
    writeFileSync(layout.databasePath, '', { mode: 0o600 });
    symlinkSync(privateRoot, dirname(layout.workspacePath(JOB)), 'dir');
    assert.throws(
      () => prepareCaptureWorkspace(layout, JOB),
      (error: unknown) => {
        pathDiagnostic = JSON.stringify(toDiagnostic(error));
        return error instanceof StoreError && error.code === 'PATH_UNSAFE';
      },
    );
  } finally {
    cleanup(privateRoot);
  }

  await withTestFault(`stdout:raw-write:${nativeSentinel}`, async () => {
    const { root, workspace } = fixture();
    try {
      const capture = createOutputCapture(workspace, 'stdout');
      capture.accept(Buffer.from(outputSentinel));
      const result = await capture.seal({ source: 'eof' });
      assert.equal(result.available, true);
      assert.equal(result.incomplete, true);
      const nativeDiagnostic = JSON.stringify(
        toDiagnostic(
          Object.assign(new Error(nativeSentinel), {
            path: join(root, pathSentinel),
          }),
        ),
      );
      assertRedacted(
        [JSON.stringify(result), pathDiagnostic, nativeDiagnostic],
        sentinels,
      );

      let assertionText = '';
      try {
        assertRedacted([sentinels.join(':')], sentinels);
      } catch (error) {
        assertionText = error instanceof Error ? error.message : String(error);
      }
      assert.equal(assertionText.length > 0, true);
      assert.equal(
        sentinels.some((sentinel) => assertionText.includes(sentinel)),
        false,
      );
    } finally {
      cleanup(root);
    }
  });
});
