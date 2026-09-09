# Repository foundations — execution ledger

This ledger tracks the user-approved foundation slice, not the future v0.1 behavior plan. It is separate from product/planning contracts. Local verification, review, merge and publication are distinct gates.

This ledger was bootstrapped before the optional local tracker was loaded. Tracker activation and the first `execution_update` receipt were verified on 2026-09-09. The orchestrator alone updates the managed checkpoint through the tracker. It records a local snapshot; GitHub is authoritative for current PR and merge status. Historical verification is kept below.

## Execution checkpoint

**Current merged anchor:** None — PR #1 has not been merged.
**Resume here:** Finish PR #1 feedback and final-head checks, then merge if satisfactory. Preserve research/spikes/local reports. After merge, record actual merge evidence; do not begin v0.1 implementation.
**Active PR slice:** U1-W1
**Slice branch:** chore/repository-foundations
**Slice PR:** #1
**Slice outcome:** PR open; initial CI green. Ledger correction and final verification precede the conditionally authorized merge.

| Unit | Status | Merged evidence | Remaining gates |
| --- | --- | --- | --- |
| U1 | Partial | PR #1 contains foundation commit 68343ba87953406a38729481331924e8ce3ae037; GitHub CI run 34339115499 passed Node 24/26. Copilot identified stale checkpoint state, corrected through the tracker. The working-directory concern was tested: npm --prefix from unrelated cwd passes; direct Node invocation rejects with npm usage instructions. Owner authorized merge if final checks and feedback are satisfactory. | Commit/push the ledger correction, reply to both Copilot threads, verify final-head CI and feedback, then merge under the owner's conditional authorization. Package publication and product implementation remain out of scope. |

### Append-only execution log

- **2026-09-09 — U1 In progress**: Activated local tracker, verified live Git state, reconciled prior clean-install/check evidence, and started the foundation review gate. Evidence: Tracker active; branch chore/repository-foundations verified at c78a627. Prior npm ci --ignore-scripts and npm run check passed on Node 24.11.1/26.7.0, six tests, package policy and actionlint passed; no commits or merge. <!-- execution-update:foundation-review-start-20260909:8889b36f36e3f019d6e76a40a2ae2899d9c1cb01409efd0fd812a894f3d8e651 -->
- **2026-09-09 — U1 Partial**: Completed foundation review and fixes; preserved pre-existing research. Reports and regression evidence are under docs/reviews/2026-09-09-foundations/. Two non-blocking Markdown spacing warnings remain in the tracker-managed log; no blocking diagnostics. Local checks are not remote CI, merge or release evidence. Evidence: Local foundation review complete: 8 reviewer reports; fresh validator rejected #1 and confirmed #2-4. Corrected historical tracker wording and added declaration-entry/CLI regression tests; no production script changes. npm ci --ignore-scripts and npm run check passed on Node 24.11.1/26.7.0 (8 tests); four scratch mutations detected. actionlint and git diff --check passed; release guard exited 1 with all three intended blockers. No commit or merge. <!-- execution-update:foundation-review-verified-20260909:c9513ac834e38cd65374eac7b3994e8e849ee98e291433907633ca4b776b4499 -->
- **2026-09-09 — U1 Partial**: Recorded explicit owner shipping approval. Limited publication cleanup removes contributor links to excluded local research; no runtime or package-policy behavior changes. Evidence: Owner explicitly authorized committing/pushing the reviewed foundation changes and opening a PR, with no merge, package publication or remote security changes. Prior local review and Node 24/26 checks passed. Publication preflight found references to excluded local research; README/development wording now keeps the public foundation standalone. <!-- execution-update:foundation-shipping-authorized-20260909:a69b5c4278f66aa268b5a330a0f05159e8611b928e8ab2269e5ed0891e2ca944 -->
- **2026-09-09 — U1 Partial**: Completed the authorized commit/push/PR step and verified exact-head GitHub CI. This local checkpoint update is not included in the already-tested PR commit. Merge remains user-controlled. Evidence: Committed/pushed 68343ba87953406a38729481331924e8ce3ae037 and opened https://github.com/freezscholte/pi-watch/pull/1. GitHub CI run 34339115499 completed successfully for Checks (Node 24) and Checks (Node 26) on that exact PR head. Verified remote PR contains exactly the approved 25-file foundation tree; research/spikes/review artifacts remain local. Public-only clean-copy checks passed before shipping. No merge or release occurred. <!-- execution-update:foundation-pr-open-ci-green-20260909:bdfe8049332b1d6734df18fc873cb27f0694cfb4d2570f601648143d9d8b5d9b -->
- **2026-09-09 — U1 Partial**: Accepted Copilot's stale-checkpoint finding; treated the cwd comment as unsupported direct invocation, backed by real command checks. Corrected current snapshot and timeless authorization wording. No product or package-checking code changed. Evidence: PR #1 contains foundation commit 68343ba87953406a38729481331924e8ce3ae037; GitHub CI run 34339115499 passed Node 24/26. Copilot identified stale checkpoint state, corrected through the tracker. The working-directory concern was tested: npm --prefix from unrelated cwd passes; direct Node invocation rejects with npm usage instructions. Owner authorized merge if final checks and feedback are satisfactory. <!-- execution-update:foundation-pr-feedback-merge-authorized-20260909:c28637d96b4305c9d6855db6cb4d3a5cb682729850dd100ee5bf3e8135fb66f8 -->

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
- Production implementation and package publication are outside this foundation slice.
- Git operations and remote settings changes require explicit approval; approval of one operation does not authorize the others.
- Next product work requires agreeing on the small v0.1 contract.
