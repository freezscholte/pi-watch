/**
 * Finite storage-only WAL fixture used by the U1-W3 startup matrix.
 * It intentionally holds an original SQLite connection so tests can observe
 * retained WAL/SHM state before killing/reaping this owned process.
 */
import { closeSync, existsSync, openSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

interface Options {
  db: string;
  mode: 'newer' | 'compatible' | 'empty';
  holdMs: number;
}

const MAX_HOLD_MS = 60_000;

function parseArgs(argv: string[]): Options {
  let db = '';
  let mode: Options['mode'] = 'newer';
  let holdMs = 30_000;
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (name === '--db' && value !== undefined) db = value;
    if (
      name === '--mode' &&
      (value === 'compatible' || value === 'empty' || value === 'newer')
    )
      mode = value;
    if (name === '--hold' && value !== undefined) holdMs = Number(value);
  }
  return { db, mode, holdMs };
}

function waitUntil(deadline: number): number {
  const start = performance.now();
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  while (performance.now() < deadline) Atomics.wait(buffer, 0, 0, 25);
  return performance.now() - start;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (
    options.db === '' ||
    !Number.isFinite(options.holdMs) ||
    options.holdMs <= 0 ||
    options.holdMs > MAX_HOLD_MS
  ) {
    process.stdout.write(`${JSON.stringify({ status: 'usage' })}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.mode === 'empty') {
    const descriptor = openSync(options.db, 'wx', 0o600);
    try {
      process.stdout.write(
        `${JSON.stringify({ status: 'ready', mode: 'empty' })}\n`,
      );
      const elapsedMs = waitUntil(performance.now() + options.holdMs);
      process.stdout.write(
        `${JSON.stringify({ status: 'done', mode: 'empty', elapsedMs })}\n`,
      );
    } finally {
      closeSync(descriptor);
    }
    return;
  }

  const database = new DatabaseSync(options.db, { timeout: 1000 });
  try {
    database.exec('PRAGMA wal_autocheckpoint = 0');
    if (options.mode === 'newer') {
      database
        .prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'")
        .run();
    } else {
      database.exec('PRAGMA user_version = 7');
    }
    const wal = `${options.db}-wal`;
    const shm = `${options.db}-shm`;
    const walStat = existsSync(wal) ? statSync(wal) : undefined;
    const shmExists = existsSync(shm);
    process.stdout.write(
      `${JSON.stringify({
        status: 'ready',
        mode: options.mode,
        walExists: walStat !== undefined,
        shmExists,
        walBytes: walStat?.size ?? 0,
      })}\n`,
    );
    const elapsedMs = waitUntil(performance.now() + options.holdMs);
    process.stdout.write(
      `${JSON.stringify({ status: 'done', mode: options.mode, elapsedMs })}\n`,
    );
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'UNKNOWN';
  process.stdout.write(`${JSON.stringify({ status: 'error', code })}\n`);
  process.exitCode = 1;
}
