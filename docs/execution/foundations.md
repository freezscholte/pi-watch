# Repository foundations — execution ledger

This ledger tracks the user-approved foundation slice, not the future v0.1 behavior plan. It is separate from product/planning contracts. Local verification, review, merge and publication are distinct gates.

This ledger was bootstrapped before the optional local tracker was loaded. Tracker activation and the first `execution_update` receipt were verified on 2026-09-09. The orchestrator alone updates the managed checkpoint through the tracker; current state appears there, separately from the historical capture below.

## Execution checkpoint

**Current merged anchor:** None — foundation changes are not committed or merged
**Resume here:** Ship only the approved foundation file set and verify PR CI. Preserve research/spikes and generated local review artifacts; do not merge, publish or change remote security settings.
**Active PR slice:** U1-W1
**Slice branch:** chore/repository-foundations
**Slice PR:** Not opened
**Slice outcome:** Commit/push/PR explicitly authorized; public-file preflight underway. No merge authorization.

| Unit | Status | Merged evidence | Remaining gates |
| --- | --- | --- | --- |
| U1 | Partial | Owner explicitly authorized committing/pushing the reviewed foundation changes and opening a PR, with no merge, package publication or remote security changes. Prior local review and Node 24/26 checks passed. Publication preflight found references to excluded local research; README/development wording now keeps the public foundation standalone. | Verify the exact public file set, commit/push foundation branch, open PR and verify GitHub CI. Merge needs separate approval; no merged evidence exists. v0.1 contract remains a later decision. |

### Append-only execution log

- **2026-09-09 — U1 In progress**: Activated local tracker, verified live Git state, reconciled prior clean-install/check evidence, and started the foundation review gate. Evidence: Tracker active; branch chore/repository-foundations verified at c78a627. Prior npm ci --ignore-scripts and npm run check passed on Node 24.11.1/26.7.0, six tests, package policy and actionlint passed; no commits or merge. <!-- execution-update:foundation-review-start-20260909:8889b36f36e3f019d6e76a40a2ae2899d9c1cb01409efd0fd812a894f3d8e651 -->
- **2026-09-09 — U1 Partial**: Completed foundation review and fixes; preserved pre-existing research. Reports and regression evidence are under docs/reviews/2026-09-09-foundations/. Two non-blocking Markdown spacing warnings remain in the tracker-managed log; no blocking diagnostics. Local checks are not remote CI, merge or release evidence. Evidence: Local foundation review complete: 8 reviewer reports; fresh validator rejected #1 and confirmed #2-4. Corrected historical tracker wording and added declaration-entry/CLI regression tests; no production script changes. npm ci --ignore-scripts and npm run check passed on Node 24.11.1/26.7.0 (8 tests); four scratch mutations detected. actionlint and git diff --check passed; release guard exited 1 with all three intended blockers. No commit or merge. <!-- execution-update:foundation-review-verified-20260909:c9513ac834e38cd65374eac7b3994e8e849ee98e291433907633ca4b776b4499 -->
- **2026-09-09 — U1 Partial**: Recorded explicit owner shipping approval. Limited publication cleanup removes contributor links to excluded local research; no runtime or package-policy behavior changes. Evidence: Owner explicitly authorized committing/pushing the reviewed foundation changes and opening a PR, with no merge, package publication or remote security changes. Prior local review and Node 24/26 checks passed. Publication preflight found references to excluded local research; README/development wording now keeps the public foundation standalone. <!-- execution-update:foundation-shipping-authorized-20260909:a69b5c4278f66aa268b5a330a0f05159e8611b928e8ab2269e5ed0891e2ca944 -->

---

## Local verification capture — before tracker activation

The following verification was captured before tracker activation and reconciled by the 2026-09-09 execution update above. These are historical check results, not the current gate status:

- `npm ci --ignore-scripts`: passed; five development packages installed locally.
- `npm run check`: passed on Node 24.11.1 and Node 26.7.0. Strict TypeScript, Biome recommended rules, six tests, and actual npm package file-list validation passed.
- The policy tests were first observed failing against an empty validator, then passing after implementation.
- `npm run check:release`: failed as expected with all three foundation blockers (private package, version 0.0.0, no implemented extension entry).
- `actionlint .github/workflows/ci.yml .github/workflows/release-readiness.yml`: passed locally; remote workflows have not run.
- `npm audit`: zero reported vulnerabilities at this check, not a future safety guarantee.
- Primary LSP checks and public-document local-link checks passed. `git diff --check` passed; no staged files.
- Ignored local tracker reference/configuration and checkpoint paths exist. No private tracker code was copied into the public source or tarball.

**At this capture:** tracker activation, Compound Engineering review, and shipping approval were pending. GitHub private reporting was observed disabled; remote protection/trusted-publisher setup had not been performed. No production extension, commit, push, merge or publication had occurred. The branch was `chore/repository-foundations`. See the managed checkpoint for current gates.

## Continuation boundaries

- SQLite, TypeScript, MIT and Biome are user-selected.
- PostgreSQL is excluded; a future customized fork is outside this work.
- Local developer dependencies and ignored tracker/model configuration were authorized.
- No production extension, commits, pushes, merges, remote setting changes or publishing are authorized in this slice.
- Next product work requires agreeing on the small v0.1 contract.
