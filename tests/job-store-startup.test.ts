import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  checkRuntimeSupport,
  createJobStore,
  type JobStore,
  type ReservationInput,
} from '../src/job-store.ts';
import { StoreError, toDiagnostic } from '../src/job-types.ts';

const OWNER = '11111111-2222-4333-8444-555555555555';

const runtimeOk = (() => {
  try {
    checkRuntimeSupport();
    return true;
  } catch {
    return false;
  }
})();
const runtimeSkip = runtimeOk
  ? false
  : 'requires Node 26 with linked SQLite >= 3.51.3';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function databasePath(dir: string): string {
  return join(dir, 'watch', 'v1', 'jobs.sqlite');
}

function input(requestKey = 'call-1'): ReservationInput {
  return {
    ownerUuid: OWNER,
    sessionPath: '/sessions/owner-session.jsonl',
    namespace: 'tool_call',
    requestKey,
    command: 'echo hello',
    cwd: '/tmp/base',
  };
}

function openStore(dir: string): JobStore {
  return createJobStore(databasePath(dir), { trustedRoot: dir });
}

function prepareCompleteStore(dir: string): void {
  const store = openStore(dir);
  try {
    assert.equal(store.reserve(input()).created, true);
  } finally {
    store.close();
  }
  const database = new DatabaseSync(databasePath(dir));
  try {
    const checkpoint = database
      .prepare('PRAGMA wal_checkpoint(TRUNCATE)')
      .get() as { busy?: number; log?: number; checkpointed?: number };
    assert.equal(checkpoint.busy, 0);
    assert.equal(checkpoint.log, 0);
  } finally {
    database.close();
  }
  assert.equal(statSync(databasePath(dir)).mode & 0o777, 0o600);
}

function logicalSnapshot(databasePathValue: string): {
  schema: unknown[];
  metadata: unknown[];
  jobs: unknown[];
} {
  const database = new DatabaseSync(databasePathValue, { readOnly: true });
  try {
    return {
      schema: database
        .prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql',
        )
        .all(),
      metadata: database
        .prepare('SELECT key, value FROM meta ORDER BY key')
        .all(),
      jobs: database
        .prepare(
          'SELECT owner_uuid, request_key, command, cwd, state FROM jobs ORDER BY request_key',
        )
        .all(),
    };
  } finally {
    database.close();
  }
}

function checkpointedMainVersion(
  databasePathValue: string,
  dir: string,
): string {
  const copy = join(dir, 'main-only.sqlite');
  copyFileSync(databasePathValue, copy);
  const database = new DatabaseSync(copy, { readOnly: true });
  try {
    return String(
      (
        database
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string }
      ).value,
    );
  } finally {
    database.close();
    rmSync(copy, { force: true });
  }
}

interface ActorReady {
  status: string;
  mode: string;
  walExists?: boolean;
  shmExists?: boolean;
  walBytes?: number;
}

interface ActorTerminal {
  code: number | null;
  signal: NodeJS.Signals | null;
  closeObserved: boolean;
  error?: Error;
}

interface ActorHandle {
  child: ChildProcess;
  ready: Promise<ActorReady>;
  terminal: Promise<ActorTerminal>;
  output: () => string;
}

type ActorSpawner = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcess;

