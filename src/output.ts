/** Bounded, Pi-independent loading and pagination for authorized output reads. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import {
  CLOSURE_RECEIPT_LIMIT,
  type ClosureReceipt,
  OUTPUT_CAPTURE_LIMIT,
  parseClosureReceipt,
} from './output-capture.ts';
import {
  type CaptureArtifact,
  type CaptureStream,
  type CaptureWorkspace,
  type FixedLayout,
  inspectPrivateFile,
  openCaptureWorkspace,
  privateFileBindingMatches,
} from './private-path.ts';

export const OUTPUT_ENVELOPE_LIMIT = 51_200;
export const OUTPUT_LINE_LIMIT = 2_000;
const RAW_RESPONSE_WINDOW = OUTPUT_ENVELOPE_LIMIT;
const UTF8_LOOKAHEAD = 3;

export interface OutputCaptureFacts {
  available: boolean | null;
  truncated: boolean;
  incomplete: boolean;
  openAtCutover: boolean;
}

/** One already-authorized SQLite observation; this module performs no lookup. */
export interface OutputObservation {
  jobId: string;
  finalized: boolean;
  capture: OutputCaptureFacts;
}

export interface OutputData {
  stream: CaptureStream;
  offsetBytes: number;
  nextOffsetBytes: number;
  retainedBytes: number;
  hasMore: boolean;
  canGrow: boolean;
  available: boolean;
  truncated: boolean;
  incomplete: boolean;
  openAtCutover: boolean;
  text: string;
}

export type OutputErrorCode =
  | 'INVALID_OFFSET'
  | 'OFFSET_OUT_OF_RANGE'
  | 'CAPTURE_UNAVAILABLE'
  | 'CAPTURE_CORRUPT'
  | 'OUTPUT_READ_FAILED';

export type OutputEnvelope =
  | { schemaVersion: 1; ok: true; data: OutputData }
  | {
      schemaVersion: 1;
      ok: false;
      error: { code: OutputErrorCode; message: string };
    };

const ERROR_MESSAGES: Record<OutputErrorCode, string> = {
  INVALID_OFFSET: `Offset must be an integer from 0 through ${OUTPUT_CAPTURE_LIMIT}.`,
  OFFSET_OUT_OF_RANGE: 'Offset is beyond the retained output snapshot.',
  CAPTURE_UNAVAILABLE: 'Output capture is unavailable.',
  CAPTURE_CORRUPT: 'Output capture metadata is corrupt.',
  OUTPUT_READ_FAILED: 'Output could not be read.',
};

function failure(code: OutputErrorCode): OutputEnvelope {
  return {
    schemaVersion: 1,
    ok: false,
    error: { code, message: ERROR_MESSAGES[code] },
  };
}

function success(data: OutputData): OutputEnvelope {
  return { schemaVersion: 1, ok: true, data };
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

type LoadedArtifact =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'read-failed' }
  | { status: 'ok'; bytes: Buffer };

function loadSidecar(
  workspace: CaptureWorkspace,
  stream: CaptureStream,
  artifact: CaptureArtifact,
  limit: number,
): LoadedArtifact {
  const path = workspace.paths(stream)[artifact];
  try {
    lstatSync(path);
  } catch (error) {
    return isErrno(error, 'ENOENT')
      ? { status: 'missing' }
      : { status: 'invalid' };
  }
  const inspected = inspectPrivateFile(workspace, stream, artifact);
  if (inspected === null || inspected.size > limit)
    return { status: 'invalid' };
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
      return { status: 'invalid' };
    }
    const bytes = Buffer.alloc(inspected.size);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, read);
      if (count <= 0) return { status: 'read-failed' };
      read += count;
    }
    const after = fstatSync(fd);
    if (
      after.size !== opened.size ||
      !privateFileBindingMatches(workspace, stream, artifact, inspected)
    ) {
      return { status: 'invalid' };
    }
    return { status: 'ok', bytes };
  } catch {
    return { status: 'read-failed' };
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // The bounded parse above remains valid after a close failure.
      }
    }
  }
}

