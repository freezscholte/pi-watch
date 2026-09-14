/** Independent bounded stdout/stderr prefix capture (W4 KTD3/KTD4/KTD10). */
import {
  close,
  closeSync,
  constants,
  fstatSync,
  fsync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  write,
  writeSync,
} from 'node:fs';
import {
  type CaptureArtifact,
  type CaptureStream,
  type CaptureWorkspace,
  createPrivateArtifact,
  type FileIdentity,
  inspectPrivateFile,
  privateFileBindingMatches,
} from './private-path.ts';
import { internalSeams } from './test-seams.ts';

export const OUTPUT_CAPTURE_LIMIT = 5_242_880;
export const CLOSURE_RECEIPT_LIMIT = 512;

export type ClosureReason = 'eof' | 'cutover' | 'capture_error';

export interface ClosureReceipt {
  version: 1;
  stream: CaptureStream;
  retainedBytes: number;
  truncated: boolean;
  incomplete: boolean;
  openAtCutover: boolean;
  reason: ClosureReason;
  rawDev: number;
  rawIno: number;
}

export interface CaptureTelemetry {
  maxPendingWrites: number;
  maxBuffers: number;
  maxReservedBytes: number;
  acceptCallbacks: number;
  pumpStarts: number;
  writeAttempts: number;
}

export interface CaptureResult {
  available: boolean;
  truncated: boolean;
  incomplete: boolean;
  openAtCutover: boolean;
  retainedBytes: number;
  drainedBytes: number;
  receipt: ClosureReceipt | null;
  telemetry: CaptureTelemetry;
}

export interface SealInput {
  source: 'eof' | 'cutover';
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function writeAsync(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    write(fd, buffer, offset, length, position, (error, bytesWritten) => {
      if (error) reject(error);
      else resolve(bytesWritten);
    });
  });
}

function syncAsync(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsync(fd, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeAsync(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    close(fd, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function exactWriteSync(fd: number, value: Buffer): void {
  let offset = 0;
  while (offset < value.length) {
    const written = writeSyncAt(fd, value, offset);
    if (written <= 0) throw new Error('bounded private write failed');
    offset += written;
  }
}

function writeSyncAt(fd: number, value: Buffer, offset: number): number {
  // Keep the synchronous sidecar sequence small and finite (<=512 bytes).
  return writeSync(fd, value, offset, value.length - offset, offset);
}

function faultMatches(
  fault: string | undefined,
  stream: CaptureStream,
  stage: string,
): boolean {
  return (
    fault === stage ||
    fault === `${stream}:${stage}` ||
    fault?.startsWith(`${stream}:${stage}:`) === true
  );
}

interface ShortWriteFault {
  limit: number;
  failAfter: number | undefined;
}

function shortWriteFault(
  fault: string | undefined,
): ShortWriteFault | undefined {
  const match =
    /^short-write:([1-9][0-9]*)(?::fail-after:([1-9][0-9]*))?$/.exec(
      fault ?? '',
    );
  if (match === null) return undefined;
  const limit = Number(match[1]);
  const failAfter = match[2] === undefined ? undefined : Number(match[2]);
  if (
    !Number.isSafeInteger(limit) ||
    (failAfter !== undefined && !Number.isSafeInteger(failAfter))
  ) {
    return undefined;
  }
  return { limit, failAfter };
}

function canonicalReceipt(receipt: ClosureReceipt): Buffer {
  const bytes = Buffer.from(JSON.stringify(receipt), 'utf8');
  if (bytes.length > CLOSURE_RECEIPT_LIMIT)
    throw new Error('bounded closure receipt exceeded limit');
  return bytes;
}

function removeExact(
  workspace: CaptureWorkspace,
  stream: CaptureStream,
  artifact: CaptureArtifact,
  identity: FileIdentity | undefined,
): void {
  if (
    identity === undefined ||
    !privateFileBindingMatches(workspace, stream, artifact, identity)
  )
    return;
  try {
    unlinkSync(workspace.paths(stream)[artifact]);
  } catch {
    // Artifact cleanup is best effort and never evidence.
  }
}

function readBoundedPrivateFile(
  workspace: CaptureWorkspace,
  stream: CaptureStream,
  artifact: CaptureArtifact,
  maximumBytes: number,
): { bytes: Buffer; identity: FileIdentity } | null {
  const inspected = inspectPrivateFile(workspace, stream, artifact);
  if (inspected === null || inspected.size > maximumBytes) return null;
  const path = workspace.paths(stream)[artifact];
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== inspected.dev ||
      opened.ino !== inspected.ino ||
      opened.size !== inspected.size
    ) {
      return null;
    }
    const bytes = Buffer.alloc(inspected.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    if (!privateFileBindingMatches(workspace, stream, artifact, inspected))
      return null;
    return { bytes, identity: inspected };
  } catch {
    return null;
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // A failed close means callers receive no trusted parse.
      }
    }
  }
}

function isCanonicalReceipt(
  value: unknown,
  bytes: Buffer,
): value is ClosureReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  const keys = [
    'version',
    'stream',
    'retainedBytes',
    'truncated',
    'incomplete',
    'openAtCutover',
    'reason',
    'rawDev',
    'rawIno',
  ];
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key, index) => Object.keys(record)[index] === key) ||
    record.version !== 1 ||
    (record.stream !== 'stdout' && record.stream !== 'stderr') ||
    typeof record.retainedBytes !== 'number' ||
    !Number.isSafeInteger(record.retainedBytes) ||
    record.retainedBytes < 0 ||
    record.retainedBytes > OUTPUT_CAPTURE_LIMIT ||
    typeof record.truncated !== 'boolean' ||
    typeof record.incomplete !== 'boolean' ||
    typeof record.openAtCutover !== 'boolean' ||
    (record.reason !== 'eof' &&
      record.reason !== 'cutover' &&
      record.reason !== 'capture_error') ||
    typeof record.rawDev !== 'number' ||
    !Number.isSafeInteger(record.rawDev) ||
    record.rawDev < 0 ||
    typeof record.rawIno !== 'number' ||
    !Number.isSafeInteger(record.rawIno) ||
    record.rawIno < 0
  ) {
    return false;
  }
  return Buffer.from(JSON.stringify(record), 'utf8').equals(bytes);
}

