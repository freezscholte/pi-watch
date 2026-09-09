# Security policy

## Reporting a vulnerability

**Do not post exploit details, credentials, command output or private session data in a public issue.**

When GitHub private vulnerability reporting is enabled, use [Report a vulnerability](https://github.com/freezscholte/pi-watch/security/advisories/new). If that option is unavailable, open an issue containing only a request for a private reporting channel—no sensitive details—and wait for a maintainer to arrange one.

Private reporting was observed disabled during foundation setup. Enabling and verifying it is a maintainer prerequisite before the first public release; this document does not claim it is already enabled. No response-time SLA is promised.

A useful private report includes the affected version, minimal sanitized reproduction, impact, and whether the issue involves ownership, command execution, persistence or dependency handling.

## Supported versions

No released version exists yet. Development snapshots are unsupported experiments. The first release must define its supported Pi, Node and operating-system versions; initially only the latest stable release is intended to receive security fixes. Unsupported or unknown combinations must not be presented as tested.

## Trust model

Pi extensions execute with the user's system access. **pi-watch is not a sandbox.** Running a command can read credentials, modify files, access the network and launch descendants with the user's permissions. Install only trusted packages and run commands only with appropriate authorization.

Required implementation boundaries:

- Derive the owner from the trusted Pi context, never a model-supplied owner field. Check ownership on every read, update, cancellation and delivery operation.
- Session ownership restricts tool access; it does not isolate mutually untrusted processes sharing an OS account. Parent-visible subagent transcripts are a separate disclosure path.
- Custom execution tools need explicit permission integration. A gate that protects `bash` does not automatically protect Node spawning or another tool.
- Treat command output as untrusted data, never as instructions. Bound output, runtime and resource usage, and avoid logging secrets unnecessarily.
- Keep runtime stores outside source control and use restrictive filesystem permissions. SQLite metadata and logs can contain sensitive material; encryption at rest is not promised by this design.
- Do not replay an uncertain command automatically after a crash or expired heartbeat. Report unknown outcomes honestly.
- Cancellation requests are not proof that a command or all descendants stopped. Validate process ownership before signalling; a stored PID alone is insufficient after restart.
- Verify the actual SQLite engine contains required fixes. Local WAL storage is not a network-filesystem sharing mechanism.

These are implementation requirements, **not claims that the unimplemented extension already enforces them**.

## Supply chain and releases

Development dependencies are locked; installation and CI disable lifecycle scripts. GitHub Actions are pinned to commit SHAs and use least-privilege permissions. CI checks the real npm file list against an allowlist. These controls reduce risk; they do not prove dependencies or generated code are safe.

Before publishing, configure private reporting, branch/review protections, a protected release environment, and npm trusted publishing where supported. Never put a long-lived publishing token into pull-request jobs. The foundation has no automated publishing capability; see [release prerequisites](docs/releases.md).

Repository-local `.pi/` tooling is ignored and excluded from npm. Its use is optional; users and contributors must not inherit the maintainer's private extensions or model-provider policies.
