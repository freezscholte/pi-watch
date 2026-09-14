/**
 * Fixed private on-disk layout shared by the store and bounded output code.
 *
 * The trusted root is the only caller-selected anchor. It is canonicalized
 * once; every descendant is then derived lexically and checked without
 * following symlinks. Capture callers can select only a lowercase job UUID
 * and one of the two fixed streams.
 *
 * The active same-UID namespace mutation threat is intentionally outside the
 * v0.1 boundary. Opened artifacts are nevertheless identity-bound and their
 * final path binding must still match before evidence is trusted.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { StoreError } from './job-types.ts';

export type CaptureStream = 'stdout' | 'stderr';

export interface FileIdentity {
  dev: number;
  ino: number;
}

export interface CapturePaths {
  raw: string;
  truncated: string;
  closedTemporary: string;
  closed: string;
}

export type CaptureArtifact = keyof CapturePaths;

const JOB_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pathError(message: string): StoreError {
  return new StoreError('PATH_UNSAFE', message);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function strictDescendantParts(path: string, root: string): string[] | null {
  if (path === root) return null;
  if (root === sep)
    return path.startsWith(sep) ? path.slice(sep.length).split(sep) : null;
  const prefix = root + sep;
  return path.startsWith(prefix) ? path.slice(prefix.length).split(sep) : null;
}

function appendPath(root: string, parts: string[]): string {
  return root === sep ? sep + parts.join(sep) : root + sep + parts.join(sep);
}

function isWellFormedNonEmpty(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\u0000') &&
    /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(value)
  );
}

function expectedUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function privateMode(stat: Stats, mode: number): boolean {
  return (Number(stat.mode) & 0o7777) === mode;
}

function validatePrivateDirectory(path: string, owner: boolean): Stats {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw pathError('Private directory is not accessible.');
  }
  const uid = expectedUid();
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !privateMode(stat, 0o700) ||
    (owner && uid !== undefined && stat.uid !== uid)
  ) {
    throw pathError('Private directory is unsafe.');
  }
  return stat;
}

function ensurePrivateDirectory(path: string, owner: boolean): Stats {
  try {
    mkdirSync(path, { recursive: false, mode: 0o700 });
    chmodSync(path, 0o700);
  } catch (error) {
    if (!isErrno(error, 'EEXIST'))
      throw pathError('Private directory is not accessible.');
  }
  return validatePrivateDirectory(path, owner);
}

/**
 * Preserves the original store-path behavior while making canonical layout
 * derivation reusable. Only descendants are created; the trusted root itself
 * is never chmod-ed.
 */
export function prepareDatabasePath(
  dbPath: string,
  trustedRoot: string,
): string {
  if (!isAbsolute(dbPath) || !isWellFormedNonEmpty(dbPath))
    throw pathError('Store path must be absolute and well-formed.');
  if (
    typeof trustedRoot !== 'string' ||
    !isAbsolute(trustedRoot) ||
    !isWellFormedNonEmpty(trustedRoot)
  ) {
    throw pathError('Trusted root must be an absolute, well-formed path.');
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(trustedRoot);
  } catch {
    throw pathError('Trusted root must exist and be accessible.');
  }
  let rootStat: Stats;
  try {
    rootStat = lstatSync(rootReal);
  } catch {
    throw pathError('Trusted root must exist and be accessible.');
  }
  if (!rootStat.isDirectory())
    throw pathError('Trusted root is not a directory.');

  const resolved = resolvePath(dbPath);
  const rootSupplied = resolvePath(trustedRoot);
  const parts =
    strictDescendantParts(resolved, rootSupplied) ??
    strictDescendantParts(resolved, rootReal);
  if (parts === null)
    throw pathError('Store path must be strictly inside the trusted root.');

  const canonicalResolved = appendPath(rootReal, parts);
  let current = rootReal;
  for (const part of parts.slice(0, -1)) {
    current = appendPath(current, [part]);
    let componentStat: Stats;
    try {
      componentStat = lstatSync(current);
    } catch (error) {
      if (!isErrno(error, 'ENOENT'))
        throw pathError('Store path component is not accessible.');
      try {
        mkdirSync(current, { recursive: false, mode: 0o700 });
        chmodSync(current, 0o700);
        componentStat = lstatSync(current);
      } catch (mkdirError) {
        if (!isErrno(mkdirError, 'EEXIST'))
          throw pathError('Store path component is not accessible.');
        try {
          componentStat = lstatSync(current);
        } catch {
          throw pathError('Store path component is not accessible.');
        }
      }
    }
    if (
      componentStat.isSymbolicLink() ||
      !componentStat.isDirectory() ||
      !privateMode(componentStat, 0o700)
    ) {
      throw pathError('Store path component is unsafe.');
    }
  }

  let fileStat: Stats | null;
  try {
    fileStat = lstatSync(canonicalResolved);
  } catch (error) {
    if (!isErrno(error, 'ENOENT'))
      throw pathError('Store database path is not accessible.');
    fileStat = null;
  }
  if (fileStat && (fileStat.isSymbolicLink() || !fileStat.isFile()))
    throw pathError('Store database path is unsafe.');
  return canonicalResolved;
}