/** Strict bounded parser shared by capture verification and snapshot loading. */
export function parseClosureReceipt(
  bytes: Buffer,
  stream: CaptureStream,
): ClosureReceipt | null {
  if (bytes.length > CLOSURE_RECEIPT_LIMIT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!isCanonicalReceipt(parsed, bytes) || parsed.stream !== stream)
    return null;
  if (
    (parsed.reason === 'eof' && (parsed.incomplete || parsed.openAtCutover)) ||
    (parsed.reason === 'cutover' &&
      (!parsed.incomplete || !parsed.openAtCutover)) ||
    (parsed.reason === 'capture_error' && !parsed.incomplete) ||
    (parsed.truncated &&
      parsed.retainedBytes !== OUTPUT_CAPTURE_LIMIT &&
      parsed.reason !== 'capture_error')
  ) {
    return null;
  }
  return parsed;
}

/** Missing, temporary, malformed, replaced, or incoherent receipts are not closure. */
export function inspectClosureReceipt(
  workspace: CaptureWorkspace,
  stream: CaptureStream,
): ClosureReceipt | null {
  const paths = workspace.paths(stream);
  const loaded = readBoundedPrivateFile(
    workspace,
    stream,
    'closed',
    CLOSURE_RECEIPT_LIMIT,
  );
  if (loaded === null) return null;
  const receipt = parseClosureReceipt(loaded.bytes, stream);
  if (receipt === null || !workspace.verify()) return null;
  const raw = inspectPrivateFile(workspace, stream, 'raw');
  if (
    raw === null ||
    raw.size !== receipt.retainedBytes ||
    raw.dev !== receipt.rawDev ||
    raw.ino !== receipt.rawIno
  ) {
    return null;
  }
  const marker = inspectPrivateFile(workspace, stream, 'truncated');
  if (receipt.truncated) {
    if (marker === null || marker.size !== 0) return null;
  } else {
    try {
      lstatSync(paths.truncated);
      return null;
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) return null;
    }
  }
  return receipt;
}

