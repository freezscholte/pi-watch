import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { packageProblems, releaseProblems } from './package-policy.ts';

try {
  const npmCli = process.env.npm_execpath;
  assert.ok(
    npmCli,
    'Run through npm run check:package or npm run check:release.',
  );
  // --ignore-scripts prevents package lifecycle hooks during this inspection.
  const output = execFileSync(
    process.execPath,
    [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const packages = JSON.parse(output) as Array<{
    files: Array<{ path: string }>;
  }>;
  assert.equal(packages.length, 1, 'Expected exactly one packed package.');
  const packed = packages[0];
  assert.ok(packed);
  const paths = packed.files.map((file) => file.path);
  const manifest: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
  const problems = process.argv.includes('--release')
    ? releaseProblems(manifest, paths)
    : packageProblems(manifest, paths);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Package content policy passed (${paths.length} files):\n${paths.join('\n')}\n`,
    );
    process.stdout.write(
      'This checks package contents; it is not an extension load/lifecycle test.\n',
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Package inspection failed: ${message}\n`);
  process.exitCode = 1;
}
