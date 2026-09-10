/**
 * Shared error and diagnostics vocabulary for the U1 store stack
 * (owner validation, SQLite store, worker, client).
 *
 * Diagnostics boundary (plan §Diagnostics boundary): every store-facing
 * failure surfaces as a stable error code plus, at most, a message authored
 * from explicitly allowlisted, non-sensitive fields. Raw error content,
 * stacks, commands, cwd, owner/session paths, and store paths never escape
 * through {@link toDiagnostic}.
 */
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';

const STORE_ERROR_CODES = [
  'OWNER_REJECTED',
  'VALIDATION_FAILED',
  'REQUEST_KEY_CONFLICT',
  'NOT_FOUND',
  'CLAIM_TAKEN',
  'REVISION_STALE',
  'ACCEPTANCE_UNCONFIRMED',
  'STORE_BUSY',
  'STORE_UNAVAILABLE',
  'RUNTIME_UNSUPPORTED',
  'SCHEMA_TOO_NEW',
  'STORE_CORRUPT',
  'PATH_UNSAFE',
] as const;

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message?: string) {
    // Messages must be authored from allowlisted, non-sensitive content only.
    super(message ?? code);
    this.name = 'StoreError';
    this.code = code;
  }
}

/**
 * Reservation response loss. Retain the preallocated candidate, or the
 * existing job ID when a replay was resolved before the response was lost.
 * Unknown is not a commit receipt and this error never grants launch authority.
 */
export class AmbiguousAcceptanceError extends StoreError {
  readonly candidateJobId: string;
  readonly commitOutcome: 'unknown' | 'committed';

  constructor(
    candidateJobId: string,
    commitOutcome: 'unknown' | 'committed' = 'unknown',
  ) {
    super(
      'ACCEPTANCE_UNCONFIRMED',
      'Reservation response unavailable; reconcile metadata without launching.',
    );
    this.name = 'AmbiguousAcceptanceError';
    this.candidateJobId = candidateJobId;
    this.commitOutcome = commitOutcome;
  }
}

/** A missing write response is not proof of rollback or permission to retry. */
export class StoreWriteError extends StoreError {
  readonly commitOutcome: 'unknown' | 'committed';

  constructor(commitOutcome: 'unknown' | 'committed') {
    super(
      'STORE_UNAVAILABLE',
      'Store write response unavailable; inspect durable state.',
    );
    this.name = 'StoreWriteError';
    this.commitOutcome = commitOutcome;
  }
}

/** Allocate/validate before persistence or worker handoff, not inside it. */
export function allocateReservationId(candidate: unknown = undefined): string {
  if (candidate === undefined) return randomUUID();
  if (
    typeof candidate !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      candidate,
    )
  ) {
    throw new StoreError(
      'VALIDATION_FAILED',
      'Candidate job id must be a UUID.',
    );
  }
  return candidate.toLowerCase();
}

/** Nonempty, NUL-free, well-formed Unicode (no lone surrogates). */
export function isWellFormedNonEmpty(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\u0000') &&
    /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(value)
  );
}

function requireString(value: unknown, label: string): string {
  // "Nonempty" also excludes whitespace-only strings; comparison itself
  // stays exact (no trim, no Unicode normalization).
  if (
    typeof value !== 'string' ||
    !isWellFormedNonEmpty(value) ||
    value.trim().length === 0
  ) {
    throw new StoreError(
      'VALIDATION_FAILED',
      `${label} must be a nonempty, well-formed Unicode string.`,
    );
  }
  return value;
}

/**
 * Validates a command string (plan §Start and replay): nonempty, NUL-free,
 * well-formed Unicode. Comparison stays exact — no trim, no normalization.
 */
export function validateCommand(command: unknown): string {
  return requireString(command, 'Command');
}

export const DEFAULT_DEADLINE_MS = 1_800_000;
export const MAX_DEADLINE_MS = 86_400_000;

/** Integer duration 1..86,400,000 ms; defaults to 30 minutes when omitted. */
export function validateDeadlineMs(deadlineMs: unknown): number {
  if (deadlineMs === undefined) return DEFAULT_DEADLINE_MS;
  if (
    typeof deadlineMs !== 'number' ||
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_DEADLINE_MS
  ) {
    throw new StoreError(
      'VALIDATION_FAILED',
      'Deadline must be an integer between 1 and 86,400,000 ms.',
    );
  }
  return deadlineMs;
}

const REQUEST_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Explicit request keys: 1–128 ASCII chars, no trim, no case folding. */
export function validateRequestKey(requestKey: unknown): string {
  if (typeof requestKey !== 'string' || !REQUEST_KEY_RE.test(requestKey)) {
    throw new StoreError(
      'VALIDATION_FAILED',
      'Request key must be 1-128 ASCII characters matching [A-Za-z0-9][A-Za-z0-9._:-]*.',
    );
  }
  return requestKey;
}

/**
 * Lexically resolves an omitted/relative cwd against the trusted current cwd.
 * Deliberately does NOT use filesystem realpath — the absolute lexical path
 * string is the invocation-identity component (plan §Start and replay).
 */
export function resolveCwd(cwd: unknown, trustedCurrentCwd: string): string {
  if (cwd === undefined) return resolvePath(trustedCurrentCwd);
  return resolvePath(
    trustedCurrentCwd,
    requireString(cwd, 'Working directory'),
  );
}

export interface StoreDiagnostic {
  code: StoreErrorCode | 'UNKNOWN';
  message?: string;
}

/**
 * Projects any thrown value onto the allowlisted diagnostic shape.
 * Non-StoreError values (library errors, OOM, network) collapse to
 * `UNKNOWN` with no message so private paths or error text cannot leak.
 */
export function toDiagnostic(error: unknown): StoreDiagnostic {
  if (error instanceof StoreError) {
    return error.message === error.code
      ? { code: error.code }
      : { code: error.code, message: error.message };
  }
  return { code: 'UNKNOWN' };
}
