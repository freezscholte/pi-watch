# Development

## Foundation tooling

Use Node 26 and npm. `.nvmrc` records the development major, and `@types/node` follows that major. `package-lock.json` pins the dependency graph. Run `npm ci --ignore-scripts` after dependency updates; a passing check with stale installed packages is not verification of the locked toolchain.

The U1 store requires Node 26.x and linked SQLite >=3.51.3. CI also exercises Node 24 for foundation checks and actual unsupported-runtime rejection; it is not a supported store runtime. See [worker validation](u1-worker.md) for the explicit alternate-runtime test option.

```sh
npm ci --ignore-scripts
npm run build
npm run check
```

Checks include strict TypeScript, Biome formatting/linting, Node tests and inspection of npm's actual package file list. `npm run format` applies formatting; `npm run lint` reports lint findings without rewriting them. Biome does not format Markdown/YAML here; review those files and validate workflows separately.

The formatter and type checker intentionally exclude historical `spikes/` and research. Those materials remain local pending separate publication review and are not prerequisites for these checks. Do not use an experiment's environment-specific runtime path as a package dependency strategy.

The product build emits the TypeScript store foundation as ESM JavaScript under `dist/`; the build test checks its relative imports and an isolated compiled store-worker smoke. This does not establish extension loading, command lifecycle, or Pi integration. Later slices must add compiled extension entries, declare actual Pi imports as wildcard peer dependencies as required by Pi's package contract, verify the runtime/OS matrix, and load a packed package in an isolated Pi environment. Do not load a developer's normal sessions, credentials or unrelated extensions during automated tests.

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

[U1 storage](u1-storage.md) and its [asynchronous worker](u1-worker.md) are implemented with built-in `node:sqlite`. Production source, tests and development scripts are typechecked. Command execution, Pi tools/delivery, governed lifecycle validation and packaged installation remain later work. The package stays private at version `0.0.0`; no publication or installation guarantee follows from the storage tests.
