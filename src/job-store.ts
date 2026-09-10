/**
 * Durable job store (plan KTD1, KTD2, KTD4, KTD5, KTD7).
 *
 * Synchronous SQLite storage behind a small worker facade (store-worker.ts /
 * store-client.ts) so lock waits never block the Pi event loop. One
 * user-local database; WAL, synchronous=FULL, foreign keys, schema version,
 * short write transactions with a 1,000 ms busy timeout. First schema
 * creation is serialized in one write transaction that either commits a
 * complete validated schema or rolls back. Unsupported Node/SQLite runtimes
 * are rejected before any disk store is created; newer schemas are refused
 * without modification.
 *
 * Fencing (findings #7, #8): every job operation predicates on the trusted
 * owner UUID. Runner-originated mutations verify the original durable claim
 * inside the same transaction; claiming is a one-time route owned by the
 * reservation creator, and metadata replay grants no fresh launch
 * permission. Publications merge evidence monotonically: established shell,
 * capture, cleanup and launch facts survive later uncertain snapshots and
 * contradictory observations are rejected. Owner reconciliation stays on
 * its separate uncertainty-only CAS operation (publishUncertainResult).
 *
 * Acceptance identity (finding #6): the candidate job UUID is preallocated
 * by the caller before persistence and retained across ambiguous
 * acceptance; a failure after a successful COMMIT is never presented as a
 * rolled-back operation.
 *
 * Scope note: this module stores ownership, reservations, claims, evidence
 * revisions and notices. Runner heartbeat timers, cancellation polling,
 * command spawning and delivery leases live in later units; their future
 * facts are representable through the primitives here (store-evidence.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AmbiguousAcceptanceError,
  allocateReservationId,
  isWellFormedNonEmpty,
  StoreError,
  StoreWriteError,
  validateCommand,
  validateDeadlineMs,
  validateRequestKey,
} from './job-types.ts';
import {
  type EvidenceInput,
  type ExecutionEvidence,
  initialEvidence,
  mergeEvidence,
  validateEvidenceInput,
} from './store-evidence.ts';

export const SCHEMA_VERSION = 2;
const ENGINE_FLOOR = '3.51.3';
export type RequestNamespace = 'tool_call' | 'explicit';

export interface JobRecord {
  jobId: string;
  ownerUuid: string;
  ownerSessionPath: string;
  namespace: RequestNamespace;
  requestKey: string;
  command: string;
  cwd: string;
  deadlineMs: number;
  acceptedAtMs: number;
  deadlineAtMs: number;
  creationOrdinal: number;
  state: 'reserved' | 'claimed' | 'settled';
}

export interface ReservationInput {
  ownerUuid: string;
  sessionPath: string;
  namespace: RequestNamespace;
  requestKey: string;
  command: string;
  /** Absolute lexical cwd; adapters resolve it against the trusted current cwd. */
  cwd: string;
  deadlineMs?: number;
  /**
   * Optional caller-preallocated identity. The async client allocates and
   * retains one before handoff when omitted; direct storage allocates before
   * BEGIN. A replay preserves the existing job ID, never the new candidate.
   */
  candidateJobId?: string;
}

export interface ReservationResult {
  created: boolean;
  job: JobRecord;
  /** Private handoff capability, returned ONLY on creation; never metadata. */
  runnerToken: string | null;
}

export interface RunnerClaim {
  claimId: string;
  claimedAtMs: number;
  heartbeatCounter: number;
}

export interface ResultRecord {
  jobId: string;
  revision: number;
  evidence: ExecutionEvidence;
  publishedAtMs: number;
}

export interface NoticeRecord {
  jobId: string;
  ownerUuid: string;
  revision: number;
  pending: boolean;
  acknowledgedAtMs: number | null;
}

/**
 * Owner-scoped consistent observation snapshot (finding #1): the current
 * claim identity/counter plus the latest durable evidence in one SQLite
 * read snapshot. A fresh owner can construct a stale-witness CAS from this
 * snapshot after reopening without guessing claim/counter values. This read
 * grants no execution authority.
 */
export type LaunchDecision =
  | 'authorized'
  | 'suppressed_cancelled'
  | 'suppressed_deadline';

export interface JobControlSnapshot {
  cancellationRequestedAtMs: number | null;
  launchDecision: LaunchDecision | null;
  decidedAtMs: number | null;
}

export interface CancellationResult {
  disposition: 'recorded' | 'already_recorded' | 'already_terminal';
  control: JobControlSnapshot;
}

export interface LaunchDecisionResult {
  disposition:
    | 'authorized_now'
    | 'suppressed_now'
    | 'already_decided'
    | 'precluded';
  control: JobControlSnapshot;
}

export interface JobObservation {
  job: JobRecord;
  claimId: string | null;
  heartbeatCounter: number;
  latestRevision: number;
  finalized: boolean;
  evidence: ExecutionEvidence;
  /** Durable control state; this snapshot grants no execution authority. */
  control: JobControlSnapshot;
}

export interface StaleWitnessInput {
  observedClaimId: string | null;
  observedCounter: number;
  /** Evidence version the observer last saw; rechecked in-transaction. */
  observedRevision: number;
}

export interface JobStoreOptions {
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
  /**
   * Mandatory trusted anchor directory (finding #3, approved modified-A
   * decision): the only path component whose identity is assumed safe.
   * The database path must resolve strictly inside it; the root itself may
   * be a legitimate symlink/alias (e.g. macOS /var -> /private/var) and is
   * canonicalized via realpath. Shared ancestors are never chmod-ed.
   */
  trustedRoot: string;
  /**
   * Controlled fault-injection seam for lifecycle tests. `beforeCommit`
   * runs inside each write transaction just before COMMIT; `afterCommit`
   * runs after COMMIT (simulating post-commit acknowledgment loss). Never
   * used by production callers.
   */
  hooks?: {
    beforeCommit?: (op: string) => void;
    afterCommit?: (op: string) => void;
  };
}

