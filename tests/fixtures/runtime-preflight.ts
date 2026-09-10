import { createJobStore } from '../../src/job-store.ts';
import { openStoreClient } from '../../src/store-client.ts';

const args = process.argv.slice(2);
const value = (name: string): string => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? '') : '';
};
const db = value('--db');
const root = value('--root');

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'UNKNOWN';
}

const direct = (() => {
  try {
    createJobStore(db, { trustedRoot: root });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
})();
const client = await openStoreClient(db, { trustedRoot: root }).then(
  async (opened) => {
    await opened.close();
    return { ok: true };
  },
  (error: unknown) => ({ ok: false, code: codeOf(error) }),
);
process.stdout.write(`${JSON.stringify({ direct, client })}\n`);
