# Development

## Foundation tooling

Use Node 24 LTS and npm. `.nvmrc` records the development major; it is not a compatibility promise for the future extension. `package-lock.json` pins the dependency graph.

```sh
npm ci --ignore-scripts
npm run check
```

Checks include strict TypeScript, Biome formatting/linting, Node tests and inspection of npm's actual package file list. `npm run format` applies formatting; `npm run lint` reports lint findings without rewriting them. Biome does not format Markdown/YAML here; review those files and validate workflows separately.

The formatter and type checker intentionally exclude historical `spikes/` and research. Those materials remain local pending separate publication review and are not prerequisites for these checks. Do not use an experiment's environment-specific runtime path as a package dependency strategy.

There is no product build or extension-load smoke test yet because no extension is implemented. When that slice starts, add source/build tests, declare actual Pi imports as wildcard peer dependencies as required by Pi's package contract, choose supported runtime/OS versions, and verify a packed package in an isolated Pi environment. Do not load a developer's normal sessions, credentials or unrelated extensions during automated tests.

## Compound Engineering workflow

1. **Plan:** use `ce-plan` when behavior or architecture needs resolution. Keep the plan bounded and separate user decisions from recommendations. Publish reviewed supporting research separately; do not make unpublished local material a contributor prerequisite.
2. **Work:** use `ce-work` on an approved slice and feature branch. Preserve pre-existing work and record exact verification evidence.
3. **Simplify/review:** use `ce-simplify-code` and `ce-code-review` as appropriate. Inspect the actual diff, including new/untracked files.
4. **Learn:** use `ce-compound` for non-obvious lessons not already explained by code/tests. Store durable learnings under `docs/solutions/`.
5. **Ship only with authority:** stop for explicit commit/merge/release approval. A completed local change is not a merged or published release.

These skills are optional developer tools, not runtime dependencies. Contributors can follow the same principles without Pi, the maintainer's providers, or any private checkout. The shared CE config sets only `docs_root: docs`; local engine preferences belong in ignored configuration.

## Optional maintainer-local tracker and subagents

The maintainer may use ignored `.pi/settings.json` to reference an existing trusted execution tracker and to configure model roles/watchdogs. Nothing under `.pi/` is committed or included in the npm tarball. That local setup must not be required by CI or contributors.

The tracker can point to a **separate** `docs/execution/` ledger, with the checkpoint section it understands. Keep product/planning contracts outside the mutable ledger. The orchestrator is its sole writer; children return evidence. A process-local queue and checkpoint digest do not establish a machine-wide multi-writer lock.

New local extension configuration requires a Pi reload/restart and project trust. Until `execution_status` is actually available and reads the configured checkpoint, do not describe tracking as active. Initial ledger creation is bootstrap state, not a fabricated tool update. Once active, use the tracker rather than generic edits for its managed section.

Do not copy third-party/private tracker source or account-specific model settings into the public repo. Local references can drift or disappear; failures should be explicit and should not block ordinary npm checks.

## Current work boundary

The foundation slice covers repository/package metadata, license, contribution/security/release policies, local CE conventions, dependency locking and CI. It does **not** implement a task runner, choose a production SQLite binding, raise the extension's minimum Node version, or publish anything. Next comes a small, explicitly agreed v0.1 behavior contract.
