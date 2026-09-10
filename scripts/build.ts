import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const compiler = resolve(root, 'node_modules/typescript/bin/tsc');

rmSync(dist, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [compiler, '-p', 'tsconfig.build.json'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