export class FixedLayout {
  readonly databasePath: string;
  readonly #databaseDirectory: string;

  constructor(databasePath: string, token: symbol) {
    if (token !== layoutToken)
      throw pathError('Fixed private layout is required.');
    this.databasePath = databasePath;
    this.#databaseDirectory = dirname(databasePath);
  }

  workspacePath(jobId: string): string {
    validateJobId(jobId);
    return appendPath(this.#databaseDirectory, ['jobs', jobId]);
  }

  paths(jobId: string, stream: CaptureStream): CapturePaths {
    validateJobId(jobId);
    validateStream(stream);
    const workspace = this.workspacePath(jobId);
    return {
      raw: appendPath(workspace, [`${stream}.raw`]),
      truncated: appendPath(workspace, [`${stream}.truncated`]),
      closedTemporary: appendPath(workspace, [`${stream}.closed.json.tmp`]),
      closed: appendPath(workspace, [`${stream}.closed.json`]),
    };
  }
}

const layoutToken = Symbol('fixed-layout');

export function prepareFixedLayout(
  dbPath: string,
  trustedRoot: string,
): FixedLayout {
  const databasePath = prepareDatabasePath(dbPath, trustedRoot);
  if (basename(databasePath) !== 'jobs.sqlite')
    throw pathError('Store database filename is unsafe.');

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(trustedRoot);
  } catch {
    throw pathError('Trusted root must exist and be accessible.');
  }
  const directoryParts = strictDescendantParts(
    dirname(databasePath),
    canonicalRoot,
  );
  if (directoryParts !== null) {
    let current = canonicalRoot;
    for (const part of directoryParts) {
      current = appendPath(current, [part]);
      validatePrivateDirectory(current, true);
    }
  }
  return new FixedLayout(databasePath, layoutToken);
}

function validateJobId(jobId: unknown): asserts jobId is string {
  if (typeof jobId !== 'string' || !JOB_UUID_RE.test(jobId))
    throw pathError('Job id is invalid for private layout.');
}

function validateStream(stream: unknown): asserts stream is CaptureStream {
  if (stream !== 'stdout' && stream !== 'stderr')
    throw pathError('Capture stream is invalid.');
}

export class CaptureWorkspace {
  readonly directory: string;
  readonly jobId: string;
  readonly #layout: FixedLayout;
  readonly #identity: FileIdentity;

  constructor(
    layout: FixedLayout,
    jobId: string,
    identity: FileIdentity,
    token: symbol,
  ) {
    if (token !== workspaceToken || !(layout instanceof FixedLayout))
      throw pathError('Fixed capture workspace is required.');
    this.#layout = layout;
    this.jobId = jobId;
    this.directory = layout.workspacePath(jobId);
    this.#identity = identity;
  }

  paths(stream: CaptureStream): CapturePaths {
    return this.#layout.paths(this.jobId, stream);
  }

  verify(): boolean {
    try {
      const stat = validatePrivateDirectory(this.directory, true);
      return stat.dev === this.#identity.dev && stat.ino === this.#identity.ino;
    } catch {
      return false;
    }
  }
}

const workspaceToken = Symbol('capture-workspace');

