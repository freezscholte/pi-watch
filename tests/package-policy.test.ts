import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageProblems, releaseProblems } from '../scripts/package-policy.ts';

const documents = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];
const foundation = {
  name: 'pi-watch',
  version: '0.0.0',
  private: true,
  license: 'MIT',
  keywords: ['pi-package'],
  files: ['dist/', 'CHANGELOG.md'],
  pi: { extensions: [] as string[] },
};

test('foundation package can be inspected without pretending it is releasable', {
  timeout: 60_000,
}, () => {
  assert.deepEqual(packageProblems(foundation, documents), []);
  const problems = releaseProblems(foundation, documents);
  assert.ok(problems.some((problem) => problem.includes('private')));
  assert.ok(problems.some((problem) => problem.includes('0.0.0')));
  assert.ok(problems.some((problem) => problem.includes('extension entry')));
});

test('unexpected or sensitive tarball paths fail closed', {
  timeout: 60_000,
}, () => {
  for (const path of [
    '.env',
    '.pi/settings.json',
    'spikes/results.ndjson',
    'docs/private.md',
    'node_modules/private/index.js',
    'tests/fixtures/owned-process-registry.ts',
    'tests/fixtures/owned-registry-failure.test.ts',
    'dist/jobs.sqlite',
    'dist/jobs.sqlite-wal',
    'dist/stdout.raw',
    'dist/stderr.truncated',
    'dist/stderr.closed.json',
    'dist/command.log',
    'dist/session.jsonl',
    'dist/private-runtime/session.json',
    'dist/index.js.map',
    'dist/../private.js',
    'dist/.secret.js',
  ]) {
    assert.ok(
      packageProblems(foundation, [...documents, path]).some((problem) =>
        problem.includes(path),
      ),
      path,
    );
  }
});

test('the reviewed npm files allowlist cannot silently expand', {
  timeout: 60_000,
}, () => {
  assert.ok(
    packageProblems({ ...foundation, files: ['**'] }, documents).length > 0,
  );
});

test('required package documents, license and discovery metadata are checked', {
  timeout: 60_000,
}, () => {
  for (const path of documents) {
    assert.ok(
      packageProblems(
        foundation,
        documents.filter((name) => name !== path),
      ).length > 0,
    );
  }
  assert.ok(
    packageProblems({ ...foundation, license: 'UNLICENSED' }, documents)
      .length > 0,
  );
  assert.ok(
    packageProblems({ ...foundation, keywords: [] }, documents).length > 0,
  );
});

test('malformed manifests and missing extension entry files are rejected', {
  timeout: 60_000,
}, () => {
  assert.ok(packageProblems(null, documents).length > 0);
  assert.ok(
    packageProblems(
      { ...foundation, pi: { extensions: 'dist/index.js' } },
      documents,
    ).length > 0,
  );
  assert.ok(
    packageProblems(
      { ...foundation, pi: { extensions: ['./dist/missing.js'] } },
      documents,
    ).length > 0,
  );
});

test('a packed type declaration cannot serve as the extension entry', {
  timeout: 60_000,
}, () => {
  const manifest = {
    ...foundation,
    version: '0.1.0',
    private: false,
    pi: { extensions: ['./dist/index.d.ts'] },
  };
  assert.deepEqual(
    releaseProblems(manifest, [...documents, 'dist/index.d.ts']),
    ['Missing or invalid extension entry: ./dist/index.d.ts'],
  );
});

test('a deliberately prepared release must contain its declared extension', {
  timeout: 60_000,
}, () => {
  const manifest = {
    ...foundation,
    version: '0.1.0',
    private: false,
    pi: { extensions: ['./dist/index.js'] },
  };
  assert.deepEqual(
    releaseProblems(manifest, [
      ...documents,
      'dist/index.js',
      'dist/index.d.ts',
    ]),
    [],
  );
  assert.ok(
    releaseProblems(
      { ...manifest, pi: { extensions: ['./LICENSE'] } },
      documents,
    ).length > 0,
  );
});