export interface JobStore {
  reserve(input: ReservationInput): ReservationResult;
  getJob(ownerUuid: string, jobId: string): JobRecord;
  listJobs(ownerUuid: string): JobRecord[];
  observeJob(ownerUuid: string, jobId: string): JobObservation;
  requestCancellation(ownerUuid: string, jobId: string): CancellationResult;
  decideLaunch(
    ownerUuid: string,
    jobId: string,
    claimId: string,
    runnerToken: string | null,
  ): LaunchDecisionResult;
  claimRunner(
    ownerUuid: string,
    jobId: string,
    claimId: string,
    runnerToken: string | null,
  ): RunnerClaim;
  heartbeat(
    ownerUuid: string,
    jobId: string,
    claimId: string,
    expectedCounter: number,
    runnerToken: string | null,
  ): { counter: number };
  publishResult(
    ownerUuid: string,
    jobId: string,
    claimId: string,
    expectedRevision: number | null,
    evidence: EvidenceInput,
    runnerToken: string | null,
  ): ResultRecord;
  publishUncertainResult(
    ownerUuid: string,
    jobId: string,
    witness: StaleWitnessInput,
  ): ResultRecord;
  acknowledgeNotice(ownerUuid: string, jobId: string, revision: number): void;
  listNotices(ownerUuid: string, jobId: string): NoticeRecord[];
  listPendingNotices(ownerUuid: string): NoticeRecord[];
  listResults(ownerUuid: string, jobId: string): ResultRecord[];
  close(): void;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CREATE_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE jobs (
  creation_ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  owner_uuid TEXT NOT NULL,
  owner_session_path TEXT NOT NULL,
  runner_token_hash TEXT NOT NULL,
  request_namespace TEXT NOT NULL,
  request_key TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  deadline_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  deadline_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'claimed', 'settled')),
  UNIQUE (owner_uuid, request_namespace, request_key)
);
CREATE INDEX jobs_owner_idx ON jobs (owner_uuid, creation_ordinal);
CREATE TABLE job_control (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
  cancellation_requested_at_ms INTEGER,
  launch_decision TEXT CHECK (launch_decision IN ('authorized', 'suppressed_cancelled', 'suppressed_deadline')),
  decided_at_ms INTEGER,
  CHECK (
    (launch_decision IS NULL AND decided_at_ms IS NULL) OR
    (launch_decision IS NOT NULL AND decided_at_ms IS NOT NULL)
  )
);
CREATE TABLE job_claims (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
  claim_id TEXT NOT NULL UNIQUE,
  claimed_at_ms INTEGER NOT NULL,
  heartbeat_counter INTEGER NOT NULL DEFAULT 0,
  heartbeat_at_ms INTEGER
);
CREATE TABLE job_results (
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  revision INTEGER NOT NULL,
  launch TEXT NOT NULL,
  shell_code INTEGER,
  shell_signal TEXT,
  cleanup_state TEXT NOT NULL,
  cleanup_term_observation TEXT,
  cleanup_kill_intent INTEGER NOT NULL,
  cancellation_intent INTEGER NOT NULL,
  deadline_trigger INTEGER NOT NULL,
  stdout_available INTEGER CHECK (stdout_available IN (0, 1)),
  stdout_truncated INTEGER NOT NULL,
  stdout_incomplete INTEGER NOT NULL,
  stdout_open_at_cutover INTEGER NOT NULL,
  stderr_available INTEGER CHECK (stderr_available IN (0, 1)),
  stderr_truncated INTEGER NOT NULL,
  stderr_incomplete INTEGER NOT NULL,
  stderr_open_at_cutover INTEGER NOT NULL,
  uncertain INTEGER NOT NULL,
  finalized INTEGER NOT NULL,
  published_at_ms INTEGER NOT NULL,
  PRIMARY KEY (job_id, revision)
);
CREATE TABLE job_notices (
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  revision INTEGER NOT NULL,
  owner_uuid TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 1,
  acknowledged_at_ms INTEGER,
  PRIMARY KEY (job_id, revision)
);
CREATE TABLE stale_witnesses (
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  observed_claim_id TEXT NOT NULL,
  observed_counter INTEGER NOT NULL,
  observed_revision INTEGER NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (job_id, observed_claim_id, observed_counter)
);
`;

interface SchemaEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

type SchemaInspection = 'empty' | 'valid';

function schemaManifest(db: DatabaseSync): SchemaEntry[] {
  // SAFETY: sqlite_schema's fixed projection matches SchemaEntry exactly; the
  // assertion narrows node:sqlite's generic record output at this seam.
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       ORDER BY type, name, tbl_name, sql`,
    )
    .all() as unknown as SchemaEntry[];
}

function canonicalSchemaManifest(): SchemaEntry[] {
  const expected = new DatabaseSync(':memory:');
  try {
    expected.exec(CREATE_SQL);
    return schemaManifest(expected);
  } finally {
    expected.close();
  }
}