function sqlitePermitsGrowth(observation: OutputObservation): boolean {
  const facts = observation.capture;
  return (
    !observation.finalized &&
    facts.available !== false &&
    !facts.truncated &&
    !facts.incomplete &&
    !facts.openAtCutover
  );
}

function receiptMatchesFinalFacts(
  receipt: ClosureReceipt,
  observation: OutputObservation,
): boolean {
  const facts = observation.capture;
  return (
    facts.available === true &&
    receipt.truncated === facts.truncated &&
    receipt.incomplete === facts.incomplete &&
    receipt.openAtCutover === facts.openAtCutover
  );
}

interface Token {
  consumed: number;
  text: string;
}

function isContinuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function utf8Token(
  bytes: Buffer,
  index: number,
  snapshotEndsHere: boolean,
  canGrow: boolean,
): Token | null {
  const first = bytes[index] ?? 0;
  if (first <= 0x7f) return { consumed: 1, text: String.fromCodePoint(first) };

  let width = 0;
  if (first >= 0xc2 && first <= 0xdf) width = 2;
  else if (first >= 0xe0 && first <= 0xef) width = 3;
  else if (first >= 0xf0 && first <= 0xf4) width = 4;
  else return { consumed: 1, text: '\ufffd' };

  const available = bytes.length - index;
  if (available < width) {
    for (let offset = 1; offset < available; offset += 1) {
      const byte = bytes[index + offset] ?? 0;
      const firstContinuationValid =
        offset !== 1 ||
        ((first !== 0xe0 || byte >= 0xa0) &&
          (first !== 0xed || byte <= 0x9f) &&
          (first !== 0xf0 || byte >= 0x90) &&
          (first !== 0xf4 || byte <= 0x8f));
      if (!isContinuation(byte) || !firstContinuationValid)
        return { consumed: Math.max(1, offset), text: '\ufffd' };
    }
    if (snapshotEndsHere && canGrow) return null;
    return { consumed: available, text: '\ufffd' };
  }

  for (let offset = 1; offset < width; offset += 1) {
    const byte = bytes[index + offset] ?? 0;
    const firstContinuationValid =
      offset !== 1 ||
      ((first !== 0xe0 || byte >= 0xa0) &&
        (first !== 0xed || byte <= 0x9f) &&
        (first !== 0xf0 || byte >= 0x90) &&
        (first !== 0xf4 || byte <= 0x8f));
    if (!isContinuation(byte) || !firstContinuationValid)
      return { consumed: Math.max(1, offset), text: '\ufffd' };
  }
  return {
    consumed: width,
    text: bytes.toString('utf8', index, index + width),
  };
}

function sanitize(value: string): string {
  const code = value.codePointAt(0) ?? 0;
  if (code === 0x09 || code === 0x0a) return value;
  if (code === 0x0d) return '\\r';
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
    return `\\x${code.toString(16).padStart(2, '0')}`;
  return value;
}

function serializedBytes(envelope: OutputEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
}

function paginate(
  bytes: Buffer,
  offsetBytes: number,
  retainedBytes: number,
  canGrow: boolean,
  baseFacts: Omit<OutputData, 'nextOffsetBytes' | 'hasMore' | 'text'>,
): OutputEnvelope {
  const primaryLength = Math.min(bytes.length, RAW_RESPONSE_WINDOW);
  const snapshotEndsHere = offsetBytes + bytes.length === retainedBytes;
  const parts: string[] = [];
  let escapedTextBytes = 0;
  let consumed = 0;
  let lineFeeds = 0;

  while (consumed < primaryLength) {
    const token = utf8Token(bytes, consumed, snapshotEndsHere, canGrow);
    if (token === null) break;
    if (consumed + token.consumed > bytes.length) break;
    const displayed = sanitize(token.text);
    const candidateConsumed = consumed + token.consumed;
    const candidateLineFeeds = lineFeeds + (displayed === '\n' ? 1 : 0);
    const candidateEndsWithLineFeed = displayed === '\n';
    const logicalLines =
      candidateLineFeeds + (candidateEndsWithLineFeed ? 0 : 1);
    if (logicalLines > OUTPUT_LINE_LIMIT) break;

    const nextOffsetBytes = offsetBytes + candidateConsumed;
    const metadataEnvelope = success({
      ...baseFacts,
      nextOffsetBytes,
      hasMore: nextOffsetBytes < retainedBytes,
      text: '',
    });
    const candidateEscapedBytes =
      escapedTextBytes +
      Buffer.byteLength(JSON.stringify(displayed), 'utf8') -
      2;
    if (
      serializedBytes(metadataEnvelope) + candidateEscapedBytes >
      OUTPUT_ENVELOPE_LIMIT
    ) {
      break;
    }
    parts.push(displayed);
    escapedTextBytes = candidateEscapedBytes;
    consumed = candidateConsumed;
    lineFeeds = candidateLineFeeds;
  }

  const nextOffsetBytes = offsetBytes + consumed;
  const envelope = success({
    ...baseFacts,
    nextOffsetBytes,
    hasMore: nextOffsetBytes < retainedBytes,
    text: parts.join(''),
  });
  // The incremental accounting is exact for independently serialized scalars.
  if (serializedBytes(envelope) > OUTPUT_ENVELOPE_LIMIT)
    return failure('OUTPUT_READ_FAILED');
  return envelope;
}