/** Creates one fresh per-job workspace; leftovers are never reused. */
export function prepareCaptureWorkspace(
  layout: FixedLayout,
  jobId: string,
): CaptureWorkspace {
  if (!(layout instanceof FixedLayout))
    throw pathError('Fixed private layout is required.');
  validateJobId(jobId);
  const jobs = dirname(layout.workspacePath(jobId));
  ensurePrivateDirectory(jobs, true);
  const directory = layout.workspacePath(jobId);
  try {
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    chmodSync(directory, 0o700);
  } catch {
    throw pathError('Capture workspace already exists or is inaccessible.');
  }
  const stat = validatePrivateDirectory(directory, true);
  return new CaptureWorkspace(
    layout,
    jobId,
    { dev: stat.dev, ino: stat.ino },
    workspaceToken,
  );
}

/** Rebinds an existing fixed workspace for an already-authorized read. */
export function openCaptureWorkspace(
  layout: FixedLayout,
  jobId: string,
): CaptureWorkspace {
  if (!(layout instanceof FixedLayout))
    throw pathError('Fixed private layout is required.');
  validateJobId(jobId);
  const directory = layout.workspacePath(jobId);
  validatePrivateDirectory(dirname(directory), true);
  const stat = validatePrivateDirectory(directory, true);
  return new CaptureWorkspace(
    layout,
    jobId,
    { dev: stat.dev, ino: stat.ino },
    workspaceToken,
  );
}

export interface OpenedPrivateFile {
  fd: number;
  identity: FileIdentity;
}

function artifactPath(
  workspace: CaptureWorkspace,
  stream: CaptureStream,
  artifact: CaptureArtifact,
): string {
  if (!(workspace instanceof CaptureWorkspace))
    throw pathError('Fixed capture workspace is required.');
  validateStream(stream);
  if (
    artifact !== 'raw' &&
    artifact !== 'truncated' &&
    artifact !== 'closedTemporary' &&
    artifact !== 'closed'
  ) {
    throw pathError('Capture artifact is invalid.');
  }
  return workspace.paths(stream)[artifact];
}

/** Opens one new fixed artifact with exclusive, private, no-follow semantics. */
export function createPrivateArtifact(
  workspace: CaptureWorkspace,
  stream: CaptureStream,
  artifact: CaptureArtifact,
): OpenedPrivateFile {
  const path = artifactPath(workspace, stream, artifact);
  if (!workspace.verify())
    throw pathError('Capture workspace binding changed.');
  let fd = -1;
  try {
    fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    const stat = fstatSync(fd);
    const uid = expectedUid();
    if (
      !stat.isFile() ||
      !privateMode(stat, 0o600) ||
      stat.nlink !== 1 ||
      (uid !== undefined && stat.uid !== uid)
    ) {
      throw pathError('Private artifact is unsafe.');
    }
    const identity = { dev: stat.dev, ino: stat.ino };
    if (
      !workspace.verify() ||
      !privateFileBindingMatches(workspace, stream, artifact, identity)
    )
      throw pathError('Private artifact binding changed.');
    return { fd, identity };
  } catch (error) {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // The fixed redacted failure below owns this boundary.
      }
    }
    if (error instanceof StoreError) throw error;
    throw pathError('Private artifact could not be created safely.');
  }
}

export function privateFileBindingMatches(
  workspace: CaptureWorkspace,
  stream: CaptureStream,
  artifact: CaptureArtifact,
  identity: FileIdentity,
): boolean {
  const path = artifactPath(workspace, stream, artifact);
  try {
    if (!workspace.verify()) return false;
    const stat = lstatSync(path);
    const uid = expectedUid();
    return (
      !stat.isSymbolicLink() &&
      stat.isFile() &&
      privateMode(stat, 0o600) &&
      stat.nlink === 1 &&
      (uid === undefined || stat.uid === uid) &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino
    );
  } catch {
    return false;
  }
}

export function inspectPrivateFile(
  workspace: CaptureWorkspace,
  stream: CaptureStream,
  artifact: CaptureArtifact,
): (FileIdentity & { size: number }) | null {
  const path = artifactPath(workspace, stream, artifact);
  try {
    if (!workspace.verify()) return null;
    const stat = lstatSync(path);
    const uid = expectedUid();
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      !privateMode(stat, 0o600) ||
      stat.nlink !== 1 ||
      (uid !== undefined && stat.uid !== uid)
    ) {
      return null;
    }
    return { dev: stat.dev, ino: stat.ino, size: stat.size };
  } catch {
    return null;
  }
}