function schemaVersion(db: DatabaseSync): number {
  const meta = db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'meta'`,
    )
    .get();
  if (meta === undefined) {
    throw new StoreError(
      'STORE_CORRUPT',
      'Store schema is incomplete or unsupported.',
    );
  }
  // Check the fixed control-table shape before selecting its value. A missing
  // control column is an unrecognized schema, while failures in this probe
  // itself remain subject to the normal operational-error mapping.
  // SAFETY: the fixed PRAGMA projection supplies rows with an optional name.
  const columns = db
    .prepare(`PRAGMA table_info('meta')`)
    .all() as unknown as Array<{ name?: unknown }>;
  if (
    !columns.some((column) => column.name === 'key') ||
    !columns.some((column) => column.name === 'value')
  ) {
    throw new StoreError(
      'STORE_CORRUPT',
      'Store schema is incomplete or unsupported.',
    );
  }
  const row = db
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value?: unknown } | undefined;
  if (
    row === undefined ||
    typeof row.value !== 'string' ||
    !/^[0-9]+$/.test(row.value)
  ) {
    throw new StoreError(
      'STORE_CORRUPT',
      'Store schema is incomplete or unsupported.',
    );
  }
  const version = Number(row.value);
  if (!Number.isSafeInteger(version)) {
    throw new StoreError(
      'STORE_CORRUPT',
      'Store schema is incomplete or unsupported.',
    );
  }
  return version;
}

function inspectSchema(
  db: DatabaseSync,
  allowEmpty: boolean,
): SchemaInspection {
  const actual = schemaManifest(db);
  if (actual.length === 0) {
    if (allowEmpty) return 'empty';
    throw new StoreError(
      'STORE_CORRUPT',
      'Store schema is incomplete or unsupported.',
    );
  }
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new StoreError(
      'SCHEMA_TOO_NEW',
      'Store schema was written by a newer version; update pi-watch.',
    );
  }
  if (version !== SCHEMA_VERSION) {
    throw new StoreError(
      'STORE_CORRUPT',
      'Store schema is incomplete or unsupported.',
    );
  }
  const expected = canonicalSchemaManifest();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new StoreError(
      'STORE_CORRUPT',
      'Store schema is incomplete or unsupported.',
    );
  }
  return 'valid';
}

function parseVersion(version: string): [number, number, number] {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function probeLinkedSqliteVersion(): string {
  const db = new DatabaseSync(':memory:');
  try {
    const row = db.prepare('SELECT sqlite_version() AS v').get() as {
      v: string;
    };
    return row.v;
  } finally {
    db.close();
  }
}

/**
 * Runtime/engine preflight (KTD1). Must run before any disk store is created.
 * Unsupported runtime is a preflight rejection, not an unknown command outcome.
 */
export function checkRuntimeSupport(
  nodeVersion: string = process.versions.node,
  sqliteVersion?: string,
): void {
  // Normalize both legacy ("v26.x") and current ("26.x") version strings.
  const bare = nodeVersion.replace(/^v/, '');
  const major = Number.parseInt(bare, 10);
  if (major !== 26 || !/^26\./.test(bare)) {
    throw new StoreError(
      'RUNTIME_UNSUPPORTED',
      'pi-watch v0.1 requires Node 26.x.',
    );
  }
  const engine = sqliteVersion ?? probeLinkedSqliteVersion();
  const [gotMajor, gotMinor, gotPatch] = parseVersion(engine);
  const [wantMajor, wantMinor, wantPatch] = parseVersion(ENGINE_FLOOR);
  const tooOld =
    gotMajor < wantMajor ||
    (gotMajor === wantMajor && gotMinor < wantMinor) ||
    (gotMajor === wantMajor && gotMinor === wantMinor && gotPatch < wantPatch);
  if (tooOld) {
    throw new StoreError(
      'RUNTIME_UNSUPPORTED',
      `Linked SQLite ${engine} is older than the required ${ENGINE_FLOOR}.`,
    );
  }
}

function validateOwnerUuid(ownerUuid: unknown): string {
  if (typeof ownerUuid !== 'string' || !UUID_RE.test(ownerUuid)) {
    throw new StoreError('VALIDATION_FAILED', 'Owner UUID is invalid.');
  }
  return ownerUuid;
}

function validateClaimId(claimId: unknown): string {
  if (typeof claimId !== 'string' || !isWellFormedNonEmpty(claimId)) {
    throw new StoreError('VALIDATION_FAILED', 'Claim id is invalid.');
  }
  return claimId;
}

function validateNamespace(namespace: unknown): RequestNamespace {
  if (namespace !== 'tool_call' && namespace !== 'explicit') {
    throw new StoreError('VALIDATION_FAILED', 'Request namespace is invalid.');
  }
  return namespace;
}

/**
 * Validates and prepares the database path anchored at a caller-supplied
 * trusted root (finding #3, approved modified-A decision): directories
 * created by the store are 0700, the file is 0600, and symlinks and
 * wrong-type components are rejected without touching their targets
 * (plan §Data lifecycle).
 *
 * Only the trusted root itself is canonicalized (it may be a legitimate
 * alias, e.g. macOS /var -> /private/var). Every derived component between
 * the root and the database path is checked with `lstat` — symlinks and
 * non-directories are rejected before descending — and missing directories
 * are created one level at a time with mode 0700. Pre-existing descendants
 * must already be private; they are rejected rather than chmod-ed.
 */
function strictDescendantParts(path: string, root: string): string[] | null {
  if (path === root) return null;
  if (root === sep) {
    return path.startsWith(sep) ? path.slice(sep.length).split(sep) : null;
  }
  const prefix = root + sep;
  return path.startsWith(prefix) ? path.slice(prefix.length).split(sep) : null;
}

function appendPath(root: string, parts: string[]): string {
  return root === sep ? sep + parts.join(sep) : root + sep + parts.join(sep);
}

function prepareDatabasePath(dbPath: string, trustedRoot: string): string {
  if (!isAbsolute(dbPath) || !isWellFormedNonEmpty(dbPath)) {
    throw new StoreError(
      'PATH_UNSAFE',
      'Store path must be absolute and well-formed.',
    );
  }
  if (
    typeof trustedRoot !== 'string' ||
    !isAbsolute(trustedRoot) ||
    !isWellFormedNonEmpty(trustedRoot)
  ) {
    throw new StoreError(
      'PATH_UNSAFE',
      'Trusted root must be an absolute, well-formed path.',
    );
  }
  let rootReal: string;
  try {
    // Canonicalize ONLY the authorized root; descendants are never resolved
    // through realpath (that would bypass symlink rejection).
    rootReal = realpathSync(trustedRoot);
  } catch {
    throw new StoreError(
      'PATH_UNSAFE',
      'Trusted root must exist and be accessible.',
    );
  }
  if (!lstatSync(rootReal).isDirectory()) {
    throw new StoreError('PATH_UNSAFE', 'Trusted root is not a directory.');
  }
  const resolved = resolvePath(dbPath);
  // Prefer supplied-root containment so an alias such as real/alias -> real
  // maps `real/alias/watch` to `real/watch`. Otherwise accept the canonical
  // root spelling. Both checks are lexical and separator-safe; descendants
  // are never realpathed or used to launder links.
  const rootSupplied = resolvePath(trustedRoot);
  const parts =
    strictDescendantParts(resolved, rootSupplied) ??
    strictDescendantParts(resolved, rootReal);
  if (parts === null) {
    throw new StoreError(
      'PATH_UNSAFE',
      'Store path must be strictly inside the trusted root.',
    );
  }
  // Always transport the canonical spelling to SQLite and sidecar handling.
  const canonicalResolved = appendPath(rootReal, parts);
  // Directory components between the root and the file: checked and created
  // one level at a time so no unchecked ancestor is ever descended into.
  let current = rootReal;
  for (const part of parts.slice(0, -1)) {
    current = appendPath(current, [part]);
    let componentStat: import('node:fs').Stats;
    try {
      componentStat = lstatSync(current);
    } catch (error) {
      const enoent =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT';
      if (!enoent) {
        throw new StoreError(
          'PATH_UNSAFE',
          'Store path component is not accessible.',
        );
      }
      // One level at a time, 0700. Explicitly restore the private mode after
      // creation so an unusually restrictive umask cannot weaken the result.
      try {
        mkdirSync(current, { recursive: false, mode: 0o700 });
        chmodSync(current, 0o700);
        componentStat = lstatSync(current);
      } catch (mkdirError) {
        const eexist =
          typeof mkdirError === 'object' &&
          mkdirError !== null &&
          'code' in mkdirError &&
          mkdirError.code === 'EEXIST';
        if (!eexist) {
          throw new StoreError(
            'PATH_UNSAFE',
            'Store path component is not accessible.',
          );
        }
        // Lost a concurrent-creation race: re-lstat and type-check what the
        // other process created instead of blindly ignoring EEXIST.
        try {
          componentStat = lstatSync(current);
        } catch {
          throw new StoreError(
            'PATH_UNSAFE',
            'Store path component is not accessible.',
          );
        }
      }
    }
    if (
      componentStat.isSymbolicLink() ||
      !componentStat.isDirectory() ||
      (Number(componentStat.mode) & 0o7777) !== 0o700
    ) {
      throw new StoreError('PATH_UNSAFE', 'Store path component is unsafe.');
    }
  }
  let fileStat: import('node:fs').Stats | null;
  try {
    fileStat = lstatSync(canonicalResolved);
  } catch (error) {
    const enoent =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT';
    if (!enoent) {
      throw new StoreError(
        'PATH_UNSAFE',
        'Store database path is not accessible.',
      );
    }
    fileStat = null;
  }
  if (fileStat && (fileStat.isSymbolicLink() || !fileStat.isFile())) {
    throw new StoreError('PATH_UNSAFE', 'Store database path is unsafe.');
  }
  return canonicalResolved;
}

function ensurePrivateDatabaseFile(resolved: string): boolean {
  let descriptor = -1;
  let operationError: unknown;
  let created = false;
  try {
    try {
      descriptor = openSync(resolved, 'wx', 0o600);
      created = true;
      fchmodSync(descriptor, 0o600);
    } catch (error) {
      const eexist =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST';
      if (!eexist) {
        throw new StoreError(
          'PATH_UNSAFE',
          'Store database path is not accessible.',
        );
      }
      let stat: import('node:fs').Stats;
      try {
        stat = lstatSync(resolved);
      } catch {
        throw new StoreError(
          'PATH_UNSAFE',
          'Store database path is not accessible.',
        );
      }
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        (Number(stat.mode) & 0o7777) !== 0o600
      ) {
        // Existing storage is unknown until inspected. Refuse unsafe modes;
        // never repair them as a prerequisite for schema compatibility.
        throw new StoreError('PATH_UNSAFE', 'Store database path is unsafe.');
      }
    }
  } catch (error) {
    operationError = error;
  } finally {
    if (descriptor !== -1) {
      try {
        closeSync(descriptor);
      } catch {
        operationError = new StoreError(
          'STORE_UNAVAILABLE',
          'Store operation failed.',
        );
      }
    }
  }
  if (operationError !== undefined) {
    if (operationError instanceof StoreError) throw operationError;
    throw new StoreError(
      'PATH_UNSAFE',
      'Store database path is not accessible.',
    );
  }
  return created;
}

function validatePrivateSidecars(resolved: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = resolved + suffix;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(sidecar);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw new StoreError('PATH_UNSAFE', 'Unsafe store sidecar.');
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (Number(stat.mode) & 0o7777) !== 0o600
    ) {
      throw new StoreError('PATH_UNSAFE', 'Unsafe store sidecar.');
    }
  }
}

function wrapSqliteError(error: unknown): StoreError {
  const message = error instanceof Error ? error.message : String(error);
  // node:sqlite reports busy timeouts as "database is locked".
  if (
    message.includes('SQLITE_BUSY') ||
    message.includes('database is locked')
  ) {
    return new StoreError(
      'STORE_BUSY',
      'Store is busy; retry the idempotent operation.',
    );
  }
  // Raw engine text (paths, I/O details) must not escape into diagnostics.
  return new StoreError('STORE_UNAVAILABLE', 'Store operation failed.');
}

function wrapInspectionError(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  const code =
    typeof error === 'object' && error !== null && 'errcode' in error
      ? Number(error.errcode)
      : undefined;
  // SQLITE_CORRUPT and SQLITE_NOTADB identify a malformed database, while
  // other engine failures (including I/O) remain operational failures.
  if (code === 11 || code === 26) {
    return new StoreError(
      'STORE_CORRUPT',
      'Store schema is incomplete or unsupported.',
    );
  }
  return wrapSqliteError(error);
}

interface JobRow {
  creation_ordinal: number;
  job_id: string;
  owner_uuid: string;
  owner_session_path: string;
  runner_token_hash: string;
  request_namespace: string;
  request_key: string;
  command: string;
  cwd: string;
  deadline_ms: number;
  accepted_at_ms: number;
  deadline_at_ms: number;
  state: string;
}

/**
 * SAFETY: node:sqlite returns Record<string, SQLOutputValue>; the jobs table
 * columns are declared by CREATE_SQL to match JobRow exactly, so the row
 * objects produced for the jobs table satisfy JobRow at runtime.
 */
function asJobRows(rows: Record<string, unknown>[]): JobRow[] {
  // SAFETY: node:sqlite returns Record<string, SQLOutputValue>; the jobs
  // table columns are declared by CREATE_SQL to match JobRow exactly, so
  // rows produced for the jobs table satisfy JobRow at runtime.
  return rows as unknown as JobRow[];
}

function assertRunnerToken(job: JobRow, token: unknown): void {
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    createHash('sha256').update(token).digest('hex') !== job.runner_token_hash
  ) {
    throw new StoreError('CLAIM_TAKEN', 'Original runner capability required.');
  }
}

function rowToJob(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    ownerUuid: row.owner_uuid,
    ownerSessionPath: row.owner_session_path,
    namespace: row.request_namespace as RequestNamespace,
    requestKey: row.request_key,
    command: row.command,
    cwd: row.cwd,
    deadlineMs: row.deadline_ms,
    acceptedAtMs: row.accepted_at_ms,
    deadlineAtMs: row.deadline_at_ms,
    creationOrdinal: row.creation_ordinal,
    state: row.state as JobRecord['state'],
  };
}

interface ControlRow {
  cancellation_requested_at_ms: number | null;
  launch_decision: string | null;
  decided_at_ms: number | null;
}

function rowToControl(row: ControlRow | undefined): JobControlSnapshot {
  if (row === undefined) {
    throw new StoreError(
      'STORE_CORRUPT',
      'Store control state is missing or unsupported.',
    );
  }
  const decision = row.launch_decision;
  if (
    decision !== null &&
    decision !== 'authorized' &&
    decision !== 'suppressed_cancelled' &&
    decision !== 'suppressed_deadline'
  ) {
    throw new StoreError(
      'STORE_CORRUPT',
      'Store control state is missing or unsupported.',
    );
  }
  if ((decision === null) !== (row.decided_at_ms === null)) {
    throw new StoreError(
      'STORE_CORRUPT',
      'Store control state is missing or unsupported.',
    );
  }
  return {
    cancellationRequestedAtMs: row.cancellation_requested_at_ms,
    launchDecision: decision,
    decidedAtMs: row.decided_at_ms,
  };
}

function isInitialEvidenceOnly(row: ResultRow | undefined): boolean {
  if (row === undefined) return true;
  if (row.finalized === 1) return false;
  const evidence = rowToEvidence(row);
  // Revision uncertainty is a publication-state flag, not an observed fact.
  // Compare each fact explicitly so a raw non-final row with uncertain=0 is
  // still eligible, while every execution/capture/cleanup trigger remains a
  // veto.
  return (
    evidence.launch === 'unknown' &&
    evidence.shellCode === null &&
    evidence.shellSignal === null &&
    evidence.cleanupState === 'not_requested' &&
    evidence.cleanupTermObservation === null &&
    !evidence.cleanupKillIntentObserved &&
    !evidence.cancellationIntentObserved &&
    !evidence.deadlineTriggerObserved &&
    evidence.stdout.available === null &&
    !evidence.stdout.truncated &&
    !evidence.stdout.incomplete &&
    !evidence.stdout.openAtCutover &&
    evidence.stderr.available === null &&
    !evidence.stderr.truncated &&
    !evidence.stderr.incomplete &&
    !evidence.stderr.openAtCutover
  );
}

interface ResultRow {
  revision: number;
  launch: string;
  shell_code: number | null;
  shell_signal: string | null;
  cleanup_state: string;
  cleanup_term_observation: string | null;
  cleanup_kill_intent: number;
  cancellation_intent: number;
  deadline_trigger: number;
  stdout_available: number | null;
  stdout_truncated: number;
  stdout_incomplete: number;
  stdout_open_at_cutover: number;
  stderr_available: number | null;
  stderr_truncated: number;
  stderr_incomplete: number;
  stderr_open_at_cutover: number;
  uncertain: number;
  finalized: number;
  published_at_ms: number;
}

const RESULT_COLUMNS = `
  revision, launch, shell_code, shell_signal, cleanup_state,
  cleanup_term_observation, cleanup_kill_intent, cancellation_intent,
  deadline_trigger,
  stdout_available, stdout_truncated, stdout_incomplete, stdout_open_at_cutover,
  stderr_available, stderr_truncated, stderr_incomplete, stderr_open_at_cutover,
  uncertain, finalized, published_at_ms
`;

/** SAFETY: columns are declared by CREATE_SQL to match ExecutionEvidence. */
function rowToEvidence(row: ResultRow): ExecutionEvidence {
  return {
    launch: row.launch as ExecutionEvidence['launch'],
    shellCode: row.shell_code,
    shellSignal: row.shell_signal,
    cleanupState: row.cleanup_state as ExecutionEvidence['cleanupState'],
    cleanupTermObservation:
      row.cleanup_term_observation as ExecutionEvidence['cleanupTermObservation'],
    cleanupKillIntentObserved: row.cleanup_kill_intent === 1,
    cancellationIntentObserved: row.cancellation_intent === 1,
    deadlineTriggerObserved: row.deadline_trigger === 1,
    stdout: {
      available:
        row.stdout_available === null ? null : row.stdout_available === 1,
      truncated: row.stdout_truncated === 1,
      incomplete: row.stdout_incomplete === 1,
      openAtCutover: row.stdout_open_at_cutover === 1,
    },
    stderr: {
      available:
        row.stderr_available === null ? null : row.stderr_available === 1,
      truncated: row.stderr_truncated === 1,
      incomplete: row.stderr_incomplete === 1,
      openAtCutover: row.stderr_open_at_cutover === 1,
    },
    uncertain: row.uncertain === 1,
    finalized: row.finalized === 1,
  };
}

function evidenceToParams(
  evidence: ExecutionEvidence,
): (string | number | null)[] {
  return [
    evidence.launch,
    evidence.shellCode,
    evidence.shellSignal,
    evidence.cleanupState,
    evidence.cleanupTermObservation,
    evidence.cleanupKillIntentObserved ? 1 : 0,
    evidence.cancellationIntentObserved ? 1 : 0,
    evidence.deadlineTriggerObserved ? 1 : 0,
    evidence.stdout.available === null
      ? null
      : Number(evidence.stdout.available),
    evidence.stdout.truncated ? 1 : 0,
    evidence.stdout.incomplete ? 1 : 0,
    evidence.stdout.openAtCutover ? 1 : 0,
    evidence.stderr.available === null
      ? null
      : Number(evidence.stderr.available),
    evidence.stderr.truncated ? 1 : 0,
    evidence.stderr.incomplete ? 1 : 0,
    evidence.stderr.openAtCutover ? 1 : 0,
    evidence.uncertain ? 1 : 0,
    evidence.finalized ? 1 : 0,
  ];
}

/** Optional sidecars may disappear at checkpoint; other errors surface. */
function maintainSidecarPrivacy(resolved: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = resolved + suffix;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(sidecar);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new StoreError('PATH_UNSAFE', 'Unsafe store sidecar.');
    }
    if ((Number(stat.mode) & 0o7777) !== 0o600) chmodSync(sidecar, 0o600);
  }
}

export function createJobStore(
  dbPath: string,
  options: JobStoreOptions,
): JobStore {
  checkRuntimeSupport();
  // Runtime guard for JS callers: malformed/missing options must return a
  // redacted StoreError, not leak a TypeError.
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.trustedRoot !== 'string'
  ) {
    throw new StoreError(
      'PATH_UNSAFE',
      'Trusted root must be an absolute, well-formed path.',
    );
  }
  const resolved = prepareDatabasePath(dbPath, options.trustedRoot);
  // Missing storage is still created atomically and privately. Every opener,
  // including a fresh/zero-byte file, then follows the same SQLite snapshot
  // and handoff sequence; size is never treated as schema authority.
  ensurePrivateDatabaseFile(resolved);
  const now = options.now ?? Date.now;
  const hooks = options.hooks;
  let writesDisabled = false;

  let db!: DatabaseSync;
  let startupDb: DatabaseSync | undefined;
  try {
    /**
     * Releases a startup handle. A failed rollback or close is itself a
     * failure: retries must never leave a reader holding the lock that the
     * next writer is waiting for.
     */
    function releaseStartupHandle(
      handle: DatabaseSync | undefined,
      rollback: boolean,
    ): boolean {
      if (handle === undefined) return false;
      let failed = false;
      if (rollback) {
        try {
          handle.exec('ROLLBACK');
        } catch {
          failed = true;
        }
      }
      try {
        handle.close();
      } catch {
        failed = true;
      }
      if (handle === startupDb) startupDb = undefined;
      return failed;
    }

    function journalMode(dbHandle: DatabaseSync): string {
      // SAFETY: the fixed PRAGMA projection is supplied by SQLite.
      const row = dbHandle.prepare('PRAGMA journal_mode').get() as
        | { journal_mode?: unknown }
        | undefined;
      return typeof row?.journal_mode === 'string'
        ? row.journal_mode.toLowerCase()
        : '';
    }

    function configureWritable(dbHandle: DatabaseSync): void {
      // Connection-local settings precede every writer reservation. Journal
      // conversion itself is handled only by the transient handoff below.
      dbHandle.exec('PRAGMA busy_timeout = 1000');
      dbHandle.exec('PRAGMA synchronous = FULL');
      dbHandle.exec('PRAGMA foreign_keys = ON');
    }

    /**
     * Snapshot and writer handoff. The read transaction remains alive through
     * writer acquisition. DELETE/other journal modes use the approved
     * validation-only EXCLUSIVE reservation and immediate WAL conversion;
     * already-WAL stores stay on ordinary NORMAL locking.
     */
    function initialize(): void {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        let probe: DatabaseSync | undefined;
        let candidate: DatabaseSync | undefined;
        let probeTransaction = false;
        let candidateTransaction = false;
        try {
          validatePrivateSidecars(resolved);
          probe = new DatabaseSync(resolved, {
            readOnly: true,
            timeout: 1000,
          });
          probe.exec('BEGIN DEFERRED');
          probeTransaction = true;
          inspectSchema(probe, true);
          const mode = journalMode(probe);

          candidate = new DatabaseSync(resolved);
          startupDb = candidate;
          configureWritable(candidate);
          if (mode === 'wal') {
            candidate.exec('BEGIN IMMEDIATE');
            candidateTransaction = true;
            inspectSchema(candidate, true);
            if (releaseStartupHandle(probe, false)) {
              probe = undefined;
              throw new StoreError(
                'STORE_UNAVAILABLE',
                'Store operation failed.',
              );
            }
            probe = undefined;
            probeTransaction = false;
            db = candidate;
            try {
              bootstrap(true);
            } finally {
              candidateTransaction = false;
            }
            candidate = undefined;
            return;
          }

          candidate.exec('PRAGMA locking_mode = EXCLUSIVE');
          candidate.exec('BEGIN IMMEDIATE');
          candidateTransaction = true;
          inspectSchema(candidate, true);
          if (releaseStartupHandle(probe, false)) {
            probe = undefined;
            throw new StoreError(
              'STORE_UNAVAILABLE',
              'Store operation failed.',
            );
          }
          probe = undefined;
          probeTransaction = false;
          // Validation-only rollback retains the EXCLUSIVE pager lock but
          // avoids committing any empty-file initialization.
          candidate.exec('ROLLBACK');
          candidateTransaction = false;
          candidate.exec('PRAGMA locking_mode = NORMAL');
          const converted = candidate
            .prepare('PRAGMA journal_mode = WAL')
            .get() as { journal_mode?: unknown } | undefined;
          if (converted?.journal_mode !== 'wal') {
            throw new StoreError(
              'STORE_UNAVAILABLE',
              'Store operation failed.',
            );
          }
          db = candidate;
          bootstrap(false);
          candidate = undefined;
          return;
        } catch (error) {
          const mapped = wrapInspectionError(error);
          const probeCleanupFailed = releaseStartupHandle(
            probe,
            probeTransaction,
          );
          const candidateCleanupFailed = releaseStartupHandle(
            candidate,
            candidateTransaction,
          );
          const cleanupFailed = probeCleanupFailed || candidateCleanupFailed;
          probe = undefined;
          candidate = undefined;
          if (cleanupFailed) {
            if (
              error instanceof StoreWriteError ||
              error instanceof AmbiguousAcceptanceError
            ) {
              throw error;
            }
            throw new StoreError(
              'STORE_UNAVAILABLE',
              'Store operation failed.',
            );
          }
          if (mapped.code !== 'STORE_BUSY' || attempt >= 5) throw mapped;
          const shared = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(shared, 0, 0, 150);
        }
      }
      throw new StoreError('STORE_UNAVAILABLE', 'Store operation failed.');
    }

    initialize();
    // Initialization transferred the live connection to the returned store.
    startupDb = undefined;

    function bootstrap(alreadyBegun: boolean): void {
      inTransaction(
        'bootstrap',
        () => {
          // Only a genuinely empty application schema is eligible for creation.
          // Existing partial or unrecognized objects are refused; CREATE IF NOT
          // EXISTS is deliberately not used to fill an unknown store.
          if (schemaManifest(db).length === 0) {
            db.exec(CREATE_SQL);
            db.prepare(
              `INSERT INTO meta (key, value) VALUES ('schema_version', ?)`,
            ).run(String(SCHEMA_VERSION));
          }
          // Revalidate after BEGIN IMMEDIATE. The read-only preflight is only a
          // hint because another opener may have changed the database meanwhile.
          inspectSchema(db, false);
        },
        undefined,
        alreadyBegun,
      );
    }

    /**
     * Runs `fn` under BEGIN IMMEDIATE. Short transactions only; the lock is
     * held for synchronous work only and is always released before returning.
     *
     * COMMIT errors carry unknown outcome; maintenance/response errors
     * after COMMIT retain the known committed outcome. Neither grants
     * retry/launch authority. Disable further writes on this connection.
     */
    function inTransaction<T>(
      op: string,
      fn: () => T,
      acceptanceIdentity?: (result: T) => string,
      alreadyBegun = false,
    ): T {
      if (writesDisabled) {
        throw new StoreError(
          'STORE_UNAVAILABLE',
          'Store writes disabled after a storage failure.',
        );
      }
      if (!alreadyBegun) {
        try {
          db.exec('BEGIN IMMEDIATE');
        } catch (error) {
          throw wrapSqliteError(error);
        }
      }
      let result: T;
      try {
        result = fn();
        hooks?.beforeCommit?.(op);
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Rollback of an already-broken transaction is best effort.
        }
        throw error instanceof StoreError ? error : wrapSqliteError(error);
      }
      try {
        db.exec('COMMIT');
      } catch {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Reopen verification, not a failed rollback, establishes outcome.
        }
        writesDisabled = true;
        if (acceptanceIdentity !== undefined) {
          throw new AmbiguousAcceptanceError(
            acceptanceIdentity(result),
            'unknown',
          );
        }
        throw new StoreWriteError('unknown');
      }
      // Durable from here on. Post-commit maintenance must never reclassify
      // this operation as failed/rolled back.
      try {
        maintainSidecarPrivacy(resolved);
        hooks?.afterCommit?.(op);
      } catch {
        writesDisabled = true;
        if (acceptanceIdentity !== undefined) {
          throw new AmbiguousAcceptanceError(
            acceptanceIdentity(result),
            'committed',
          );
        }
        throw new StoreWriteError('committed');
      }
      return result;
    }

    /** Consistent read snapshot for multi-statement observation reads. */
    function inReadTransaction<T>(fn: () => T): T {
      try {
        db.exec('BEGIN DEFERRED');
      } catch (error) {
        throw wrapSqliteError(error);
      }
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Best effort.
        }
        throw error instanceof StoreError ? error : wrapSqliteError(error);
      }
    }

    function getJobRow(jobId: string, ownerUuid?: string): JobRow {
      const row = (
        ownerUuid === undefined
          ? db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId)
          : db
              .prepare(`SELECT * FROM jobs WHERE job_id = ? AND owner_uuid = ?`)
              .get(jobId, ownerUuid)
      ) as JobRow | undefined;
      if (row === undefined) {
        throw new StoreError('NOT_FOUND', 'Job not found for this owner.');
      }
      return row;
    }

    function latestResultRow(jobId: string): ResultRow | undefined {
      return db
        .prepare(
          `SELECT ${RESULT_COLUMNS} FROM job_results WHERE job_id = ?
           ORDER BY revision DESC LIMIT 1`,
        )
        .get(jobId) as ResultRow | undefined;
    }

    function getControlSnapshot(jobId: string): JobControlSnapshot {
      return rowToControl(
        db
          .prepare(
            `SELECT cancellation_requested_at_ms, launch_decision, decided_at_ms
                 FROM job_control WHERE job_id = ?`,
          )
          .get(jobId) as ControlRow | undefined,
      );
    }

    const store: JobStore = {
      reserve(input) {
        const ownerUuid = validateOwnerUuid(input.ownerUuid);
        const sessionPath = input.sessionPath;
        if (
          typeof sessionPath !== 'string' ||
          !isWellFormedNonEmpty(sessionPath)
        ) {
          throw new StoreError('VALIDATION_FAILED', 'Session path is invalid.');
        }
        const namespace = validateNamespace(input.namespace);
        const requestKey = validateRequestKey(input.requestKey);
        const command = validateCommand(input.command);
        const cwd = input.cwd;
        if (
          typeof cwd !== 'string' ||
          !isAbsolute(cwd) ||
          !isWellFormedNonEmpty(cwd)
        ) {
          throw new StoreError(
            'VALIDATION_FAILED',
            'Working directory must be an absolute, well-formed path.',
          );
        }
        const deadlineMs = validateDeadlineMs(input.deadlineMs);
        // The candidate identity is preallocated before the transaction (and
        // before any worker handoff), so ambiguous acceptance can still name
        // the job (finding #6).
        const candidateJobId = allocateReservationId(input.candidateJobId);
        return inTransaction(
          'reserve',
          () => {
            const existing = db
              .prepare(
                `SELECT * FROM jobs WHERE owner_uuid = ? AND request_namespace = ? AND request_key = ?`,
              )
              .get(ownerUuid, namespace, requestKey) as JobRow | undefined;
            if (existing !== undefined) {
              if (
                existing.command !== command ||
                existing.cwd !== cwd ||
                existing.deadline_ms !== deadlineMs
              ) {
                throw new StoreError(
                  'REQUEST_KEY_CONFLICT',
                  'An existing reservation with this key has different inputs.',
                );
              }
              // Reuse preserves the original durable identity and timestamps;
              // the fresh candidate is not adopted (finding #6).
              return {
                created: false,
                job: rowToJob(existing),
                runnerToken: null,
              };
            }
            // acceptedAt is sampled inside the successful reservation transaction.
            const acceptedAtMs = now();
            const runnerToken = randomBytes(32).toString('base64url');
            db.prepare(
              `INSERT INTO jobs (job_id, owner_uuid, owner_session_path, runner_token_hash, request_namespace, request_key, command, cwd, deadline_ms, accepted_at_ms, deadline_at_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              candidateJobId,
              ownerUuid,
              sessionPath,
              createHash('sha256').update(runnerToken).digest('hex'),
              namespace,
              requestKey,
              command,
              cwd,
              deadlineMs,
              acceptedAtMs,
              acceptedAtMs + deadlineMs,
            );
            // Control state is part of the reservation transaction. A job
            // without it is corrupt, never an invitation to synthesize a grant.
            db.prepare(`INSERT INTO job_control (job_id) VALUES (?)`).run(
              candidateJobId,
            );
            return {
              created: true,
              job: rowToJob(getJobRow(candidateJobId) as JobRow),
              runnerToken,
            };
          },
          (result) => result.job.jobId,
        );
      },

      getJob(ownerUuid, jobId) {
        return rowToJob(getJobRow(jobId, validateOwnerUuid(ownerUuid)));
      },

      listJobs(ownerUuid) {
        const rows = asJobRows(
          db
            .prepare(
              `SELECT * FROM jobs WHERE owner_uuid = ? ORDER BY creation_ordinal`,
            )
            .all(validateOwnerUuid(ownerUuid)),
        );
        return rows.map(rowToJob);
      },

      observeJob(ownerUuid, jobId) {
        const owner = validateOwnerUuid(ownerUuid);
        return inReadTransaction(() => {
          const job = getJobRow(jobId, owner);
          const claim = db
            .prepare(
              `SELECT claim_id, heartbeat_counter FROM job_claims WHERE job_id = ?`,
            )
            .get(job.job_id) as
            | { claim_id: string; heartbeat_counter: number }
            | undefined;
          const latest = latestResultRow(job.job_id);
          const control = getControlSnapshot(job.job_id);
          return {
            job: rowToJob(job),
            claimId: claim?.claim_id ?? null,
            heartbeatCounter: claim?.heartbeat_counter ?? 0,
            latestRevision: latest?.revision ?? 0,
            finalized: latest?.finalized === 1,
            evidence:
              latest === undefined ? initialEvidence() : rowToEvidence(latest),
            control,
          };
        });
      },

      requestCancellation(ownerUuid, jobId) {
        const owner = validateOwnerUuid(ownerUuid);
        return inTransaction('request_cancellation', () => {
          const job = getJobRow(jobId, owner);
          const control = getControlSnapshot(job.job_id);
          const latest = latestResultRow(job.job_id);
          if (job.state === 'settled' || latest?.finalized === 1) {
            return { disposition: 'already_terminal' as const, control };
          }
          if (control.cancellationRequestedAtMs !== null) {
            return { disposition: 'already_recorded' as const, control };
          }
          const requestedAtMs = now();
          db.prepare(
            `UPDATE job_control SET cancellation_requested_at_ms = ? WHERE job_id = ?`,
          ).run(requestedAtMs, job.job_id);
          return {
            disposition: 'recorded' as const,
            control: { ...control, cancellationRequestedAtMs: requestedAtMs },
          };
        });
      },

      decideLaunch(ownerUuid, jobId, claimId, runnerToken) {
        const owner = validateOwnerUuid(ownerUuid);
        const claim = validateClaimId(claimId);
        return inTransaction('decide_launch', () => {
          const job = getJobRow(jobId, owner);
          assertRunnerToken(job, runnerToken);
          const durableClaim = db
            .prepare(`SELECT claim_id FROM job_claims WHERE job_id = ?`)
            .get(job.job_id) as { claim_id: string } | undefined;
          if (durableClaim === undefined || durableClaim.claim_id !== claim) {
            throw new StoreError(
              'CLAIM_TAKEN',
              'Launch decision requires the matching durable runner claim.',
            );
          }
          const control = getControlSnapshot(job.job_id);
          if (control.launchDecision !== null) {
            return { disposition: 'already_decided' as const, control };
          }
          const latest = latestResultRow(job.job_id);
          if (job.state === 'settled' || !isInitialEvidenceOnly(latest)) {
            return { disposition: 'precluded' as const, control };
          }
          const decisionAtMs = now();
          const suppressed =
            control.cancellationRequestedAtMs !== null
              ? 'suppressed_cancelled'
              : decisionAtMs >= job.deadline_at_ms
                ? 'suppressed_deadline'
                : null;
          if (suppressed === null) {
            db.prepare(
              `UPDATE job_control SET launch_decision = 'authorized', decided_at_ms = ? WHERE job_id = ?`,
            ).run(decisionAtMs, job.job_id);
            return {
              disposition: 'authorized_now' as const,
              control: {
                ...control,
                launchDecision: 'authorized' as const,
                decidedAtMs: decisionAtMs,
              },
            };
          }
          const priorEvidence =
            latest === undefined ? initialEvidence() : rowToEvidence(latest);
          const merged = mergeEvidence(
            priorEvidence,
            {
              launch: suppressed,
              cleanupState: 'not_required',
              cancellationIntentObserved: suppressed === 'suppressed_cancelled',
              deadlineTriggerObserved: suppressed === 'suppressed_deadline',
              finalized: true,
            },
            { uncertain: false, finalized: true },
          );
          const revision = (latest?.revision ?? 0) + 1;
          const publishedAtMs = decisionAtMs;
          db.prepare(
            `UPDATE job_control SET launch_decision = ?, decided_at_ms = ? WHERE job_id = ?`,
          ).run(suppressed, decisionAtMs, job.job_id);
          db.prepare(
            `INSERT INTO job_results (job_id, ${RESULT_COLUMNS.replace(/\s+/g, ' ')})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            job.job_id,
            revision,
            ...evidenceToParams(merged),
            publishedAtMs,
          );
          db.prepare(
            `INSERT INTO job_notices (job_id, revision, owner_uuid, pending) VALUES (?, ?, ?, 1)`,
          ).run(job.job_id, revision, job.owner_uuid);
          db.prepare(`UPDATE jobs SET state = 'settled' WHERE job_id = ?`).run(
            job.job_id,
          );
          return {
            disposition: 'suppressed_now' as const,
            control: {
              ...control,
              launchDecision: suppressed,
              decidedAtMs: decisionAtMs,
            },
          };
        });
      },

      claimRunner(ownerUuid, jobId, claimId, runnerToken) {
        const owner = validateOwnerUuid(ownerUuid);
        const claim = validateClaimId(claimId);
        return inTransaction('claim_runner', () => {
          const job = getJobRow(jobId, owner);
          assertRunnerToken(job, runnerToken);
          const existing = db
            .prepare(`SELECT claim_id FROM job_claims WHERE job_id = ?`)
            .get(job.job_id) as { claim_id: string } | undefined;
          if (existing !== undefined || job.state !== 'reserved') {
            throw new StoreError(
              'CLAIM_TAKEN',
              'This reservation was already claimed.',
            );
          }
          const claimedAtMs = now();
          db.prepare(
            `INSERT INTO job_claims (job_id, claim_id, claimed_at_ms, heartbeat_counter) VALUES (?, ?, ?, 0)`,
          ).run(job.job_id, claim, claimedAtMs);
          db.prepare(`UPDATE jobs SET state = 'claimed' WHERE job_id = ?`).run(
            job.job_id,
          );
          return { claimId: claim, claimedAtMs, heartbeatCounter: 0 };
        });
      },

      heartbeat(ownerUuid, jobId, claimId, expectedCounter, runnerToken) {
        const owner = validateOwnerUuid(ownerUuid);
        const claim = validateClaimId(claimId);
        return inTransaction('heartbeat', () => {
          // Owner fence first: a foreign owner learns nothing (NOT_FOUND).
          const job = getJobRow(jobId, owner);
          assertRunnerToken(job, runnerToken);
          const result = db
            .prepare(
              `UPDATE job_claims SET heartbeat_counter = ?, heartbeat_at_ms = ?
               WHERE job_id = ? AND claim_id = ? AND heartbeat_counter = ?`,
            )
            .run(
              expectedCounter + 1,
              now(),
              job.job_id,
              claim,
              expectedCounter,
            );
          if (Number(result.changes) !== 1) {
            throw new StoreError(
              'REVISION_STALE',
              'Heartbeat lost the race to a concurrent writer.',
            );
          }
          return { counter: expectedCounter + 1 };
        });
      },

      publishResult(
        ownerUuid,
        jobId,
        claimId,
        expectedRevision,
        evidence,
        runnerToken,
      ) {
        const owner = validateOwnerUuid(ownerUuid);
        const claim = validateClaimId(claimId);
        const input = validateEvidenceInput(evidence);
        return inTransaction('publish_result', () => {
          const job = getJobRow(jobId, owner);
          assertRunnerToken(job, runnerToken);
          // Runner fence: verify the original durable claim in this same
          // transaction (finding #7). A reservation that was never
          // runner-claimed, or a mismatched claim, cannot publish.
          const durableClaim = db
            .prepare(`SELECT claim_id FROM job_claims WHERE job_id = ?`)
            .get(job.job_id) as { claim_id: string } | undefined;
          if (durableClaim === undefined || durableClaim.claim_id !== claim) {
            throw new StoreError(
              'CLAIM_TAKEN',
              'Result publication requires the matching durable runner claim.',
            );
          }
          const latest = latestResultRow(job.job_id);
          if (latest?.finalized === 1) {
            throw new StoreError(
              'REVISION_STALE',
              'A known shell outcome is already preserved.',
            );
          }
          const latestRevision = latest?.revision ?? 0;
          if (
            expectedRevision === null
              ? latestRevision !== 0
              : expectedRevision !== latestRevision
          ) {
            throw new StoreError(
              'REVISION_STALE',
              'Result revision lost the race.',
            );
          }
          const finalized = input.finalized === true;
          const merged = mergeEvidence(
            latest === undefined ? initialEvidence() : rowToEvidence(latest),
            input,
            { uncertain: !finalized, finalized },
          );
          const revision = latestRevision + 1;
          const publishedAtMs = now();
          db.prepare(
            `INSERT INTO job_results (job_id, ${RESULT_COLUMNS.replace(/\s+/g, ' ')})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            job.job_id,
            revision,
            ...evidenceToParams(merged),
            publishedAtMs,
          );
          db.prepare(
            `INSERT INTO job_notices (job_id, revision, owner_uuid, pending) VALUES (?, ?, ?, 1)`,
          ).run(job.job_id, revision, job.owner_uuid);
          if (finalized) {
            db.prepare(
              `UPDATE jobs SET state = 'settled' WHERE job_id = ?`,
            ).run(job.job_id);
          }
          return {
            jobId: job.job_id,
            revision,
            evidence: merged,
            publishedAtMs,
          };
        });
      },

      publishUncertainResult(ownerUuid, jobId, witness) {
        const owner = validateOwnerUuid(ownerUuid);
        return inTransaction('publish_uncertain', () => {
          // Owner-scoped reconciler CAS (findings #7, #8): recheck owner
          // (fenced lookup), claim, heartbeat, evidence version and
          // non-finalized state in this one transaction.
          const job = getJobRow(jobId, owner);
          if (job.state === 'settled') {
            throw new StoreError(
              'REVISION_STALE',
              'A known shell outcome is already recorded.',
            );
          }
          const latest = latestResultRow(job.job_id);
          if (latest?.finalized === 1) {
            throw new StoreError(
              'REVISION_STALE',
              'A known shell outcome is already preserved.',
            );
          }
          const latestRevision = latest?.revision ?? 0;
          if (witness.observedRevision !== latestRevision) {
            throw new StoreError(
              'REVISION_STALE',
              'Observation lost the race to a newer evidence revision.',
            );
          }
          const claim = db
            .prepare(
              `SELECT claim_id, heartbeat_counter FROM job_claims WHERE job_id = ?`,
            )
            .get(job.job_id) as
            | { claim_id: string; heartbeat_counter: number }
            | undefined;
          const currentClaimId = claim?.claim_id ?? null;
          const currentCounter = claim?.heartbeat_counter ?? 0;
          if (
            currentClaimId !== witness.observedClaimId ||
            currentCounter !== witness.observedCounter
          ) {
            throw new StoreError(
              'REVISION_STALE',
              'Observation lost the race to fresh activity.',
            );
          }
          // Unclaimed observations are keyed with an empty claim id.
          const witnessClaimId = witness.observedClaimId ?? '';
          const prior = db
            .prepare(
              `SELECT 1 FROM stale_witnesses WHERE job_id = ? AND observed_claim_id = ? AND observed_counter = ?`,
            )
            .get(job.job_id, witnessClaimId, witness.observedCounter);
          if (prior !== undefined) {
            throw new StoreError(
              'REVISION_STALE',
              'This observation already produced a revision.',
            );
          }
          // Pure uncertainty snapshot: every established fact is copied and
          // nothing new is claimed (finding #8).
          const priorEvidence =
            latest === undefined ? initialEvidence() : rowToEvidence(latest);
          const merged = mergeEvidence(
            priorEvidence,
            {},
            {
              uncertain: true,
              finalized: false,
            },
          );
          const revision = latestRevision + 1;
          const publishedAtMs = now();
          db.prepare(
            `INSERT INTO job_results (job_id, ${RESULT_COLUMNS.replace(/\s+/g, ' ')})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            job.job_id,
            revision,
            ...evidenceToParams(merged),
            publishedAtMs,
          );
          db.prepare(
            `INSERT INTO job_notices (job_id, revision, owner_uuid, pending) VALUES (?, ?, ?, 1)`,
          ).run(job.job_id, revision, job.owner_uuid);
          db.prepare(
            `INSERT INTO stale_witnesses (job_id, observed_claim_id, observed_counter, observed_revision, committed_at_ms) VALUES (?, ?, ?, ?, ?)`,
          ).run(
            job.job_id,
            witnessClaimId,
            witness.observedCounter,
            witness.observedRevision,
            publishedAtMs,
          );
          return {
            jobId: job.job_id,
            revision,
            evidence: merged,
            publishedAtMs,
          };
        });
      },

      acknowledgeNotice(ownerUuid, jobId, revision) {
        inTransaction('acknowledge_notice', () => {
          const result = db
            .prepare(
              `UPDATE job_notices SET pending = 0, acknowledged_at_ms = ?
               WHERE job_id = ? AND revision = ? AND owner_uuid = ?`,
            )
            .run(now(), jobId, revision, validateOwnerUuid(ownerUuid));
          if (Number(result.changes) !== 1) {
            throw new StoreError(
              'NOT_FOUND',
              'Notice not found for this owner.',
            );
          }
        });
      },

      listNotices(ownerUuid, jobId) {
        const rows = db
          .prepare(
            `SELECT n.job_id, n.revision, n.pending, n.acknowledged_at_ms FROM job_notices n
             JOIN jobs j ON j.job_id = n.job_id
             WHERE n.owner_uuid = ? AND n.job_id = ?
             ORDER BY n.revision`,
          )
          .all(validateOwnerUuid(ownerUuid), jobId) as Array<{
          job_id: string;
          revision: number;
          pending: number;
          acknowledged_at_ms: number | null;
        }>;
        return rows.map((row) => ({
          jobId: row.job_id,
          ownerUuid: ownerUuid,
          revision: row.revision,
          pending: row.pending === 1,
          acknowledgedAtMs: row.acknowledged_at_ms,
        }));
      },

      listPendingNotices(ownerUuid) {
        const rows = db
          .prepare(
            `SELECT n.job_id, n.revision, n.pending, n.acknowledged_at_ms FROM job_notices n
             JOIN jobs j ON j.job_id = n.job_id
             WHERE n.owner_uuid = ? AND n.pending = 1
             ORDER BY j.creation_ordinal, n.revision`,
          )
          .all(validateOwnerUuid(ownerUuid)) as Array<{
          job_id: string;
          revision: number;
          pending: number;
          acknowledged_at_ms: number | null;
        }>;
        return rows.map((row) => ({
          jobId: row.job_id,
          ownerUuid: ownerUuid,
          revision: row.revision,
          pending: row.pending === 1,
          acknowledgedAtMs: row.acknowledged_at_ms,
        }));
      },

      listResults(ownerUuid, jobId) {
        // SAFETY: the selected columns match ResultRow in our declared schema.
        const rows = db
          .prepare(
            `SELECT r.revision, r.launch, r.shell_code, r.shell_signal, r.cleanup_state,
                    r.cleanup_term_observation, r.cleanup_kill_intent, r.cancellation_intent,
                    r.deadline_trigger,
                    r.stdout_available, r.stdout_truncated, r.stdout_incomplete, r.stdout_open_at_cutover,
                    r.stderr_available, r.stderr_truncated, r.stderr_incomplete, r.stderr_open_at_cutover,
                    r.uncertain, r.finalized, r.published_at_ms
             FROM job_results r JOIN jobs j ON j.job_id = r.job_id
             WHERE j.owner_uuid = ? AND r.job_id = ? ORDER BY r.revision`,
          )
          .all(validateOwnerUuid(ownerUuid), jobId) as unknown as ResultRow[];
        return rows.map((row) => ({
          jobId,
          revision: row.revision,
          evidence: rowToEvidence(row),
          publishedAtMs: row.published_at_ms,
        }));
      },

      close() {
        db.close();
      },
    };
    return store;
  } catch (error) {
    // Startup cleanup owns the candidate handle. Do not close it a second time
    // after initialize has already attempted cleanup, especially when the
    // original failure carries a committed/unknown write receipt.
    if (startupDb !== undefined) {
      try {
        startupDb.close();
      } catch {
        // Cleanup failure is reported by the original startup error below.
      }
      startupDb = undefined;
    }
    // Raw engine failures (e.g. "database is locked" while setting WAL on a
    // concurrently opened store) must surface as store diagnostics.
    throw error instanceof StoreError ? error : wrapSqliteError(error);
  }
}