/**
 * Loads one immutable raw-file snapshot and returns its complete v1 envelope.
 * Authorization and the SQLite read happen before this pure filesystem call.
 */
export function readOutputSnapshot(
  layout: FixedLayout,
  observation: OutputObservation,
  stream: CaptureStream,
  offsetBytes: unknown = 0,
): OutputEnvelope {
  if (
    typeof offsetBytes !== 'number' ||
    !Number.isFinite(offsetBytes) ||
    !Number.isInteger(offsetBytes) ||
    offsetBytes < 0 ||
    offsetBytes > OUTPUT_CAPTURE_LIMIT
  ) {
    return failure('INVALID_OFFSET');
  }

  const facts = observation.capture;
  if (facts.available === false) {
    if (offsetBytes > 0) return failure('OFFSET_OUT_OF_RANGE');
    return success({
      stream,
      offsetBytes: 0,
      nextOffsetBytes: 0,
      retainedBytes: 0,
      hasMore: false,
      canGrow: false,
      available: false,
      truncated: facts.truncated,
      incomplete: facts.incomplete,
      openAtCutover: facts.openAtCutover,
      text: '',
    });
  }

  let workspace: CaptureWorkspace;
  try {
    workspace = openCaptureWorkspace(layout, observation.jobId);
  } catch {
    return failure('CAPTURE_UNAVAILABLE');
  }

  const rawPath = workspace.paths(stream).raw;
  let rawFd = -1;
  try {
    const inspectedRaw = inspectPrivateFile(workspace, stream, 'raw');
    if (inspectedRaw === null) return failure('CAPTURE_UNAVAILABLE');
    if (inspectedRaw.size > OUTPUT_CAPTURE_LIMIT)
      return failure('CAPTURE_CORRUPT');
    try {
      rawFd = openSync(
        rawPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      return failure('CAPTURE_UNAVAILABLE');
    }
    let rawStat: Stats;
    try {
      rawStat = fstatSync(rawFd);
    } catch {
      return failure('CAPTURE_UNAVAILABLE');
    }
    const rawIdentity = { dev: rawStat.dev, ino: rawStat.ino };
    if (
      !rawStat.isFile() ||
      !Number.isSafeInteger(rawStat.size) ||
      rawStat.size < 0 ||
      rawStat.dev !== inspectedRaw.dev ||
      rawStat.ino !== inspectedRaw.ino ||
      !privateFileBindingMatches(workspace, stream, 'raw', rawIdentity)
    ) {
      return failure('CAPTURE_UNAVAILABLE');
    }
    const retainedBytes = rawStat.size;
    if (retainedBytes > OUTPUT_CAPTURE_LIMIT) return failure('CAPTURE_CORRUPT');
    if (offsetBytes > retainedBytes) return failure('OFFSET_OUT_OF_RANGE');

    const permitsGrowth = sqlitePermitsGrowth(observation);
    let markerLoaded = loadSidecar(workspace, stream, 'truncated', 0);
    if (markerLoaded.status === 'read-failed')
      return failure('OUTPUT_READ_FAILED');
    if (markerLoaded.status === 'invalid') return failure('CAPTURE_CORRUPT');
    let markerObserved = markerLoaded.status === 'ok';

    const receiptLoaded = loadSidecar(
      workspace,
      stream,
      'closed',
      CLOSURE_RECEIPT_LIMIT,
    );
    if (receiptLoaded.status === 'read-failed')
      return failure('OUTPUT_READ_FAILED');
    if (receiptLoaded.status === 'invalid') return failure('CAPTURE_CORRUPT');

    let receipt: ClosureReceipt | null = null;
    if (receiptLoaded.status === 'ok') {
      const parsed = parseClosureReceipt(receiptLoaded.bytes, stream);
      if (
        parsed === null ||
        parsed.rawDev !== rawIdentity.dev ||
        parsed.rawIno !== rawIdentity.ino
      ) {
        return failure('CAPTURE_CORRUPT');
      }
      if (parsed.retainedBytes < retainedBytes)
        return failure('CAPTURE_CORRUPT');
      if (parsed.retainedBytes > retainedBytes) {
        if (!permitsGrowth) return failure('CAPTURE_CORRUPT');
      } else {
        receipt = parsed;
      }
    }

    if (receipt?.truncated === true && markerLoaded.status === 'missing') {
      markerLoaded = loadSidecar(workspace, stream, 'truncated', 0);
      if (markerLoaded.status === 'read-failed')
        return failure('OUTPUT_READ_FAILED');
      if (markerLoaded.status === 'invalid') return failure('CAPTURE_CORRUPT');
      markerObserved = markerLoaded.status === 'ok';
    }

    if (markerObserved && retainedBytes < OUTPUT_CAPTURE_LIMIT) {
      const coherentPartialOverflow =
        receipt?.truncated === true && receipt.reason === 'capture_error';
      if (!coherentPartialOverflow) {
        if (receipt !== null || !permitsGrowth)
          return failure('CAPTURE_CORRUPT');
        markerObserved = false;
      }
    }

    if (observation.finalized) {
      if (receipt === null || !receiptMatchesFinalFacts(receipt, observation))
        return failure('CAPTURE_CORRUPT');
    }
    if (receipt !== null && receipt.truncated !== markerObserved)
      return failure('CAPTURE_CORRUPT');
    if (facts.truncated && observation.finalized && !markerObserved)
      return failure('CAPTURE_CORRUPT');

    const canGrow =
      permitsGrowth && receipt === null && retainedBytes < OUTPUT_CAPTURE_LIMIT;
    const pageFacts: Omit<OutputData, 'nextOffsetBytes' | 'hasMore' | 'text'> =
      {
        stream,
        offsetBytes,
        retainedBytes,
        canGrow,
        available: true,
        truncated: receipt?.truncated ?? markerObserved,
        incomplete: receipt?.incomplete ?? facts.incomplete,
        openAtCutover: receipt?.openAtCutover ?? facts.openAtCutover,
      };

    if (offsetBytes === retainedBytes) {
      return success({
        ...pageFacts,
        nextOffsetBytes: offsetBytes,
        hasMore: false,
        text: '',
      });
    }

    const requestBytes = Math.min(
      retainedBytes - offsetBytes,
      RAW_RESPONSE_WINDOW + UTF8_LOOKAHEAD,
    );
    const bytes = Buffer.alloc(requestBytes);
    let read = 0;
    while (read < requestBytes) {
      const count = readSync(
        rawFd,
        bytes,
        read,
        requestBytes - read,
        offsetBytes + read,
      );
      if (count <= 0) return failure('OUTPUT_READ_FAILED');
      read += count;
    }
    if (!privateFileBindingMatches(workspace, stream, 'raw', rawIdentity))
      return failure('CAPTURE_UNAVAILABLE');
    return paginate(bytes, offsetBytes, retainedBytes, canGrow, pageFacts);
  } catch {
    return failure('OUTPUT_READ_FAILED');
  } finally {
    if (rawFd !== -1) {
      try {
        closeSync(rawFd);
      } catch {
        // The returned snapshot does not depend on a successful read-only close.
      }
    }
  }
}
