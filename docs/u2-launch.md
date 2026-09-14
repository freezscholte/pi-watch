# U2-W4 launch and bounded-output contract

This internal slice runs one reserved command through a detached runner and a detached guardian. The launcher owns only reservation identity and passes the one-time runner capability through stdin; the runner claims and decides launch through the store; the guardian is the only actor allowed to spawn `/bin/sh`.

The guardian uses a private Node IPC channel for hello/readiness, topology, one-time grant, shell outcome and cleanup receipts. It probes its own process group and the runner's group with fixed-argument `ps`, refusing to launch if the topology is not independently verified. A grant is accepted only in the `ready` state. If the immutable deadline has already elapsed when that grant arrives, the guardian reports the deadline and an expired-before-spawn shell error, exits, and never calls the shell spawn site. The command receives no runner token or pi-watch internal environment variables.

W4 retains the first **5,242,880 bytes per stream**, independently for stdout and stderr, while continuing to drain observed overflow. The cap is per stream, not cumulative. Fixed-layout raw files and bounded closure/truncation sidecars are private, identity-checked artifacts; SQLite remains the authority for durable result and capture facts. File existence, EOF, a closure receipt, or a finalized result does not prove shell success or all-descendant stop.

A Pi-independent reader takes an already-authorized SQLite observation and a fixed-layout capability, then returns complete version-1 success/error envelopes. It uses independent raw-byte offsets, terminal-safe UTF-8 text, at most 2,000 logical lines, and at most 51,200 serialized UTF-8 bytes. It performs no owner lookup, authorization, process control, or Pi work. Parent-plan U3 still owns owner authorization and missing-job masking, `watch_output` tool registration, and exact envelope pass-through without another wrapper.

A launched shell records its exit code or signal separately from capture and cleanup facts. Guardian cleanup is best effort: the runner only disconnects the guardian channel and never signals the guardian; the guardian then attempts own-group TERM once, followed by a five-second monotonic grace and own-group KILL intent. Cleanup remains `unconfirmed`; this does not claim descendant death. Guardian exit/loss or expiry of the runner's finite observation budget starts one 1,000 ms capture cutover. The runner then closes its read endpoints without awaiting EOF, which may expose surviving writers to EPIPE/SIGPIPE. Roughly six seconds after root-shell exit remains a healthy-runtime expectation, not hard real-time: scheduling, filesystem, and kernel stalls can add delay.

Callers must run `preflightLauncher({ dbPath, trustedRoot, runnerEntry? })` before reservation; `launchRunner` repeats the same checks as defense in depth. Before-start cancellation and deadline suppression are decided durably before the grant. Decision errors, lost acknowledgements and runner loss fail closed; no recovered state grants a shell. Capture callbacks do not create result revisions or notices; launched jobs publish one launch revision and one terminal revision after capture sealing, while pre-launch suppression publishes one atomic terminal revision.

## Storage and security boundary

Output and commands may contain secrets. Private permissions and future owner-scoped tools do not protect them from another process running as the same OS user, command-line inspection, inherited environment access, backups, or host monitoring. Diagnostics and output error envelopes remain redacted; sanitized captured output belongs only in a successful future authorized output response.

Storage is retained indefinitely. Total disk use is unbounded across jobs, two streams, sidecars, SQLite/WAL files, failures, remnants, and orphans. W4 adds no deletion, expiry, quota, or reclamation, and failed or interrupted jobs can leave non-authoritative partial artifacts.

## Claims not earned by W4

W4 does not establish all-descendant stop, cancellation delivery, heartbeat/reconciliation, Pi authorization or delivery, reload survival, packed installation, or broad OS support. It also adds no daemon, scheduler, arbitrary output path, or second backend/runtime. Those later owner, recovery, lifecycle, and packaging slices remain required.

## Internal test architecture

Internal test seams are environment-gated, unreachable from production argv/API, and centralized in `src/test-seams.ts`. Existing launch tests use a runner-executable override (`PI_WATCH_TEST_RUNNER_EXECUTABLE`), utility and guardian path overrides, bounded runner pause points, a controller post-launch pause, decision-call failure and committed-response-loss injection, a runner publication delay, pre-grant IPC disconnect, and runner/guardian PID and monotonic event logs.

Every W4 fault or scheduling selector introduced for capture and coordinator tests requires `PI_WATCH_INTERNAL_TEST_SEAMS=1`: capture fault, publication failure, stdout/stderr stream error and its synthetic detail (accepted only up to 128 UTF-8 bytes and never logged), freeze delay, race coordinator, and the guardian `withhold-all-and-hold` mode. Other guardian fixture modes are `withhold-spawn`, `withhold-exit`, `withhold-deadline`, `late-topology`, `delay-disconnect`, `disconnect-before-shell`, `disconnect-after-spawn`, and `disconnect-and-hold`. The runner explicitly allowlists only the guardian fixture mode/log variables across its environment boundary; all other `PI_WATCH_*` variables are removed before guardian and shell execution.

`tests/fixtures/owned-process-registry.ts` is the one per-test PID and known-PGID registry. Tests register identities they directly spawn or receive, install its cleanup hook before launch, and perform bounded exact-identity cleanup with no process scans or reconstruction from a reused PID. The injected-failure reporter proof runs a deliberately failing child test, verifies its registered runner, guardian, shell, and holder are reaped, and checks reporter output, logs, stacks, and causes remain sentinel-free.

These seams and fixtures are test-only architecture, not public API, user configuration, or earned production behavior. Diagnostics from runner/guardian failures do not include command text, capability tokens, output, or private paths. The topology probe has its own hard timeout: it SIGKILLs only its exact owned child, destroys that child's stdio, and guardian shutdown stops any live probe.
