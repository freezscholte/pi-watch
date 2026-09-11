import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchRunner, preflightLauncher } from '../../src/launch.ts';
import { openStoreClient } from '../../src/store-client.ts';
import { internalSeams, waitAtAsyncSeam } from '../../src/test-seams.ts';

async function run(): Promise<void> {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2)
    values.set(
      process.argv[i]?.replace(/^--/, '') ?? '',
      process.argv[i + 1] ?? '',
    );
  const db = values.get('db') ?? '';
  const root = values.get('root') ?? '';
  const owner = values.get('owner') ?? '11111111-2222-4333-8444-555555555555';
  if (!db || !root) throw new Error('fixture requires --db and --root');
  preflightLauncher({ dbPath: db, trustedRoot: root });
  const client = await openStoreClient(db, { trustedRoot: root });
  const reservation = await client.reserve({
    ownerUuid: owner,
    sessionPath:
      values.get('session') ?? join(tmpdir(), 'pi-watch-fixture-session.jsonl'),
    namespace: 'tool_call',
    requestKey: values.get('key') ?? 'fixture-key',
    command: values.get('command') ?? 'true',
    cwd: values.get('cwd') ?? root,
    deadlineMs: Number(values.get('deadline') ?? '30000'),
  });
  const action = values.get('action') ?? 'launch';
  if (action === 'cancel')
    await client.requestCancellation(owner, reservation.job.jobId);
  let launch: unknown = null;
  if (action !== 'reserve' && reservation.created) {
    launch = await launchRunner(client, reservation, {
      dbPath: db,
      trustedRoot: root,
    });
  }
  await waitAtAsyncSeam(internalSeams().pauseControllerAfterLaunch);
  process.stdout.write(
    `${JSON.stringify({ created: reservation.created, jobId: reservation.job.jobId, launch })}\n`,
  );
  await client.close();
}

try {
  await run();
} catch (error) {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
