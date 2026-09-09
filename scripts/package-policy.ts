const documents = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];
const distributionPath =
  /^dist\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:js|d\.ts)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks the actual npm pack file list, not just the manifest's intentions. */
export function packageProblems(
  manifest: unknown,
  packedPaths: readonly string[],
): string[] {
  if (!isRecord(manifest)) return ['Package manifest must be an object.'];
  const problems: string[] = [];
  if (manifest.license !== 'MIT')
    problems.push('Expected the approved MIT license.');
  if (
    !Array.isArray(manifest.keywords) ||
    !manifest.keywords.includes('pi-package')
  ) {
    problems.push('Missing pi-package discovery keyword.');
  }
  if (
    JSON.stringify(manifest.files) !== JSON.stringify(['dist/', 'CHANGELOG.md'])
  ) {
    problems.push(
      'The reviewed files allowlist changed; review packaging policy explicitly.',
    );
  }
  for (const path of documents) {
    if (!packedPaths.includes(path))
      problems.push(`Missing required package document: ${path}`);
  }
  for (const path of packedPaths) {
    if (!documents.includes(path) && !distributionPath.test(path)) {
      problems.push(`Unexpected package path: ${path}`);
    }
  }
  const entries = isRecord(manifest.pi) ? manifest.pi.extensions : undefined;
  return [...problems, ...entryProblems(entries, packedPaths)];
}

function entryProblems(
  entries: unknown,
  packedPaths: readonly string[],
): string[] {
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => typeof entry !== 'string')
  ) {
    return ['pi.extensions must be an explicit string array.'];
  }
  const problems: string[] = [];
  for (const entry of entries as string[]) {
    const path = entry.replace(/^\.\//, '');
    if (
      !distributionPath.test(path) ||
      !path.endsWith('.js') ||
      !packedPaths.includes(path)
    ) {
      problems.push(`Missing or invalid extension entry: ${entry}`);
    }
  }
  return problems;
}

export function releaseProblems(
  manifest: unknown,
  packedPaths: readonly string[],
): string[] {
  const problems = packageProblems(manifest, packedPaths);
  if (!isRecord(manifest)) return problems;
  const entries = isRecord(manifest.pi) ? manifest.pi.extensions : undefined;
  if (Array.isArray(entries) && entries.length === 0) {
    problems.push('Release needs an implemented extension entry.');
  }
  if (manifest.private !== false) {
    problems.push('Release is blocked while the package is private.');
  }
  if (typeof manifest.version !== 'string' || manifest.version === '0.0.0') {
    problems.push(
      'Replace foundation version 0.0.0 with an intentional release version.',
    );
  }
  return problems;
}
