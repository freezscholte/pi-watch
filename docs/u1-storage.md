# U1: owner-scoped storage foundation

U1 provides internal runtime checks, persisted-owner validation and durable SQLite records. It does not execute commands, register Pi tools or deliver completion notices to a session. The asynchronous worker facade is the next layer of this foundation; command execution follows separately.

## Runtime and ownership

The store requires Node **26.x** and linked SQLite **3.51.3 or newer**. Preflight checks the actual linked engine before opening disk state. Unsupported runtimes return `RUNTIME_UNSUPPORTED`.

`validateOwner` checks a readable persisted Pi session file with a matching `type: "session"` and `id` header. A moved file with the same valid identity remains the same owner; a fork's different identity does not. Later adapters must call this validation using trusted Pi context before accepting work. The low-level store takes that trusted owner identity; it does not grant authority from a model-supplied session field.

Every job read and mutation is owner-predicated. Reservation creators receive a private runner capability once; only its hash is persisted. Replaying the same request returns the existing job without that capability. A runner claim can be consumed only once.

## Persistence and refusal

Each connection uses WAL, `synchronous=FULL`, foreign keys and a 1,000 ms busy timeout. Short transactions atomically reserve jobs or publish a full result revision with its pending notice. Competing stale-witness publications recheck the observed claim, heartbeat counter and revision before committing.

The schema is private and versioned. Empty stores bootstrap atomically. Existing schemas must match the schema produced by the current engine; partial, malformed or unrecognized layouts are not repaired. Newer schemas return `SCHEMA_TOO_NEW` with guidance to update pi-watch.

Compatibility inspection uses ordinary read-only, WAL-aware SQLite access. SQLite-managed WAL/SHM coordination is permitted; refusal does not promise unchanged sidecar bytes. Refused stores receive no application writes, migrations or permission repair. A short-lived exclusive lock protects compatibility through DELETE-to-WAL conversion; already-WAL stores use ordinary locking.

The caller supplies `trustedRoot`, the last shared directory. Descendants must be private, directories use mode 0700 and database files use 0600. Shared roots and ancestors are not chmod-ed. Unsafe path types, symlinks, containment or existing permissions fail closed. This is not protection against a hostile process sharing the same OS account.

## Evidence is not execution authority

A reservation proves durable acceptance, not shell launch. Results keep launch, shell outcome, cancellation/deadline observations, cleanup and per-stream capture facts separate. Finalized evidence never implies that all descendants stopped.

Established facts cannot be erased or contradicted by later revisions. Non-execution cannot coexist with a shell outcome; cleanup `not_required` cannot coexist with TERM/KILL-attempt evidence. Uncertainty never grants permission to relaunch or signal a recorded process.

A failed COMMIT returns an explicit unknown outcome and disables further writes on that connection. Reservation uncertainty retains the preallocated job ID. A failure after COMMIT retains the known committed outcome. Recovery inspects durable metadata rather than treating either error as permission to repeat a command.

## Validation scope

Run the locked development checks on Node 26:

```sh
npm ci --ignore-scripts
npm run check
```

Tests cover owner isolation, replay, schema and private-path boundaries, conditional result/notice publication, and reopening after faults. Native fault fixtures exercise SQLite FULL at a statement and I/O errors at COMMIT using disposable child-only file-size limits. They do not fill the host disk or change host resource limits.

Local acceptance was on macOS arm64 with Node 26.7.0 / SQLite 3.53.4. CI results are separate evidence. Minimum Node 26.0.0, physical disk/power-loss behavior, real Pi/governed-subagent lifecycle and packed-extension loading are not established by these tests.

The package remains private at version `0.0.0`, with no extension entry points. Package-content checks do not prove extension loading. There is no migration from research/spike stores and no automatic deletion or retention cleanup.
