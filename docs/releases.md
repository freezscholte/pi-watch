# Releases

## Current state: deliberately non-publishable

There is no extension implementation or public release. `package.json` is `private: true`, version `0.0.0`, with an empty `pi.extensions` array. The name `pi-watch` in this repository is not evidence of npm name ownership or availability.

`npm run check:release` must fail in this foundation state. The manual **Release readiness (no publishing)** workflow checks a candidate and can produce a tarball only after the guard passes. It has no publishing command, npm credential, OIDC permission or release-write permission. CI/workflows have not run remotely until these files are committed and pushed with approval.

## Before the first release

The maintainer must complete and verify these gates; files alone do not configure remote services:

1. Agree on v0.1 behavior and implement/test the actual extension. Select a supported Pi/Node/SQLite-binding/OS matrix, including a patched SQLite engine. Test lifecycle, ownership, cancellation, bounded output and uncertain recovery.
2. Produce runtime files under `dist/`, point `pi.extensions` at real loadable entries, and add a build step to CI/readiness. Declare any imported Pi core packages as wildcard peer dependencies according to the [Pi package contract](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md); do not bundle a second Pi runtime.
3. Run a **clean packed-package load test** in an isolated Pi environment. A dry-run file list is not that test. Document installation and supported versions only after it passes.
4. Confirm the final npm package name/namespace, ownership and account security. A scoped name is an option if the unscoped name is unavailable; update metadata and examples together.
5. Enable and verify GitHub private vulnerability reporting. It was disabled at foundation setup. Configure protected `main`, review requirements, required CI checks and restrictions on force pushes/deletion. CODEOWNERS alone does not enforce those rules.
6. Configure a protected release environment and npm trusted publisher for the exact repository, workflow filename and environment. Resolve the first-package bootstrap procedure with the registry before assuming OIDC can create an unregistered package.
7. Review the changelog, license/notices, actual tarball contents and generated code. Exclude local `.pi/`, research, dependencies, logs, databases and source maps containing unintended source.
8. Deliberately remove `private`, choose the release version, and update the placeholder description. The current guard expects `private: false` explicitly. Never remove the guard merely to make CI green.

## Version and artifact discipline

Use Semantic Versioning. Document breaking changes, including behavioral/storage changes, clearly; do not treat `0.x` as permission for silent incompatibility. Record user-visible changes under `Unreleased`, then move them into a dated version heading in the release PR.

For each release:

- Start from an approved, reviewed commit with a clean checkout and green checks. Version, changelog and later `vX.Y.Z` tag must agree.
- Install from the lockfile with lifecycle scripts disabled; run the explicit build, checks, integration tests and release guard. Avoid `--if-present` for a required build.
- Create and inspect the actual tarball. Record its checksum and test those same bytes; publish/promote that reviewed artifact rather than rebuilding different bytes after approval.
- Require human release approval. Configure a narrowly scoped trusted publisher, preferably a staged publish/approval flow when supported. Never publish from pull-request jobs or use `pull_request_target` to execute contributor code with secrets.
- Verify the installed registry artifact, Pi discovery, release notes and version before declaring success.

A first-release PR must add and test the final publishing workflow. The existing readiness workflow is intentionally only a preparation/checking mechanism, not a turnkey release system.

## Authentication and provenance

Prefer npm trusted publishing with GitHub-hosted runners over a long-lived write token. Current [official npm documentation](https://docs.npmjs.com/trusted-publishers/) requires npm **11.5.1+** and Node **22.14.0+** for trusted publishing; verify the current requirements again when configuring publication. OIDC permission belongs only on the gated publishing job, not CI.

The current npm documentation distinguishes `npm stage publish` from direct `npm publish`, with allowed actions configured per trusted publisher. Choose and test the intended approval flow rather than copying an old token-based workflow. Do not weaken account protection to bypass an authentication failure. Verify available provenance/signatures on the final artifact; a source commit or tarball hash alone is not a provenance attestation.

## Incident and rollback policy

Stop publication if checks, package contents or provenance are unexpected. If a released package is faulty, document impact and release a corrective version. Do not rewrite published version contents or move an existing release tag. Deprecation or exceptional unpublishing requires an explicit maintainer decision and coordinated user communication. Never ask users to attach sensitive command logs or databases publicly while diagnosing an incident.
