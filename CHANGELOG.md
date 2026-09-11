# Changelog

Notable user-facing changes will be recorded here using Semantic Versioning.

## Unreleased

- Establish MIT licensing, contribution/security guidance, TypeScript and Biome tooling, package-content checks, and CI foundations.
- Add the U1 internal foundation: persisted-owner validation, owner-scoped SQLite records, independent lifecycle evidence, safe schema refusal and an asynchronous store worker.
- Exercise real SQLite failure/reopen boundaries and worker startup cleanup; reject unsupported runtimes before disk mutation.
- Add durable owner cancellation requests and one-time launch decisions, with atomic suppression results/notices and explicit control-write uncertainty.
- Move the private development schema to version 2. Older stores are preserved and refused without migration or automatic deletion; development requires a fresh store.
- Add the internal U2-W3 detached runner/guardian launch skeleton with one-time shell grants, fail-closed topology checks and durable lifecycle evidence.

An internal reserved command can run once under the W3 one-time grant. Pi-facing command tools, delivery and integration are not implemented; no extension release is available yet.
