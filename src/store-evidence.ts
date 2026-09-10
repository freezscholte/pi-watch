/**
 * Independent lifecycle evidence primitives (plan KTD5) for the durable job
 * store. Persistence primitives only: no command, signal, timer, polling or
 * delivery actor lives here.
 *
 * Each durable result revision stores a full merged evidence snapshot. An
 * incoming observation is merged monotonically onto the latest known
 * snapshot: known shell/capture/cleanup facts survive uncertainty, and a
 * contradictory observation is rejected instead of erasing knowledge.
 *
 * Distinct facts that must never collapse (R8-R10, KTD5):
 * - launch phase / established non-execution,
 * - immutable acceptance/deadline timestamps (stored on the job row),
 * - cancellation intent and deadline-trigger observations,
 * - known-or-unknown root-shell outcome (code and signal are independent),
 * - best-effort cleanup state plus TERM/KILL observation facts,
 * - per-stream (stdout/stderr) availability, retention truncation,
 *   incompleteness and open-at-cutover.
 * There is no aggregate all-stop success field, and cleanup `not_required`
 * requires established non-execution.
 */
import { StoreError } from './job-types.ts';

export type LaunchPhase =
  | 'unknown'
  | 'suppressed_cancelled'
  | 'suppressed_deadline'
  | 'spawn_failed'
  | 'launched';

export type CleanupState =
  | 'not_required'
  | 'not_requested'
  | 'pending'
  | 'unconfirmed';

export type CleanupTermObservation = 'returned' | 'error';

/** Per-stream capture facts; truncation and incompleteness are independent. */
export interface StreamCaptureFacts {
  /** null: not observed; false: explicitly unavailable; true: available. */
  available: boolean | null;
  /** Retention truncation: the retained prefix hit the R15 byte bound. */
  truncated: boolean;
  /** Capture ended without a complete retained transcript. */
  incomplete: boolean;
  /** The stream was still open at capture cutover. */
  openAtCutover: boolean;
}

/** Full durable evidence snapshot carried by one result revision. */
export interface ExecutionEvidence {
  launch: LaunchPhase;
  shellCode: number | null;
  shellSignal: string | null;
  cleanupState: CleanupState;
  cleanupTermObservation: CleanupTermObservation | null;
  cleanupKillIntentObserved: boolean;
  cancellationIntentObserved: boolean;
  deadlineTriggerObserved: boolean;
  stdout: StreamCaptureFacts;
  stderr: StreamCaptureFacts;
  /** Revision-level flag: the observation is not a finalized result. */
  uncertain: boolean;
  finalized: boolean;
}

/**
 * Typed observation input for a runner-authored publication. Omitted
 * fields carry the previous known value; present fields are observations
 * that must not contradict established facts.
 */
export interface EvidenceInput {
  launch?: LaunchPhase;
  shellCode?: number | null;
  shellSignal?: string | null;
  cleanupState?: CleanupState;
  cleanupTermObservation?: CleanupTermObservation | null;
  cleanupKillIntentObserved?: boolean;
  cancellationIntentObserved?: boolean;
  deadlineTriggerObserved?: boolean;
  stdout?: Partial<StreamCaptureFacts>;
  stderr?: Partial<StreamCaptureFacts>;
  finalized?: boolean;
}

const LAUNCH_PHASES: readonly LaunchPhase[] = [
  'unknown',
  'suppressed_cancelled',
  'suppressed_deadline',
  'spawn_failed',
  'launched',
];

const CLEANUP_STATES: readonly CleanupState[] = [
  'not_required',
  'not_requested',
  'pending',
  'unconfirmed',
];

const TERM_OBSERVATIONS: readonly CleanupTermObservation[] = [
  'returned',
  'error',
];

/** Launch phases that establish the command did not run. */
const NON_EXECUTION_LAUNCH: readonly LaunchPhase[] = [
  'suppressed_cancelled',
  'suppressed_deadline',
  'spawn_failed',
];

const STREAM_FACT_KEYS = [
  'available',
  'truncated',
  'incomplete',
  'openAtCutover',
] as const;

const EVIDENCE_KEYS = [
  'launch',
  'shellCode',
  'shellSignal',
  'cleanupState',
  'cleanupTermObservation',
  'cleanupKillIntentObserved',
  'cancellationIntentObserved',
  'deadlineTriggerObserved',
  'stdout',
  'stderr',
  'finalized',
] as const;

function validationError(message: string): StoreError {
  return new StoreError('VALIDATION_FAILED', message);
}

