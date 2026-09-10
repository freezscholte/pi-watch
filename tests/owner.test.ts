import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StoreError, toDiagnostic } from '../src/job-types.ts';
import { type OwnerIdentity, validateOwner } from '../src/owner.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function identity(
  dir: string,
  uuid: string,
  name = 'session.jsonl',
): OwnerIdentity {
  return { ownerUuid: uuid, sessionPath: join(dir, name) };
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const FORK = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('missing session file rejects an ephemeral owner without side effects', () => {
  const dir = tempDir('u1-owner-missing-');
  assert.throws(
    () => validateOwner(identity(dir, OWNER)),
    (error: unknown) =>
      error instanceof StoreError && error.code === 'OWNER_REJECTED',
  );
});

test('an authentic Pi 0.85.1 session header with a matching id validates, including after the file moves', () => {
  const dir = tempDir('u1-owner-match-');
  const path = join(dir, 'session.jsonl');
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: OWNER,
      timestamp: '2024-12-03T14:00:00.000Z',
      cwd: '/path/to/project',
    })}\nhello\n`,
  );
  assert.doesNotThrow(() => validateOwner(identity(dir, OWNER)));
  const moved = join(dir, 'moved.jsonl');
  copyFileSync(path, moved);
  assert.doesNotThrow(() =>
    validateOwner({ ownerUuid: OWNER, sessionPath: moved }),
  );
});

test('a forked Pi session header with a different id rejects', () => {
  const dir = tempDir('u1-owner-fork-');
  const path = join(dir, 'fork.jsonl');
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: FORK,
      timestamp: '2024-12-03T14:00:00.000Z',
      cwd: '/path/to/project',
      parentSession: '/original/session.jsonl',
    })}\n`,
  );
  assert.throws(
    () => validateOwner({ ownerUuid: OWNER, sessionPath: path }),
    (error: unknown) =>
      error instanceof StoreError && error.code === 'OWNER_REJECTED',
  );
});

test('malformed or non-session headers reject: not JSON, wrong record type, no id, or a non-UUID value', () => {
  const dir = tempDir('u1-owner-malformed-');
  const cases = [
    'not json at all\n',
    // Wrong record type: identity-bearing but not a session header.
    `${JSON.stringify({ type: 'message', id: OWNER })}\n`,
    // The incompatible legacy shape this gate must keep rejecting.
    `${JSON.stringify({ uuid: OWNER, role: 'user' })}\n`,
    `${JSON.stringify({ type: 'session', version: 3 })}\n`,
    `${JSON.stringify({ type: 'session', version: 3, id: 'not-a-uuid' })}\n`,
    `${JSON.stringify({ type: 'session', version: 3, id: 123 })}\n`,
    '',
  ];
  for (const body of cases) {
    const path = join(dir, `case-${cases.indexOf(body)}.jsonl`);
    writeFileSync(path, body);
    assert.throws(
      () => validateOwner({ ownerUuid: OWNER, sessionPath: path }),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'OWNER_REJECTED',
      body,
    );
  }
});

test('wrong-type session backing (a directory) rejects safely', () => {
  const dir = tempDir('u1-owner-dir-');
  const path = join(dir, 'session-dir');
  mkdirSync(path);
  assert.throws(
    () => validateOwner({ ownerUuid: OWNER, sessionPath: path }),
    (error: unknown) =>
      error instanceof StoreError && error.code === 'OWNER_REJECTED',
  );
});

test('an unreadable session file rejects', () => {
  if (process.getuid?.() === 0) return;
  const dir = tempDir('u1-owner-perm-');
  const path = join(dir, 'locked.jsonl');
  writeFileSync(path, `${JSON.stringify({ type: 'session', id: OWNER })}\n`);
  chmodSync(path, 0o000);
  try {
    assert.throws(
      () => validateOwner({ ownerUuid: OWNER, sessionPath: path }),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'OWNER_REJECTED',
    );
  } finally {
    chmodSync(path, 0o644);
  }
});

test('malformed owner identity input rejects before touching the filesystem', () => {
  const dir = tempDir('u1-owner-input-');
  const bad = [
    { ownerUuid: 'not-a-uuid', sessionPath: join(dir, 's.jsonl') },
    { ownerUuid: '', sessionPath: join(dir, 's.jsonl') },
    { ownerUuid: OWNER, sessionPath: '' },
    { ownerUuid: OWNER, sessionPath: 'bad\u0000path' },
  ];
  for (const candidate of bad) {
    assert.throws(
      () => validateOwner(candidate),
      (error: unknown) =>
        error instanceof StoreError && error.code === 'OWNER_REJECTED',
    );
  }
});

test('the header reader is an injectable seam for the later Pi integration', () => {
  const dir = tempDir('u1-owner-seam-');
  const path = join(dir, 'custom.txt');
  writeFileSync(path, 'SESSION 11111111-2222-4333-8444-555555555555 done\n');
  const customReader = (candidate: string): string | null => {
    if (candidate !== path) return null;
    const match = /^SESSION (\S+) /.exec(readFirstLine(candidate));
    return match?.[1] ?? null;
  };
  assert.doesNotThrow(() =>
    validateOwner({ ownerUuid: OWNER, sessionPath: path }, customReader),
  );
  assert.throws(
    () => validateOwner({ ownerUuid: FORK, sessionPath: path }, customReader),
    (error: unknown) =>
      error instanceof StoreError && error.code === 'OWNER_REJECTED',
  );
});

test('owner rejection diagnostics never leak the session path or raw error content', () => {
  const dir = tempDir('u1-owner-secret-');
  const path = join(dir, 'TOPSECRET-session.jsonl');
  const diagnostic = (() => {
    try {
      validateOwner({ ownerUuid: OWNER, sessionPath: path });
      return null;
    } catch (error) {
      return toDiagnostic(error);
    }
  })();
  assert.ok(diagnostic);
  assert.equal(diagnostic.code, 'OWNER_REJECTED');
  const serialized = JSON.stringify(diagnostic);
  assert.ok(!serialized.includes('TOPSECRET'), serialized);
  assert.ok(!serialized.includes(dir), serialized);
});

function readFirstLine(path: string): string {
  return readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
}