function startActor(
  database: string,
  mode: 'newer' | 'compatible' | 'empty',
  holdMs = 30_000,
  spawnActor: ActorSpawner = spawn,
): ActorHandle {
  const child = spawnActor(
    process.execPath,
    [
      'tests/fixtures/schema-actor.ts',
      '--db',
      database,
      '--mode',
      mode,
      '--hold',
      String(holdMs),
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let lineBuffer = '';
  let readinessSettled = false;
  let terminalError: Error | undefined;
  let terminalSettled = false;
  let readyResolve: (value: ActorReady) => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  let terminalResolve: (value: ActorTerminal) => void = () => {};
  const ready = new Promise<ActorReady>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const terminal = new Promise<ActorTerminal>((resolve) => {
    terminalResolve = resolve;
  });
  void ready.catch(() => undefined);
  const appendOutput = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    output = `${output}${text}`.slice(-64 * 1024);
    lineBuffer = `${lineBuffer}${text}`.slice(-64 * 1024);
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line) as ActorReady;
        if (parsed.status === 'ready' && !readinessSettled) {
          readinessSettled = true;
          clearTimeout(readinessTimer);
          readyResolve(parsed);
        }
      } catch {
        // Ignore non-JSON fixture diagnostics while retaining bounded output.
      }
    }
  };
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  const readinessTimer = setTimeout(() => {
    if (!readinessSettled) {
      readinessSettled = true;
      readyReject(new Error(`schema actor readiness timeout: ${output}`));
      child.kill('SIGKILL');
    }
  }, 5_000);
  child.once('error', (error) => {
    terminalError = error;
    clearTimeout(readinessTimer);
    if (!readinessSettled) {
      readinessSettled = true;
      readyReject(error);
    }
  });
  child.once('close', (code, signal) => {
    clearTimeout(readinessTimer);
    if (!readinessSettled) {
      readinessSettled = true;
      readyReject(
        new Error(
          `schema actor closed before readiness: code=${code} signal=${signal} output=${output}`,
        ),
      );
    }
    if (!terminalSettled) {
      terminalSettled = true;
      const result: ActorTerminal = { code, signal, closeObserved: true };
      if (terminalError !== undefined) result.error = terminalError;
      terminalResolve(result);
    }
  });
  return { child, ready, terminal, output: () => output };
}

async function waitForActorTerminal(
  actor: ActorHandle,
  timeoutMs = 3_000,
): Promise<ActorTerminal> {
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const result = await Promise.race([
      actor.terminal,
      new Promise<ActorTerminal>((resolve) => {
        deadlineTimer = setTimeout(() => {
          timedOut = true;
          if (actor.child.exitCode === null && actor.child.signalCode === null)
            actor.child.kill('SIGKILL');
          resolve({
            code: null,
            signal: null,
            closeObserved: false,
            error: new Error('actor terminal deadline exceeded'),
          });
        }, timeoutMs);
      }),
    ]);
    if (!timedOut) return result;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reaped = await Promise.race([
        actor.terminal,
        new Promise<ActorTerminal>((_, reject) => {
          reapTimer = setTimeout(
            () => reject(new Error('actor cleanup deadline exceeded')),
            3_000,
          );
        }),
      ]);
      return reaped;
    } finally {
      if (reapTimer !== undefined) clearTimeout(reapTimer);
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

async function stopActor(actor: ActorHandle): Promise<ActorTerminal> {
  if (actor.child.exitCode === null && actor.child.signalCode === null)
    actor.child.kill('SIGKILL');
  const result = await waitForActorTerminal(actor);
  await actor.ready.catch(() => undefined);
  return result;
}

interface WriterAttempt {
  ok: boolean;
  errcode?: number;
  output: string;
  exit: number | null;
  signal: NodeJS.Signals | null;
  error: string | undefined;
}

function runIndependentVersionWriter(database: string): WriterAttempt {
  const script = `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1], { timeout: 100 });
try { db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run(); console.log(JSON.stringify({ ok: true })); }
catch (error) { console.log(JSON.stringify({ ok: false, errcode: error.errcode })); }
finally { db.close(); }`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, database],
    { encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024 },
  );
  const output = child.stdout.trim();
  let parsed: { ok?: boolean; errcode?: number };
  try {
    parsed = JSON.parse(output) as { ok?: boolean; errcode?: number };
  } catch {
    parsed = {};
  }
  return parsed.errcode === undefined
    ? {
        ok: parsed.ok === true,
        output,
        exit: child.status,
        signal: child.signal,
        error: child.error?.message,
      }
    : {
        ok: parsed.ok === true,
        errcode: parsed.errcode,
        output,
        exit: child.status,
        signal: child.signal,
        error: child.error?.message,
      };
}

function expectTooNew(operation: () => unknown, forbiddenPath?: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, 'SCHEMA_TOO_NEW');
    assert.match(error.message, /update pi-watch/);
    const diagnostic = JSON.stringify(toDiagnostic(error));
    assert.ok(!diagnostic.includes('/tmp/'));
    if (forbiddenPath !== undefined)
      assert.ok(!diagnostic.includes(forbiddenPath));
    return true;
  });
}