/** Cleanup certainty order; a regression to a lower state is a contradiction. */
const CLEANUP_ORDER: Record<CleanupState, number> = {
  not_required: 0,
  not_requested: 1,
  pending: 2,
  unconfirmed: 3,
};

function defaultStreamFacts(): StreamCaptureFacts {
  return {
    available: null,
    truncated: false,
    incomplete: false,
    openAtCutover: false,
  };
}

/** The all-unknown snapshot a first observation starts from. */
export function initialEvidence(): ExecutionEvidence {
  return {
    launch: 'unknown',
    shellCode: null,
    shellSignal: null,
    cleanupState: 'not_requested',
    cleanupTermObservation: null,
    cleanupKillIntentObserved: false,
    cancellationIntentObserved: false,
    deadlineTriggerObserved: false,
    stdout: defaultStreamFacts(),
    stderr: defaultStreamFacts(),
    uncertain: true,
    finalized: false,
  };
}

/** Validates the shape and enum domains of an evidence observation. */
export function validateEvidenceInput(input: unknown): EvidenceInput {
  if (typeof input !== 'object' || input === null) {
    throw new StoreError('VALIDATION_FAILED', 'Evidence must be an object.');
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(EVIDENCE_KEYS as readonly string[]).includes(key)) {
      throw validationError(`Unknown evidence property: ${key}.`);
    }
  }
  if (
    raw.launch !== undefined &&
    !LAUNCH_PHASES.includes(raw.launch as LaunchPhase)
  ) {
    throw validationError('Launch phase is invalid.');
  }
  if (
    raw.shellCode !== undefined &&
    raw.shellCode !== null &&
    (typeof raw.shellCode !== 'number' || !Number.isInteger(raw.shellCode))
  ) {
    throw validationError('Shell code must be an integer.');
  }
  if (
    raw.shellSignal !== undefined &&
    raw.shellSignal !== null &&
    typeof raw.shellSignal !== 'string'
  ) {
    throw validationError('Shell signal must be a string.');
  }
  if (
    raw.cleanupState !== undefined &&
    !CLEANUP_STATES.includes(raw.cleanupState as CleanupState)
  ) {
    throw validationError('Cleanup state is invalid.');
  }
  if (
    raw.cleanupTermObservation !== undefined &&
    raw.cleanupTermObservation !== null &&
    !TERM_OBSERVATIONS.includes(
      raw.cleanupTermObservation as CleanupTermObservation,
    )
  ) {
    throw validationError('Cleanup TERM observation is invalid.');
  }
  for (const key of [
    'cleanupKillIntentObserved',
    'cancellationIntentObserved',
    'deadlineTriggerObserved',
    'finalized',
  ] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
      throw validationError(`${key} must be a boolean.`);
    }
  }
  for (const key of ['stdout', 'stderr'] as const) {
    const stream = raw[key];
    if (stream === undefined) continue;
    if (typeof stream !== 'object' || stream === null) {
      throw validationError(`${key} capture facts must be an object.`);
    }
    for (const fact of STREAM_FACT_KEYS) {
      const value = (stream as Record<string, unknown>)[fact];
      if (fact === 'available' && value === null) continue;
      if (value !== undefined && typeof value !== 'boolean') {
        throw validationError(`${key}.${fact} must be a boolean.`);
      }
    }
  }
  return input as EvidenceInput;
}

/**
 * Merges one validated observation monotonically onto the latest known
 * snapshot and returns the next durable evidence. Established facts are
 * never erased; a contradiction throws VALIDATION_FAILED.
 */
