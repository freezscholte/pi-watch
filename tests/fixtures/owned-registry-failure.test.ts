import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { launchRunner } from '../../src/launch.ts';
import { openStoreClient } from '../../src/store-client.ts';
import { useOwnedProcessRegistry } from './owned-process-registry.ts';

const OWNER = '7e570001-2222-4333-8444-555555555555';
const OUTPUT_SENTINEL = 'LIFECYCLE_OUTPUT_SENTINEL';

async function waitFor(action: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('bounded owned actor receipt timeout');
}

function recordedPid(
  log: string,
  actor: 'runner' | 'guardian' | 'shell',
): number | null {
  if (!existsSync(log)) return null;
  const match = readFileSync(log, 'utf8').match(
    new RegExp(`(?:^|\\n)${actor}_pid (\\d+)(?: |\\n|$)`),
  );
  return match?.[1] === undefined ? null : Number(match[1]);
}

test('owned process registry reaps actors after injected test failure', {
  timeout: 20_000,
}, async (context) => {
  const root = process.env.OWNED_FAILURE_ROOT ?? '';
  const log = process.env.OWNED_FAILURE_LOG ?? '';
  const ledger = process.env.OWNED_FAILURE_LEDGER ?? '';
  const holderLedger = process.env.OWNED_FAILURE_HOLDER_LEDGER ?? '';
  const commandChild = process.env.OWNED_FAILURE_COMMAND_CHILD ?? '';
  const sideEffect = process.env.OWNED_FAILURE_SIDE_EFFECT ?? '';
  const diagnosticLog = process.env.OWNED_FAILURE_DIAGNOSTIC_LOG ?? '';
  const rootHold = join(root, 'never-release-root');
  assert.ok(
    root &&
      log &&
      ledger &&
      holderLedger &&
      commandChild &&
      sideEffect &&
      diagnosticLog,
  );
  const registry = useOwnedProcessRegistry(context);
  const db = join(root, 'state', 'jobs.sqlite');
  const client = await openStoreClient(db, { trustedRoot: root });
  context.after(() => client.close());
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(commandChild)} -- --ignore-term --marker ${JSON.stringify(rootHold)} --spawn-holder --hold-ms 30000 --holder-pid-file ${JSON.stringify(holderLedger)} --stdout-text ${JSON.stringify(OUTPUT_SENTINEL)} --side-effect ${JSON.stringify(sideEffect)}; : LIFECYCLE_COMMAND_SENTINEL`;
  const reservation = await client.reserve({
    ownerUuid: OWNER,
    sessionPath: join(root, 'LIFECYCLE_OWNER_SENTINEL.session'),
    namespace: 'tool_call',
    requestKey: crypto.randomUUID(),
    command,
    cwd: process.env.OWNED_FAILURE_CWD ?? root,
    deadlineMs: 15_000,
  });
  await launchRunner(client, reservation, { dbPath: db, trustedRoot: root });
  const recorded = new Set<number>();
  const record = (pid: number, group: boolean): void => {
    if (recorded.has(pid)) return;
    recorded.add(pid);
    registry.recordPid(pid);
    if (group) registry.recordGroup(pid);
    appendFileSync(ledger, `${pid}\n`);
  };
  await waitFor(async () => {
    const runnerPid = recordedPid(log, 'runner');
    const guardianPid = recordedPid(log, 'guardian');
    const shellPid = recordedPid(log, 'shell');
    if (runnerPid !== null) record(runnerPid, true);
    if (guardianPid !== null) record(guardianPid, true);
    if (shellPid !== null) record(shellPid, false);
    if (existsSync(holderLedger))
      record(Number(readFileSync(holderLedger, 'utf8').trim()), false);
    return recorded.size === 4;
  }, 10_000);
  const raw = join(root, 'state', 'jobs', reservation.job.jobId, 'stdout.raw');
  const expectedSummary = {
    bytes: Buffer.byteLength(OUTPUT_SENTINEL),
    digest: createHash('sha256').update(OUTPUT_SENTINEL).digest('hex'),
    sideEffectBytes: 1,
  };
  let summary = { bytes: -1, digest: '', sideEffectBytes: -1 };
  await waitFor(async () => {
    if (!existsSync(raw) || !existsSync(sideEffect)) return false;
    const captured = readFileSync(raw);
    summary = {
      bytes: captured.byteLength,
      digest: createHash('sha256').update(captured).digest('hex'),
      sideEffectBytes: readFileSync(sideEffect).byteLength,
    };
    return (
      summary.bytes === expectedSummary.bytes &&
      summary.digest === expectedSummary.digest &&
      summary.sideEffectBytes === expectedSummary.sideEffectBytes
    );
  }, 10_000);
  assert.deepEqual(summary, expectedSummary);
  writeFileSync(diagnosticLog, JSON.stringify(summary), { mode: 0o600 });
  assert.fail('EXPECTED_OWNED_REGISTRY_FAILURE');
});