function assertSubprocessCompleted(attempt: WriterAttempt): void {
  assert.equal(attempt.exit, 0, attempt.output);
  assert.equal(attempt.signal, null, attempt.output);
  assert.equal(attempt.error, undefined, attempt.output);
  assert.match(attempt.output, /^\{"ok":(true|false)(,"errcode":\d+)?\}$/);
}

function assertBusyWrite(attempt: WriterAttempt, point: string): void {
  assertSubprocessCompleted(attempt);
  assert.equal(attempt.ok, false, point);
  assert.equal(attempt.errcode, 5, `${point}: ${attempt.output}`);
}

test('W3 WAL newer live fixture witnesses main v1 and WAL v999 before refusal', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-w3-wal-live-newer-');
  const database = databasePath(dir);
  prepareCompleteStore(dir);
  const actor = startActor(database, 'newer');
  try {
    const ready = await actor.ready;
    assert.equal(ready.walExists, true);
    assert.equal(ready.shmExists, true);
    assert.ok((ready.walBytes ?? 0) > 0);
    assert.ok(existsSync(`${database}-wal`));
    assert.ok(existsSync(`${database}-shm`));
    assert.ok(statSync(`${database}-wal`).size > 0);
    assert.equal(checkpointedMainVersion(database, dir), '1');
    const normal = new DatabaseSync(database, { readOnly: true });
    const liveVersion = (
      normal
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string }
    ).value;
    normal.close();
    assert.equal(liveVersion, '999');
    const before = logicalSnapshot(database);
    expectTooNew(() => openStore(dir), dir);
    assert.deepEqual(logicalSnapshot(database), before);
  } finally {
    let terminal: ActorTerminal | undefined;
    try {
      terminal = await stopActor(actor);
      assert.equal(terminal.signal, 'SIGKILL');
    } finally {
      if (terminal?.closeObserved)
        rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('W3 compatible live WAL remains usable with retained WAL and SHM', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-w3-wal-live-compatible-');
  const database = databasePath(dir);
  prepareCompleteStore(dir);
  const actor = startActor(database, 'compatible');
  try {
    const ready = await actor.ready;
    assert.equal(ready.walExists, true);
    assert.equal(ready.shmExists, true);
    assert.ok((ready.walBytes ?? 0) > 0);
    assert.ok(existsSync(`${database}-wal`));
    assert.ok(existsSync(`${database}-shm`));
    assert.ok(statSync(`${database}-wal`).size > 0);
    const reopened = openStore(dir);
    try {
      assert.equal(reopened.reserve(input('live-wal')).created, true);
    } finally {
      reopened.close();
    }
    assert.ok(existsSync(`${database}-wal`));
    assert.ok(existsSync(`${database}-shm`));
  } finally {
    let terminal: ActorTerminal | undefined;
    try {
      terminal = await stopActor(actor);
      assert.equal(terminal.signal, 'SIGKILL');
    } finally {
      if (terminal?.closeObserved)
        rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('W3 closed retained WAL supports compatible reopen and newer refusal', {
  skip: runtimeSkip,
}, async () => {
  for (const mode of ['compatible', 'newer'] as const) {
    const dir = tempDir(`u1-w3-wal-closed-${mode}-`);
    const database = databasePath(dir);
    prepareCompleteStore(dir);
    const actor = startActor(database, mode);
    let ready: ActorReady | undefined;
    let terminal: ActorTerminal | undefined;
    try {
      ready = await actor.ready;
      assert.equal(ready.walExists, true);
      assert.equal(ready.shmExists, true);
      assert.ok((ready.walBytes ?? 0) > 0);
      terminal = await stopActor(actor);
      assert.equal(terminal.closeObserved, true);
      assert.equal(actor.child.signalCode, 'SIGKILL');
      assert.ok(
        existsSync(`${database}-wal`),
        `${mode} WAL retained after reap`,
      );
      assert.ok(
        existsSync(`${database}-shm`),
        `${mode} SHM retained after reap`,
      );
      assert.ok(statSync(`${database}-wal`).size > 0);
      if (mode === 'newer') expectTooNew(() => openStore(dir), dir);
      else {
        const reopened = openStore(dir);
        try {
          assert.equal(reopened.reserve(input('closed-wal')).created, true);
        } finally {
          reopened.close();
        }
      }
    } finally {
      try {
        terminal = await stopActor(actor);
        assert.equal(terminal.signal, 'SIGKILL');
      } finally {
        if (terminal?.closeObserved)
          rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test('W3 missing SHM after owned fixture reap still reads committed newer WAL state', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-w3-wal-missing-shm-');
  const database = databasePath(dir);
  prepareCompleteStore(dir);
  const actor = startActor(database, 'newer');
  let terminal: ActorTerminal | undefined;
  try {
    const ready = await actor.ready;
    assert.equal(ready.walExists, true);
    assert.equal(ready.shmExists, true);
    assert.ok((ready.walBytes ?? 0) > 0);
    assert.ok(existsSync(`${database}-wal`));
    assert.ok(existsSync(`${database}-shm`));
    terminal = await stopActor(actor);
    assert.equal(terminal.closeObserved, true);
    assert.equal(actor.child.signalCode, 'SIGKILL');
    assert.equal(checkpointedMainVersion(database, dir), '1');
    rmSync(`${database}-shm`, { force: true });
    assert.equal(existsSync(`${database}-shm`), false);
    expectTooNew(() => openStore(dir), dir);
    const normal = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(
        (
          normal
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string }
        ).value,
        '999',
      );
    } finally {
      normal.close();
    }
  } finally {
    try {
      terminal = await stopActor(actor);
      assert.equal(terminal.signal, 'SIGKILL');
    } finally {
      if (terminal?.closeObserved)
        rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('W3 compatible missing SHM preserves committed WAL data after owned reap', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-w3-wal-missing-shm-compatible-');
  const database = databasePath(dir);
  prepareCompleteStore(dir);
  const actor = startActor(database, 'compatible');
  let terminal: ActorTerminal | undefined;
  try {
    const ready = await actor.ready;
    assert.equal(ready.walExists, true);
    assert.equal(ready.shmExists, true);
    assert.ok((ready.walBytes ?? 0) > 0);
    terminal = await stopActor(actor);
    assert.equal(terminal.closeObserved, true);
    assert.equal(actor.child.signalCode, 'SIGKILL');
    assert.ok(existsSync(`${database}-wal`));
    assert.ok(existsSync(`${database}-shm`));
    rmSync(`${database}-shm`, { force: true });
    assert.equal(existsSync(`${database}-shm`), false);
    const reopened = openStore(dir);
    try {
      assert.equal(
        reopened.reserve(input('missing-shm-compatible')).created,
        true,
      );
    } finally {
      reopened.close();
    }
    const verify = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(
        verify.prepare('PRAGMA user_version').get()?.user_version,
        7,
      );
      assert.equal(
        (
          verify.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
            count: number;
          }
        ).count,
        2,
      );
    } finally {
      verify.close();
    }
  } finally {
    try {
      terminal = await stopActor(actor);
      assert.equal(terminal.signal, 'SIGKILL');
    } finally {
      if (terminal?.closeObserved)
        rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('W3 missing, zero-byte and EEXIST entry all inspect RO before RW handoff', {
  skip: runtimeSkip,
}, async (t) => {
  const observeEntry = (dir: string): void => {
    const events: string[] = [];
    const originalExec = DatabaseSync.prototype.exec;
    t.mock.method(
      DatabaseSync.prototype,
      'exec',
      function (this: DatabaseSync, sql: string): void {
        if (sql === 'BEGIN DEFERRED') events.push('ro-begin');
        if (sql === 'BEGIN IMMEDIATE') {
          assert.ok(events.includes('ro-begin'));
          events.push('rw-begin');
        }
        originalExec.call(this, sql);
      },
    );
    syncBuiltinESMExports();
    try {
      const store = openStore(dir);
      store.close();
      assert.equal(events[0], 'ro-begin');
      assert.ok(events.includes('rw-begin'));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  };

  const missing = tempDir('u1-w3-entry-missing-');
  observeEntry(missing);
  rmSync(missing, { recursive: true, force: true });

  const zero = tempDir('u1-w3-entry-zero-');
  mkdirSync(join(zero, 'watch', 'v1'), { recursive: true, mode: 0o700 });
  writeFileSync(databasePath(zero), '', { mode: 0o600 });
  observeEntry(zero);
  rmSync(zero, { recursive: true, force: true });

  const eexist = tempDir('u1-w3-entry-eexist-');
  mkdirSync(join(eexist, 'watch', 'v1'), { recursive: true, mode: 0o700 });
  const actor = startActor(databasePath(eexist), 'empty', 500);
  try {
    await actor.ready;
    observeEntry(eexist);
  } finally {
    let terminal: ActorTerminal | undefined;
    try {
      terminal = await stopActor(actor);
      assert.ok(terminal.signal === 'SIGKILL' || terminal.code === 0);
    } finally {
      if (terminal?.closeObserved)
        rmSync(eexist, { recursive: true, force: true });
    }
  }
});

test('W3 read-only inspection failure performs no writable startup fallback', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-ro-no-fallback-');
  prepareCompleteStore(dir);
  const originalPrepare = DatabaseSync.prototype.prepare;
  const execs: string[] = [];
  t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string, ...args: unknown[]) {
      if (sql.includes('FROM sqlite_schema'))
        throw Object.assign(new Error('RO_NO_FALLBACK_SECRET'), {
          code: 'ERR_SQLITE_IOERR',
          errcode: 10,
        });
      return Reflect.apply(originalPrepare, this, [sql, ...args] as never);
    },
  );
  const originalExec = DatabaseSync.prototype.exec;
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string): void {
      execs.push(sql);
      originalExec.call(this, sql);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => openStore(dir),
      (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.code, 'STORE_UNAVAILABLE');
        assert.ok(
          !JSON.stringify(toDiagnostic(error)).includes(
            'RO_NO_FALLBACK_SECRET',
          ),
        );
        return true;
      },
    );
    assert.equal(execs.includes('PRAGMA busy_timeout = 1000'), false);
    assert.equal(execs.includes('BEGIN IMMEDIATE'), false);
    assert.equal(execs.includes('PRAGMA journal_mode = WAL'), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('W3 fixture actor has bounded terminal and early-exit lifecycle evidence', {
  skip: runtimeSkip,
}, async () => {
  const dir = tempDir('u1-w3-actor-lifecycle-');
  prepareCompleteStore(dir);
  let actorsCreated = 0;
  let actorsReaped = 0;
  try {
    const bounded = startActor(databasePath(dir), 'compatible', 80);
    actorsCreated += 1;
    try {
      const ready = await bounded.ready;
      assert.equal(ready.walExists, true);
      const startedAt = performance.now();
      const terminal = await waitForActorTerminal(bounded, 2_000);
      const elapsedWaitMs = performance.now() - startedAt;
      assert.equal(terminal.code, 0);
      assert.equal(terminal.signal, null);
      assert.equal(terminal.closeObserved, true);
      // Readiness may be consumed late; the fixture's elapsedMs below proves
      // the hold duration, while this observer only bounds the remaining wait.
      assert.ok(elapsedWaitMs < 2_000, `${elapsedWaitMs}ms`);
      const done = bounded
        .output()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .map(
          (line) => JSON.parse(line) as { status?: string; elapsedMs?: number },
        )
        .find((line) => line.status === 'done');
      assert.ok(done);
      assert.equal(typeof done.elapsedMs, 'number');
      assert.ok((done.elapsedMs ?? 0) >= 70, `${done.elapsedMs}ms`);
      assert.ok((done.elapsedMs ?? Infinity) < 2_000, `${done.elapsedMs}ms`);
    } finally {
      await stopActor(bounded);
      actorsReaped += 1;
    }

    const early = startActor(databasePath(dir), 'empty', 80);
    actorsCreated += 1;
    try {
      await assert.rejects(early.ready);
      const earlyTerminal = await waitForActorTerminal(early, 2_000);
      assert.equal(earlyTerminal.code, 1);
      assert.equal(earlyTerminal.closeObserved, true);
    } finally {
      await stopActor(early);
      actorsReaped += 1;
    }

    // This finite actor deliberately exceeds the independent helper deadline;
    // the helper must kill it and wait for close rather than trust its loop.
    const overlong = startActor(databasePath(dir), 'compatible', 30_000);
    actorsCreated += 1;
    try {
      await overlong.ready;
      const terminal = await waitForActorTerminal(overlong, 250);
      assert.equal(terminal.signal, 'SIGKILL');
      assert.equal(terminal.closeObserved, true);
    } finally {
      await stopActor(overlong);
      actorsReaped += 1;
    }

    // The private seam invokes startActor's real error and close listeners.
    const missing = startActor(databasePath(dir), 'empty', 80, () =>
      spawn('/definitely/missing/schema-actor', [], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    actorsCreated += 1;
    try {
      await assert.rejects(missing.ready);
      const terminal = await waitForActorTerminal(missing, 2_000);
      assert.ok(terminal.error instanceof Error);
      assert.equal(terminal.closeObserved, true);
      // A spawn failure creates no child, so exit/signal are intentionally not
      // used as its terminal proof.
    } finally {
      await stopActor(missing);
      actorsReaped += 1;
    }
  } finally {
    if (actorsReaped === actorsCreated)
      rmSync(dir, { recursive: true, force: true });
  }
});

test('W3 WAL snapshot remains coherent while independent writer upgrades after manifest', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-wal-snapshot-');
  const database = databasePath(dir);
  prepareCompleteStore(dir);
  const originalPrepare = DatabaseSync.prototype.prepare;
  let injected = false;
  let roVersion = '';
  let writerResult: ReturnType<typeof runIndependentVersionWriter> | undefined;
  t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string, ...args: unknown[]) {
      const statement = Reflect.apply(originalPrepare, this, [
        sql,
        ...args,
      ] as never);
      if (!injected && sql.includes('SELECT value FROM meta')) {
        injected = true;
        writerResult = runIndependentVersionWriter(database);
        const originalGet = statement.get.bind(statement);
        const row = originalGet() as { value: string };
        roVersion = row.value;
        return { get: () => row } as never;
      }
      return statement;
    },
  );
  syncBuiltinESMExports();
  try {
    expectTooNew(() => openStore(dir), dir);
    assert.equal(injected, true);
    assert.equal(roVersion, '1');
    assertSubprocessCompleted(
      writerResult ?? {
        ok: false,
        output: '',
        exit: null,
        signal: null,
        error: 'missing',
      },
    );
    assert.equal(
      writerResult?.ok,
      true,
      writerResult?.output ?? 'writer produced no result',
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('W3 whole-handoff busy retry releases both startup handles before retry', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-handoff-retry-');
  prepareCompleteStore(dir);
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  const closeAttempts: DatabaseSync[] = [];
  let reader: DatabaseSync | undefined;
  let writer: DatabaseSync | undefined;
  let beginCount = 0;
  let retryReaderOpen: boolean | undefined;
  let retryWriterOpen: boolean | undefined;
  let retryReaderClosed = false;
  let retryWriterClosed = false;
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string): void {
      if (sql === 'BEGIN DEFERRED' && reader === undefined) reader = this;
      if (sql === 'PRAGMA busy_timeout = 1000' && writer === undefined)
        writer = this;
      if (sql === 'BEGIN IMMEDIATE') {
        beginCount += 1;
        if (beginCount === 1)
          throw Object.assign(new Error('database is locked'), {
            code: 'ERR_SQLITE_BUSY',
            errcode: 5,
          });
        retryReaderOpen = reader?.isOpen;
        retryWriterOpen = writer?.isOpen;
        retryReaderClosed =
          reader !== undefined && closeAttempts.includes(reader);
        retryWriterClosed =
          writer !== undefined && closeAttempts.includes(writer);
      }
      originalExec.call(this, sql);
    },
  );
  t.mock.method(
    DatabaseSync.prototype,
    'close',
    function (this: DatabaseSync): void {
      closeAttempts.push(this);
      originalClose.call(this);
    },
  );
  syncBuiltinESMExports();
  try {
    const store = openStore(dir);
    store.close();
    assert.equal(beginCount >= 2, true);
    assert.equal(retryReaderOpen, false);
    assert.equal(retryWriterOpen, false);
    assert.equal(retryReaderClosed, true);
    assert.equal(retryWriterClosed, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const handle of [reader, writer]) {
      try {
        if (handle?.isOpen) originalClose.call(handle);
      } catch {
        // Test-owned cleanup is best effort after assertions.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('W3 compatible DELETE-to-WAL conversion preserves logical data and permits reuse', {
  skip: runtimeSkip,
}, () => {
  const dir = tempDir('u1-w3-conversion-preserves-');
  const database = databasePath(dir);
  const initial = openStore(dir);
  try {
    assert.equal(initial.reserve(input('conversion-seed')).created, true);
  } finally {
    initial.close();
  }
  try {
    const reset = new DatabaseSync(database);
    try {
      assert.equal(
        reset.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode,
        'delete',
      );
    } finally {
      reset.close();
    }
    const before = logicalSnapshot(database);
    const converted = openStore(dir);
    converted.close();
    const verify = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(
        verify.prepare('PRAGMA journal_mode').get()?.journal_mode,
        'wal',
      );
    } finally {
      verify.close();
    }
    assert.deepEqual(logicalSnapshot(database), before);
    const reopened = openStore(dir);
    try {
      assert.equal(reopened.reserve(input('conversion-after')).created, true);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('W3 conversion boundaries retain independent writer exclusion until WAL completes', {
  skip: runtimeSkip,
}, (t) => {
  const dir = tempDir('u1-w3-conversion-boundaries-');
  const database = databasePath(dir);
  prepareCompleteStore(dir);
  const reset = new DatabaseSync(database);
  reset.prepare('PRAGMA journal_mode = DELETE').get();
  reset.close();
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  let rollbackSeen = false;
  let normalSeen = false;
  let walPrepareSeen = false;
  const attempts: Array<{
    point: string;
    result: ReturnType<typeof runIndependentVersionWriter>;
  }> = [];
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string): void {
      originalExec.call(this, sql);
      if (sql === 'ROLLBACK' && !rollbackSeen) {
        rollbackSeen = true;
        attempts.push({
          point: 'after-validation-rollback',
          result: runIndependentVersionWriter(database),
        });
      }
      if (sql === 'PRAGMA locking_mode = NORMAL' && !normalSeen) {
        normalSeen = true;
        attempts.push({
          point: 'after-normal',
          result: runIndependentVersionWriter(database),
        });
      }
    },
  );
  t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string, ...args: unknown[]) {
      if (sql === 'PRAGMA journal_mode = WAL' && !walPrepareSeen) {
        walPrepareSeen = true;
        attempts.push({
          point: 'before-wal-conversion',
          result: runIndependentVersionWriter(database),
        });
        const result = Reflect.apply(originalPrepare, this, [
          sql,
          ...args,
        ] as never).get();
        attempts.push({
          point: 'after-wal-conversion',
          result: runIndependentVersionWriter(database),
        });
        return { get: () => result } as never;
      }
      return Reflect.apply(originalPrepare, this, [sql, ...args] as never);
    },
  );
  syncBuiltinESMExports();
  try {
    expectTooNew(() => openStore(dir), dir);
    assert.equal(rollbackSeen, true);
    assert.equal(normalSeen, true);
    assert.equal(walPrepareSeen, true);
    assert.equal(attempts.length, 4);
    assertBusyWrite(
      attempts[0]?.result as WriterAttempt,
      attempts[0]?.point ?? 'rollback',
    );
    assertBusyWrite(
      attempts[1]?.result as WriterAttempt,
      attempts[1]?.point ?? 'normal',
    );
    assertBusyWrite(
      attempts[2]?.result as WriterAttempt,
      attempts[2]?.point ?? 'before WAL',
    );
    assert.equal(attempts[3]?.point, 'after-wal-conversion');
    const afterConversion = attempts[3]?.result as WriterAttempt | undefined;
    assertSubprocessCompleted(
      afterConversion ?? {
        ok: false,
        output: '',
        exit: null,
        signal: null,
        error: 'missing',
      },
    );
    assert.equal(
      afterConversion?.ok,
      true,
      afterConversion?.output ?? 'writer produced no result',
    );
    const verify = new DatabaseSync(database, { readOnly: true });
    assert.equal(
      verify.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'wal',
    );
    assert.equal(
      (
        verify
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string }
      ).value,
      '999',
    );
    verify.close();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