export function mergeEvidence(
  prior: ExecutionEvidence,
  input: EvidenceInput,
  options: { uncertain: boolean; finalized: boolean },
): ExecutionEvidence {
  const next: ExecutionEvidence = {
    ...prior,
    stdout: { ...prior.stdout },
    stderr: { ...prior.stderr },
    uncertain: options.uncertain,
    finalized: options.finalized,
  };

  if (input.launch !== undefined) {
    // A known launch phase regressing to a different phase is a
    // contradiction (e.g. launched -> suppressed_*); once established,
    // non-execution or launch is immutable.
    if (prior.launch !== 'unknown' && prior.launch !== input.launch) {
      throw validationError('Launch phase contradicts the established fact.');
    }
    next.launch = input.launch;
  }

  if (input.shellCode !== undefined) {
    if (prior.shellCode !== null && prior.shellCode !== input.shellCode) {
      throw validationError('Shell code contradicts the established outcome.');
    }
    next.shellCode = input.shellCode;
  }
  if (input.shellSignal !== undefined) {
    if (prior.shellSignal !== null && prior.shellSignal !== input.shellSignal) {
      throw validationError(
        'Shell signal contradicts the established outcome.',
      );
    }
    next.shellSignal = input.shellSignal;
  }
  // A shell code and a terminating signal are mutually exclusive outcomes.
  if (next.shellCode !== null && next.shellSignal !== null) {
    throw validationError(
      'Shell code and shell signal cannot both be established.',
    );
  }
  if (
    NON_EXECUTION_LAUNCH.includes(next.launch) &&
    (next.shellCode !== null || next.shellSignal !== null)
  ) {
    throw validationError(
      'Non-execution launch cannot have a shell outcome established.',
    );
  }

  if (
    input.cleanupState !== undefined &&
    input.cleanupState !== prior.cleanupState
  ) {
    // not_required is an established non-execution disposition, not merely
    // "less certain" cleanup: once set it is immutable, and it is only
    // reachable from the initial not_requested state with established
    // non-execution.
    if (prior.cleanupState === 'not_required') {
      throw validationError(
        'Cleanup not_required is established and cannot change.',
      );
    }
    if (input.cleanupState === 'not_required') {
      if (
        !NON_EXECUTION_LAUNCH.includes(next.launch) ||
        prior.cleanupState !== 'not_requested'
      ) {
        throw validationError(
          'Cleanup not_required requires established non-execution.',
        );
      }
    } else if (
      CLEANUP_ORDER[input.cleanupState] < CLEANUP_ORDER[prior.cleanupState]
    ) {
      // Cleanup certainty moves forward only: not_requested < pending
      // < unconfirmed. A regression is a contradiction.
      throw validationError(
        'Cleanup state cannot regress to a less certain observation.',
      );
    }
    next.cleanupState = input.cleanupState;
  } else if (
    prior.cleanupState === 'not_required' &&
    next.launch !== 'unknown' &&
    NON_EXECUTION_LAUNCH.includes(next.launch) === false
  ) {
    throw validationError(
      'Cleanup not_required requires established non-execution.',
    );
  }

  if (input.cleanupTermObservation !== undefined) {
    if (
      prior.cleanupTermObservation !== null &&
      prior.cleanupTermObservation !== input.cleanupTermObservation
    ) {
      throw validationError(
        'Cleanup TERM receipt contradicts the established fact.',
      );
    }
    next.cleanupTermObservation = input.cleanupTermObservation;
  }
  if (input.cleanupKillIntentObserved !== undefined) {
    if (input.cleanupKillIntentObserved && !next.cleanupKillIntentObserved) {
      next.cleanupKillIntentObserved = true;
    }
  }
  if (
    next.cleanupState === 'not_required' &&
    (next.cleanupTermObservation !== null || next.cleanupKillIntentObserved)
  ) {
    throw validationError(
      'Cleanup not_required cannot have cleanup attempt evidence.',
    );
  }
  if (input.cancellationIntentObserved !== undefined) {
    if (input.cancellationIntentObserved && !next.cancellationIntentObserved) {
      next.cancellationIntentObserved = true;
    }
  }
  if (input.deadlineTriggerObserved !== undefined) {
    if (input.deadlineTriggerObserved && !next.deadlineTriggerObserved) {
      next.deadlineTriggerObserved = true;
    }
  }

  mergeStream(next.stdout, input.stdout);
  mergeStream(next.stderr, input.stderr);

  return next;
}

function mergeStream(
  target: StreamCaptureFacts,
  input: Partial<StreamCaptureFacts> | undefined,
): void {
  if (input === undefined) return;
  // Unknown availability may be refined; an established availability
  // receipt cannot be erased or contradicted by a later snapshot.
  if (input.available !== undefined) {
    if (target.available !== null && target.available !== input.available) {
      throw validationError(
        'Capture availability contradicts the established fact.',
      );
    }
    target.available = input.available;
  }
  if (input.truncated !== undefined && input.truncated) target.truncated = true;
  if (input.incomplete !== undefined) {
    if (!input.incomplete && target.incomplete) {
      throw validationError(
        'Capture incompleteness is established and cannot be retracted.',
      );
    }
    target.incomplete = input.incomplete;
  }
  if (input.openAtCutover !== undefined) {
    if (!input.openAtCutover && target.openAtCutover) {
      throw validationError(
        'Open-at-cutover is established and cannot be retracted.',
      );
    }
    target.openAtCutover = input.openAtCutover;
  }
}
