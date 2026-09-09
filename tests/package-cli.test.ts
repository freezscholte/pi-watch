import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the release command exits unsuccessfully with every foundation blocker', () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'Run through npm test or npm run check.');
  const result = spawnSync(
    process.execPath,
    [npmCli, '--ignore-scripts', 'run', 'check:release'],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const blocker of [
    'Release needs an implemented extension entry.',
    'Release is blocked while the package is private.',
    'Replace foundation version 0.0.0 with an intentional release version.',
  ]) {
    assert.ok(result.stderr.includes(blocker), result.stderr);
  }
});