class StreamCapture {
  readonly #workspace: CaptureWorkspace;
  readonly #stream: CaptureStream;
  readonly #paths: ReturnType<CaptureWorkspace['paths']>;
  readonly #storage = Buffer.allocUnsafe(OUTPUT_CAPTURE_LIMIT);
  readonly #fault: string | undefined;
  readonly #shortWriteFault: ShortWriteFault | undefined;
  readonly #telemetry: CaptureTelemetry = {
    maxPendingWrites: 0,
    maxBuffers: 0,
    maxReservedBytes: 0,
    acceptCallbacks: 0,
    pumpStarts: 0,
    writeAttempts: 0,
  };

  #fd = -1;
  #rawIdentity: FileIdentity | undefined;
  #admittedBytes = 0;
  #writtenBytes = 0;
  #drainedBytes = 0;
  #overflowObserved = false;
  #captureLoss = false;
  #durabilityLoss = false;
  #intakeOpen = true;
  #pumpPromise: Promise<void> | undefined;
  #markerPromise: Promise<boolean> | undefined;
  #markerIdentity: FileIdentity | undefined;
  #markerDurable = false;
  #receiptIdentity: FileIdentity | undefined;
  #sealPromise: Promise<CaptureResult> | undefined;
  #invalidated = false;
  #invalidatePromise: Promise<void> | undefined;

  constructor(workspace: CaptureWorkspace, stream: CaptureStream) {
    this.#workspace = workspace;
    this.#stream = stream;
    this.#paths = workspace.paths(stream);
    this.#fault = internalSeams().captureFault;
    this.#shortWriteFault = shortWriteFault(this.#fault);
    try {
      const opened = createPrivateArtifact(workspace, stream, 'raw');
      this.#fd = opened.fd;
      this.#rawIdentity = opened.identity;
    } catch {
      this.#captureLoss = true;
      this.#durabilityLoss = true;
    }
  }

  accept(chunk: Uint8Array): void {
    if (!this.#intakeOpen || chunk.byteLength === 0) return;
    this.#telemetry.acceptCallbacks += 1;
    this.#drainedBytes += chunk.byteLength;
    if (this.#captureLoss) return;

    const remaining = OUTPUT_CAPTURE_LIMIT - this.#admittedBytes;
    const accepted = Math.min(remaining, chunk.byteLength);
    if (accepted > 0 && this.#fd !== -1) {
      Buffer.from(chunk.buffer, chunk.byteOffset, accepted).copy(
        this.#storage,
        this.#admittedBytes,
      );
      this.#admittedBytes += accepted;
      this.#telemetry.maxReservedBytes = Math.max(
        this.#telemetry.maxReservedBytes,
        this.#admittedBytes - this.#writtenBytes,
      );
      this.#telemetry.maxBuffers = Math.max(
        this.#telemetry.maxBuffers,
        this.#pumpPromise === undefined ? 1 : 2,
      );
      this.#startPump();
    }
    if (accepted < chunk.byteLength) this.#observeOverflow();
  }

  sourceError(): void {
    this.#captureLoss = true;
  }

  seal(input: SealInput): Promise<CaptureResult> {
    this.#intakeOpen = false;
    this.#sealPromise ??= this.#seal(input);
    return this.#sealPromise;
  }

  invalidateEmptyStaging(): Promise<void> {
    this.#intakeOpen = false;
    this.#invalidated = true;
    this.#invalidatePromise ??= this.#invalidateEmptyStaging();
    return this.#invalidatePromise;
  }

  async #invalidateEmptyStaging(): Promise<void> {
    if (this.#pumpPromise !== undefined) await this.#pumpPromise;
    const empty =
      this.#drainedBytes === 0 &&
      this.#admittedBytes === 0 &&
      this.#writtenBytes === 0;
    if (this.#sealPromise !== undefined) await this.#sealPromise;
    if (this.#fd !== -1) {
      try {
        await closeAsync(this.#fd);
      } catch {
        // Staging cleanup is best effort and never output authority.
      }
      this.#fd = -1;
    }
    if (!empty) return;
    removeExact(this.#workspace, this.#stream, 'closed', this.#receiptIdentity);
    const raw = inspectPrivateFile(this.#workspace, this.#stream, 'raw');
    if (raw?.size === 0)
      removeExact(this.#workspace, this.#stream, 'raw', this.#rawIdentity);
  }

  #observeOverflow(): void {
    if (this.#overflowObserved) return;
    this.#overflowObserved = true;
    this.#markerPromise = this.#createMarker();
  }

  #startPump(): void {
    if (this.#pumpPromise !== undefined || this.#fd === -1) return;
    this.#telemetry.maxPendingWrites = Math.max(
      this.#telemetry.maxPendingWrites,
      1,
    );
    this.#telemetry.pumpStarts += 1;
    this.#pumpPromise = this.#pump().finally(() => {
      this.#pumpPromise = undefined;
      if (
        this.#intakeOpen &&
        !this.#captureLoss &&
        this.#writtenBytes < this.#admittedBytes
      ) {
        this.#startPump();
      }
    });
  }

  async #pump(): Promise<void> {
    while (
      this.#fd !== -1 &&
      !this.#captureLoss &&
      this.#writtenBytes < this.#admittedBytes
    ) {
      const available = this.#admittedBytes - this.#writtenBytes;
      const beforeFailure =
        this.#shortWriteFault?.failAfter === undefined
          ? available
          : this.#shortWriteFault.failAfter - this.#writtenBytes;
      const request = Math.min(
        available,
        this.#shortWriteFault?.limit ?? available,
        Math.max(0, beforeFailure),
      );
      try {
        this.#telemetry.writeAttempts += 1;
        if (
          request === 0 ||
          faultMatches(this.#fault, this.#stream, 'raw-write')
        )
          throw new Error('injected capture write failure');
        const written = await writeAsync(
          this.#fd,
          this.#storage,
          this.#writtenBytes,
          request,
          this.#writtenBytes,
        );
        if (written <= 0 || written > request)
          throw new Error('invalid bounded write result');
        this.#writtenBytes += written;
      } catch {
        this.#captureLoss = true;
      }
    }
  }

  async #createMarker(): Promise<boolean> {
    let fd = -1;
    try {
      if (faultMatches(this.#fault, this.#stream, 'marker-write'))
        throw new Error('injected marker creation failure');
      const opened = createPrivateArtifact(
        this.#workspace,
        this.#stream,
        'truncated',
      );
      fd = opened.fd;
      this.#markerIdentity = opened.identity;
      if (faultMatches(this.#fault, this.#stream, 'marker-sync'))
        throw new Error('injected marker sync failure');
      await syncAsync(fd);
      await closeAsync(fd);
      fd = -1;
      if (faultMatches(this.#fault, this.#stream, 'marker-close'))
        throw new Error('injected marker close failure');
      return (
        this.#markerIdentity !== undefined &&
        privateFileBindingMatches(
          this.#workspace,
          this.#stream,
          'truncated',
          this.#markerIdentity,
        ) &&
        inspectPrivateFile(this.#workspace, this.#stream, 'truncated')?.size ===
          0
      );
    } catch {
      this.#captureLoss = true;
      this.#durabilityLoss = true;
      return false;
    } finally {
      if (fd !== -1) {
        try {
          await closeAsync(fd);
        } catch {
          this.#durabilityLoss = true;
        }
      }
    }
  }

  async #seal(input: SealInput): Promise<CaptureResult> {
    if (this.#pumpPromise !== undefined) await this.#pumpPromise;
    if (this.#markerPromise !== undefined) {
      this.#markerDurable = await this.#markerPromise;
      if (!this.#markerDurable) this.#durabilityLoss = true;
    }

    if (this.#fd !== -1) {
      try {
        if (faultMatches(this.#fault, this.#stream, 'raw-sync'))
          throw new Error('injected raw sync failure');
        await syncAsync(this.#fd);
      } catch {
        this.#durabilityLoss = true;
      }
      try {
        await closeAsync(this.#fd);
        this.#fd = -1;
        if (faultMatches(this.#fault, this.#stream, 'raw-close'))
          throw new Error('injected raw close failure');
      } catch {
        this.#fd = -1;
        this.#durabilityLoss = true;
      }
    }

    const openAtCutover = input.source === 'cutover';
    const incomplete = this.#captureLoss || openAtCutover;
    const marker = inspectPrivateFile(
      this.#workspace,
      this.#stream,
      'truncated',
    );
    const truncated =
      this.#overflowObserved &&
      this.#markerDurable &&
      this.#markerIdentity !== undefined &&
      privateFileBindingMatches(
        this.#workspace,
        this.#stream,
        'truncated',
        this.#markerIdentity,
      ) &&
      marker?.size === 0;
    let receipt: ClosureReceipt | null = null;

    if (
      !this.#invalidated &&
      this.#rawIdentity !== undefined &&
      !this.#durabilityLoss &&
      this.#workspace.verify() &&
      privateFileBindingMatches(
        this.#workspace,
        this.#stream,
        'raw',
        this.#rawIdentity,
      ) &&
      inspectPrivateFile(this.#workspace, this.#stream, 'raw')?.size ===
        this.#writtenBytes
    ) {
      const candidate: ClosureReceipt = {
        version: 1,
        stream: this.#stream,
        retainedBytes: this.#writtenBytes,
        truncated,
        incomplete,
        openAtCutover,
        reason: this.#captureLoss
          ? 'capture_error'
          : input.source === 'eof'
            ? 'eof'
            : 'cutover',
        rawDev: this.#rawIdentity.dev,
        rawIno: this.#rawIdentity.ino,
      };
      if (await this.#publishReceipt(candidate)) receipt = candidate;
    }

    if (receipt === null) this.#durabilityLoss = true;
    return {
      available: receipt !== null,
      truncated: receipt?.truncated ?? false,
      incomplete: receipt === null || receipt.incomplete,
      openAtCutover,
      retainedBytes: receipt?.retainedBytes ?? 0,
      drainedBytes: this.#drainedBytes,
      receipt,
      telemetry: { ...this.#telemetry },
    };
  }

  async #publishReceipt(receipt: ClosureReceipt): Promise<boolean> {
    let temporaryFd = -1;
    let temporaryIdentity: FileIdentity | undefined;
    let finalIdentity: FileIdentity | undefined;
    let directoryFd = -1;
    try {
      if (faultMatches(this.#fault, this.#stream, 'receipt-write'))
        throw new Error('injected receipt write failure');
      const opened = createPrivateArtifact(
        this.#workspace,
        this.#stream,
        'closedTemporary',
      );
      temporaryFd = opened.fd;
      temporaryIdentity = opened.identity;
      exactWriteSync(temporaryFd, canonicalReceipt(receipt));
      if (faultMatches(this.#fault, this.#stream, 'receipt-sync'))
        throw new Error('injected receipt sync failure');
      await syncAsync(temporaryFd);
      await closeAsync(temporaryFd);
      temporaryFd = -1;
      if (faultMatches(this.#fault, this.#stream, 'receipt-close'))
        throw new Error('injected receipt close failure');

      try {
        lstatSync(this.#paths.closed);
        throw new Error('final receipt already exists');
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
      if (faultMatches(this.#fault, this.#stream, 'receipt-rename'))
        throw new Error('injected receipt rename failure');
      renameSync(this.#paths.closedTemporary, this.#paths.closed);
      finalIdentity = temporaryIdentity;
      this.#receiptIdentity = finalIdentity;

      directoryFd = openSync(
        this.#workspace.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (faultMatches(this.#fault, this.#stream, 'directory-sync'))
        throw new Error('injected directory sync failure');
      await syncAsync(directoryFd);
      await closeAsync(directoryFd);
      directoryFd = -1;

      if (faultMatches(this.#fault, this.#stream, 'final-identity'))
        throw new Error('injected final identity failure');
      return (
        this.#workspace.verify() &&
        this.#rawIdentity !== undefined &&
        privateFileBindingMatches(
          this.#workspace,
          this.#stream,
          'raw',
          this.#rawIdentity,
        ) &&
        finalIdentity !== undefined &&
        privateFileBindingMatches(
          this.#workspace,
          this.#stream,
          'closed',
          finalIdentity,
        ) &&
        inspectClosureReceipt(this.#workspace, this.#stream) !== null
      );
    } catch {
      removeExact(
        this.#workspace,
        this.#stream,
        'closedTemporary',
        temporaryIdentity,
      );
      removeExact(this.#workspace, this.#stream, 'closed', finalIdentity);
      return false;
    } finally {
      if (temporaryFd !== -1) {
        try {
          await closeAsync(temporaryFd);
        } catch {
          // The result is already unavailable.
        }
      }
      if (directoryFd !== -1) {
        try {
          await closeAsync(directoryFd);
        } catch {
          // The result is already unavailable.
        }
      }
    }
  }
}

export interface OutputCapture {
  accept(chunk: Uint8Array): void;
  sourceError(): void;
  seal(input: SealInput): Promise<CaptureResult>;
  /** Best-effort removal for an authorized shell spawn that never happened. */
  invalidateEmptyStaging(): Promise<void>;
}

export function createOutputCapture(
  workspace: CaptureWorkspace,
  stream: CaptureStream,
): OutputCapture {
  return new StreamCapture(workspace, stream);
}
