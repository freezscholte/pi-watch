/**
 * Owner validation (plan KTD2).
 *
 * The owner UUID always comes from a trusted caller context — never from
 * tool arguments or the environment. U1 defines the narrow seam:
 * the caller supplies both the UUID and the session file path it trusts,
 * and this module verifies the *persisted* backing before any store
 * operation. U3 will source the identity from the real Pi SessionManager.
 *
 * Rules enforced here:
 * - The session file must exist, be readable, and be a regular file.
 * - Its persisted first-line header must be a Pi session record
 *   (`type: 'session'`) whose `id` UUID matches the trusted UUID
 *   (Pi 0.85.1 `SessionHeader`; identity lives in `id`, never a `uuid`
 *   property). A persistence flag or the filename alone is insufficient.
 * - A moved file with the same valid header remains the same owner.
 * - A forked/replaced session with a different UUID does not.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isWellFormedNonEmpty, StoreError } from './job-types.ts';

export interface OwnerIdentity {
  ownerUuid: string;
  sessionPath: string;
}

/**
 * Reads the persisted first-line session header and returns its session
 * UUID (lowercase), or null when the file is unreadable or the header is
 * not an authentic Pi session record.
 *
 * Pi 0.85.1 contract (public installed docs/types, confirmed against
 * `docs/session-format.md` and `dist/core/session-manager.d.ts`): the
 * first JSONL line is `{ type: 'session', version?: number, id: <UUID>,
 * timestamp, cwd, parentSession? }`. The record type must be `session`
 * and the identity field is `id`.
 */
export type SessionHeaderReader = (path: string) => string | null;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_CHUNK_BYTES = 65_536;

const defaultSessionHeaderReader: SessionHeaderReader = (path) => {
  let chunk: string;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(HEADER_CHUNK_BYTES);
      const read = readSync(fd, buf, 0, HEADER_CHUNK_BYTES, 0);
      chunk = buf.toString('utf8', 0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === 'session' &&
        'id' in parsed &&
        typeof (parsed as { id: unknown }).id === 'string' &&
        UUID_RE.test((parsed as { id: string }).id)
      ) {
        return (parsed as { id: string }).id.toLowerCase();
      }
    } catch {
      return null;
    }
    return null;
  }
  return null;
};

function isWellFormedSessionPath(value: string): boolean {
  return isWellFormedNonEmpty(value);
}

/**
 * Validates that the trusted identity is backed by a readable session file
 * whose persisted header UUID matches. Throws OWNER_REJECTED otherwise.
 * Returns nothing — callers proceed only when this does not throw.
 */
export function validateOwner(
  identity: OwnerIdentity,
  reader: SessionHeaderReader = defaultSessionHeaderReader,
): void {
  const { ownerUuid, sessionPath } = identity;
  if (typeof ownerUuid !== 'string' || !UUID_RE.test(ownerUuid)) {
    throw new StoreError(
      'OWNER_REJECTED',
      'Owner identity is not a valid UUID.',
    );
  }
  if (
    typeof sessionPath !== 'string' ||
    !isWellFormedSessionPath(sessionPath)
  ) {
    throw new StoreError(
      'OWNER_REJECTED',
      'Owner session path is missing or malformed.',
    );
  }

  let readableRegularFile = false;
  try {
    readableRegularFile = statSync(sessionPath).isFile();
  } catch {
    readableRegularFile = false;
  }
  if (!readableRegularFile) {
    throw new StoreError(
      'OWNER_REJECTED',
      'Owner session file is missing or unreadable.',
    );
  }

  const headerUuid = reader(sessionPath);
  if (headerUuid === null) {
    throw new StoreError(
      'OWNER_REJECTED',
      'Owner session header is malformed.',
    );
  }
  if (headerUuid.toLowerCase() !== ownerUuid.toLowerCase()) {
    throw new StoreError(
      'OWNER_REJECTED',
      'Owner session header does not match.',
    );
  }
}
