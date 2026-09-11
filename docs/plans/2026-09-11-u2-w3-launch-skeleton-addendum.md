# U2-W3 launch skeleton: runner, guardian and one-time shell start

Parent plan: v0.1 background-commands plan, unit U2 (KTD3, KTD4, KTD6, KTD12; "Guardian Control and Result Boundaries" protocol). Builds on [durable launch control](../u2-launch-control.md) (W2), [storage](../u1-storage.md) and the [store worker](../u1-worker.md). Supplements, does not change, the parent plan's Product and Planning Contract.

## Approved scope decision

The user confirmed W3 as the first real command-lifecycle slice with these choices:

1. **Own-group escalation is in W3.** A guardian that reaches its deadline, loses its runner channel or observes root exit runs the KTD6 own-group protocol (TERM, five-second grace, KILL) once. Without it a launched shell would have no deadline at all. Runner-side cancellation forwarding, heartbeats and stale-witness refinement stay in W5.
2. **Output is drained and discarded.** Shell stdout/stderr flow through pipes owned by the runner, exactly as the final topology requires, but W3 only counts bytes and records both streams as `available: false`. Private 5 MiB files, cutover and pagination (KTD8) are W4.
3. **Real-process tests run against `dist/`.** The runner and guardian are compiled entries; lifecycle tests build once and spawn the emitted files, following `tests/build.test.ts`.

Planning correction to the confirmed synthesis: **no schema bump is needed.** Schema 2 `job_results` and `ExecutionEvidence` already carry launch phase, shell code/signal, cleanup state, TERM observation, KILL intent, deadline trigger and per-stream capture facts. W3 publishes through the existing `claimRunner` / `decideLaunch` / `publishResult` interface. The fresh-schema policy from the [W2 addendum](2026-09-10-u2-launch-control-addendum.md) is unchanged and unused here.

## Goal

After W3, a reservation creator can launch one independent runner; that runner can start exactly one `/bin/sh -c` command through a guardian in its own process group, and the store ends up with finalized, evidenced shell outcome (or an evidenced non-execution) even when the launcher has exited. This is the first slice that earns "a command ran" as a claim. It does **not** earn quit-survival across Pi exit, output retrieval, cancellation delivery to a running command, descendant-stop proof or Pi integration.

## Actors and channels

| Actor | Entry | Spawned by | Process group | Owns |
| --- | --- | --- | --- | --- |
| Launcher | `src/launch.ts` (library, called by tests now, by the U3 adapter later) | caller | caller's | reservation identity; the only holder of `runnerToken` at creation |
| Runner | `dist/runner.js` | launcher, `detached: true`, no launcher stdio | its own | store worker client, claim, pre-spawn decision, one-time grant, output pipe read ends, result publication, finite observation budget |
| Guardian | `dist/guardian.js` | runner, `detached: true` | its own (≠ runner's) | shell spawn, TERM handler, immutable local deadline, own-group escalation, receipts to runner |
| Shell | system `/bin/sh` | guardian, not detached | guardian's | the command |

**Private control channel.** Runner ↔ guardian use the Node IPC channel created at guardian spawn (`stdio` slot `'ipc'`). The guardian refuses to start when no IPC channel is present (`process.send` undefined, or the first hello does not arrive within the readiness timeout). The channel carries small typed messages only: hello/ready, topology receipt, grant, shell spawn/error receipt, shell exit receipt, cleanup receipts. It never carries command output. Channel `disconnect` is "runner-channel loss" for the guardian and "guardian loss" for the runner.

**Output pipes.** The runner creates two pipes at guardian spawn (extra `stdio` slots) and keeps the read ends. The guardian launches the shell with those inherited descriptors as its stdout and stderr, stdin `'ignore'`, no PTY, then closes its own copies so EOF reflects shell-side closure only. In W3 the runner drains both read ends, counts bytes, and discards.

**Capability handoff.** The `runnerToken` must never appear in argv (visible to `ps`) and must never reach the guardian or shell environment. The launcher writes it once to the runner's stdin pipe and closes that pipe; the runner reads it into memory, then has no launcher-connected stdio. The runner spawns the guardian with an explicit environment copied from its own *minus* any pi-watch internal variables, and the guardian passes that environment to the shell. The token is not persisted by the runner. Job ID, owner UUID, store path and trusted root may be argv.

**Guardian grant state machine.** The guardian is a small explicit state machine: `starting → ready → granted → shell_spawned → cleaning → exited`, with `refused` reachable from any pre-shell state. A grant message is consumed only in `ready` (after the topology receipt was sent) and transitions irreversibly to `granted`; a grant in any other state — before readiness, a second grant, a grant after refusal or after shell spawn — is recorded as a protocol violation receipt and ignored, never acted on. The shell spawn call site is reachable from exactly one transition.

## Launch sequence

Each numbered step is a fail-closed checkpoint: failure at step *n* means no later step runs, and the runner publishes the most honest evidence it can (see Evidence).

1. **Reserve** (launcher). Existing `reserve`. Only `created: true` yields a `runnerToken`; a replay yields none and therefore cannot launch.
2. **Launcher preflight, then spawn runner** (launcher). Before reserving, the launcher runs the existing `checkRuntimeSupport()` for its own executable (the runner uses the same `process.execPath`) and verifies the compiled runner entry exists; failure rejects the start *before* reservation, with no durable state and no side effect. Then `spawn(process.execPath, [runnerEntry, …], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })`, write the token to stdin, close it. Retain the handle until `spawn` or `error` fires, then `unref`. An OS-level `error` is a typed launcher failure receipt; the job stays `reserved` with `unknown` evidence because the launcher holds no claim and cannot publish — W3 has no durable non-execution record for this case (W5 reconciliation surfaces it) and nothing ever respawns. The launcher does not wait for any application-level acknowledgment from the runner: OS spawn acknowledgment is the only thing it observes, and ambiguous runner startup remains `unknown`. Launcher exit does not affect the runner.
3. **Claim** (runner). Existing `claimRunner` with a fresh `claimId` and the token. Any error ends the runner without a grant.
4. **Preflight utilities** (runner). Resolve fixed system paths for `sh` and `ps` per OS (macOS: `/bin/sh`, `/bin/ps`; Linux: `/bin/sh`, `/bin/ps` then `/usr/bin/ps`). Missing utility → `spawn_failed` evidence, no guardian.
5. **Spawn guardian** (runner). Detached, IPC plus two output pipes. Observe `spawn`/`error`; retain the handle through readiness, then `unref`.
6. **Readiness and topology** (guardian → runner). Guardian sends hello with its PID. Runner replies with its own PID. Guardian runs one fixed-argument `ps -o pgid= -p <ownPid>` and one for the runner PID, one-second timeout, 4 KiB output cap, and verifies own PGID = own PID ≠ runner PGID. It sends a topology receipt (ok or failure reason). Failure, timeout or malformed output → guardian exits without a shell; runner records `spawn_failed`.
7. **Pre-spawn decision** (runner). Existing `decideLaunch`. Only a live `authorized_now` continues. `suppressed_now` means the store already finalized suppression; the runner tells the guardian to exit and stops. `already_decided`, `precluded` and every error (including `StoreWriteError('unknown')`) end the runner without a grant and without further publication of execution facts.
8. **Grant** (runner → guardian). One message, sent once, only in direct response to a live `authorized_now` return value held in the same call frame. The runner never resends (there is no reconnect), never sends on any error path, and never derives a grant from `observeJob().control`. The guardian's state machine independently rejects anything but the first grant in `ready`.
9. **Arm deadline, install TERM handler, spawn shell** (guardian). The guardian computes its immutable local deadline from the job's `deadlineAtMs` (carried in the hello reply), installs its SIGTERM handler, then spawns `/bin/sh -c <command>` with `cwd`, inherited environment, stdin ignored, stdout/stderr on the inherited pipe descriptors. It sends a shell-spawned receipt with the shell PID or a shell-error receipt (e.g. `ENOENT` cwd). The runner publishes `launched` or `spawn_failed` accordingly.
10. **Root exit** (guardian → runner). On shell `exit`, send the code/signal receipt, then start cleanup once.
11. **Cleanup** (guardian). Triggered once by the first of: root exit, local deadline, runner-channel loss. `process.kill(0, 'SIGTERM')`; record `returned` or `error` literally; start a five-second monotonic grace; at expiry attempt `process.kill(0, 'SIGKILL')` even if the root already exited, recording KILL *intent* only. Send receipts for TERM observation and KILL intent when the channel is still open. Then exit. The guardian's own TERM handler must make the group TERM non-fatal to itself.
12. **Finalize** (runner). Publish the finalized revision when the guardian exits or the channel closes after known shell evidence, or when the runner's own observation budget expires. Then close the store client and exit. There is no path on which the runner waits indefinitely.

**Runner observation budget (finite shutdown).** The runner arms two timers: the job deadline, and a seven-second budget started at the first cleanup trigger it observes (shell exit receipt, guardian exit/loss, or its own deadline). Budget expiry finalizes with whatever is known. Cancellation polling, heartbeats and late-evidence refinement are W5; the runner does not read `job_control` after step 7.

## Evidence

All publication goes through `publishResult` with the runner's claim and token; `mergeEvidence` rejects contradictions, so the runner must publish monotonically:

| Situation | `launch` | shell | `cleanupState` | streams | `finalized` |
| --- | --- | --- | --- | --- | --- |
| Utility missing, guardian spawn/readiness/topology failure, shell spawn error | `spawn_failed` | null | `not_required` | `available: false` | true |
| `decideLaunch` suppressed | (store already wrote it) | – | – | – | already finalized by W2 |
| `decideLaunch` error/`already_decided`/`precluded` | unchanged (`unknown`) | – | – | – | **not published**; runner exits. A stale-witness reconciliation (W5/U3) surfaces uncertainty. |
| Shell spawned | `launched` | null | `not_requested` | `available: false` | false |
| Shell exited, cleanup receipts received | `launched` | code/signal | `unconfirmed`; TERM observation and KILL intent as received | `available: false`, `incomplete: true` | true |
| Shell exited, guardian lost before receipts | `launched` | code/signal | `unconfirmed`, observation null | as above | true |
| Grant sent, no shell-spawned/error receipt, then guardian exit/loss or budget expiry | `unknown` (unchanged) | null | `not_requested` | `available: false` | true — honest "unknown whether it ran"; never retried |
| Guardian lost before shell exit receipt | `launched` | null | `unconfirmed` | as above | true; the revision-level `uncertain` flag is false because `publishResult` sets `uncertain = !finalized`, while the shell outcome stays unknown |
| Deadline reached at guardian before shell exit | `launched` | whatever arrives | `unconfirmed`; `deadlineTriggerObserved: true` | as above | true |

`cleanupState: unconfirmed` is the ceiling in v0.1; no receipt, signal return or EOF upgrades it. `stdout.incomplete`/`stderr.incomplete` are true for every launched command in W3 because nothing was retained; W4 replaces that with real capture facts.

## Files

- `src/launch.ts` — `launchRunner(store, reservation, options)`: spawn, spawn/error acknowledgment, unref, typed launch receipt. No shell knowledge.
- `src/runner.ts` — compiled entry; store client, claim, preflight, guardian spawn, handshake, decision, grant, drain, finalize.
- `src/guardian.ts` — compiled entry; channel guard, `ps` probe, deadline, TERM handler, shell spawn, escalation, receipts.
- `src/guardian-protocol.ts` — message types and validators shared by both entries; fixed-argument utility resolution; no I/O.
- `src/process-control.ts` — small helpers: own-group signal attempt with literal observation, monotonic timers, bounded `ps` execution.
- `tsconfig.build.json` unchanged; `scripts/build.ts` unchanged. `package.json`: no new dependencies; the `test` script becomes build-then-test (`node scripts/build.ts && node --test tests/*.test.ts`) so exactly one build precedes all test processes. Runner/guardian import nothing from Pi.
- `tests/build.test.ts`: drop its own `before` rebuild (which deletes `dist/` and would race concurrently running lifecycle tests); consume the pre-test artifact and extend the expected emitted-file list with `runner.js`, `guardian.js`, `guardian-protocol.js`, `process-control.js`, `launch.js` and their `.d.ts` files.
- `tests/runner.test.ts`, `tests/guardian.test.ts` — real-process lifecycle tests against `dist/`.
- `tests/fixtures/launch-controller.ts` — drives a reservation + `launchRunner` against a temp trusted root, exposes actor PIDs, kills/holds actors at named points, and reads the store from a separate owner-scoped client.
- `tests/fixtures/command-child.ts` — a Node script used as the command body: holds until a marker file appears, exits with a requested code, ignores TERM, or spawns a descendant that holds the pipes.
- Docs: `docs/u2-launch.md` (new internal contract: actors, channel, sequence, evidence table, limits) and a link from `docs/development.md`.

Existing patterns to follow: `tests/build.test.ts` for build-once-then-spawn; `tests/fixtures/store-actor.ts` for separate-process store actors; redaction rules from `src/job-store.ts` diagnostics for any runner/guardian stderr.

## Test scenarios

Begin with these failing real-process tests, then implement (parent plan execution note). Parent-plan scenario numbers in brackets.

1. **Held command returns early; root exit still escalates [1, 5].** Launch a command that holds on a marker file. `launchRunner` returns before the shell exits; the store shows `launched`, `finalized: false`. Releasing the marker leads to a finalized revision with `shellCode: 0`, `cleanupState: 'unconfirmed'`, both streams `available: false`. The guardian's receipts show exactly one cleanup sequence: TERM observation `returned`, then KILL intent at least five monotonic seconds later, even though the root had already exited.
2. **Distinct outcomes [1].** Exit 0, exit 3, `kill -TERM $$` inside the command, and a nonexistent `cwd` produce respectively code 0, code 3, `shellSignal: 'SIGTERM'`, and `launch: 'spawn_failed'` with no shell PID receipt.
3. **Replay never launches [2].** A second `reserve` with the same key returns `created: false`, no token, and `launchRunner` refuses; the command's side effect (a file written by the command) exists exactly once.
4. **Launcher exits naturally [10].** A wrapper process calls `launchRunner` and returns normally; assert it exits promptly (no referenced child handle keeps it alive) while the runner and guardian survive, the command completes, and a separate store client sees the finalized result. Also: `SIGKILL` the wrapper mid-launch as an additional case. Also: point the launcher at a nonexistent runner entry → typed launcher failure, job stays `reserved`/`unknown`, no respawn on a second `launchRunner` call with the same reservation.
5. **Before-start cancellation with a real runner [4].** Hold the runner just before `decideLaunch` (test-only pause seam, env-gated, absent from production paths), record cancellation through a separate owner client, release. Store shows `suppressed_cancelled`, no guardian shell receipt, the marker-file side effect never appears. Repeat with an already-expired deadline and no cancellation → `suppressed_deadline`. Repeat with both → cancellation wins.
6. **Decision boundary grants nothing on any non-live path [4, 14].** (a) `beforeCommit` failure on `decideLaunch` → runner exits, guardian exits without shell, no side effect. (b) `afterCommit` response loss on `decideLaunch` (the decision *is* committed as `authorized`, the runner sees `StoreWriteError('unknown')`) → no grant, no shell, no side effect; `observeJob().control` later shows `authorized` and nothing acts on it. (c) Pause the runner immediately after receiving `authorized_now`, before the grant is sent, and `SIGKILL` it → guardian exits on channel loss without a shell. (d) Send the guardian a duplicate grant, a grant before readiness, and a grant after shell spawn from a test harness standing in for the runner → exactly one shell in the whole test, protocol-violation receipts for the rest.
7. **Kill the runner before the grant [13].** Hold the runner between topology receipt and `decideLaunch`; `SIGKILL` it. The guardian exits without spawning a shell; no side effect; the store stays at `unknown` (not finalized). Nothing relaunches on reopen.
8. **Guardian refuses without its channel [14].** Spawn `dist/guardian.js` directly with no IPC → exits nonzero immediately, no shell. Spawn it with IPC but never send hello → exits at readiness timeout, no shell.
9. **Topology failure fails closed [14].** Point the guardian's `ps` path at a fixture that returns garbage / hangs past one second / prints 8 KiB → topology failure receipt, no shell, runner records `spawn_failed`.
10. **Missing utilities [14].** Fixture overrides the utility path table to a nonexistent `sh` → `spawn_failed` before any guardian spawn; same for `ps`.
11. **Own-group escalation on channel loss [5, 13 partial].** Command: `command-child --ignore-term --spawn-holder`. Kill the runner after the shell-spawned receipt (channel loss) → the guardian attempts TERM, waits ≥5 s monotonic, attempts KILL, exits; the guardian's escalation timeline is observed through a test-only fixture log, not the store. Observe the holder is gone as a fixture fact, *not* as a store claim. The store's last durable revision stays at `launched`, `finalized: false` — a dead runner publishes nothing, and reconciliation is W5; assert that nothing ever claims cleanup confirmed and nothing relaunches on reopen.
11b. **Lost spawn acknowledgment stays unknown [13, 14].** Guardian fixture mode that spawns the shell but withholds the spawn receipt → the runner's budget finalizes with `launch: unknown`, no shell outcome; the command's side effect exists at most once and a second `launchRunner`/reopen never issues another grant or shell.
12. **Deadline at the guardian [AE6, partial].** Deadline 2 s, command holds forever. Guardian TERMs its group at ≈2 s, KILLs at ≈7 s; runner finalizes with `deadlineTriggerObserved: true`, `shellSignal` as received, `cleanupState: 'unconfirmed'`. Launcher is already gone.
13. **Guardian killed after root exit [12, partial].** Command exits 0 while a descendant holds stdout open; `SIGKILL` the guardian after the exit receipt. Runner finalizes on guardian loss with code 0 and `unconfirmed`, without waiting for pipe EOF (the runner's budget bounds it).
14. **Runner budget without guardian evidence [15, partial].** Fixture guardian mode that never sends exit receipts. The runner's deadline timer + seven-second budget still finalizes an honest result.
15. **Token not in argv [16, partial].** While the runner is held, `ps -o args= -p <runnerPid>` (and the guardian's) contain neither the token nor the command text beyond what `/bin/sh -c` necessarily exposes; runner/guardian stderr on every failure path above contains no token, no command text, no absolute private paths.
16. **Unsupported runtime rejects before reservation.** Run the launch fixture under `PI_WATCH_UNSUPPORTED_NODE` → `launchRunner` rejects at launcher preflight; no reservation, no runner, no guardian, no side effect.
17. **Token never reaches the command [16].** The command body prints its environment to a fixture file; assert the token and every pi-watch internal variable are absent, and `ps -o args=` for runner and guardian contain no token.

Timing assertions use monotonic clocks and generous upper bounds; they assert ordering and minimums (≥5 s grace), not tight maxima.

## Verification boundary

Local verification is `npm ci --ignore-scripts`, `npm run check` on Node 26 (with `PATH` selecting Node 26.7.0), plus the Node 24 run for preflight rejection. `npm run check:package` must still pass with the two new `dist/` entries; `check:release` still fails intentionally.

Claims earned by W3: a real command runs once under the one-time grant; spawn-failure and before-start suppression are evidenced; launcher exit does not stop the job; the guardian fails closed without handshake/topology; escalation attempts are recorded as observations and intent.

Claims **not** earned: descendant death, output content, cancellation of a running command, survival across real Pi reload/exit (U5), Linux behavior beyond CI, Pi tool integration.

## Out of scope for W3

Output files and pagination (W4). Cancellation forwarding, heartbeats, stale-witness refinement, late-evidence merge (W5). Tools, delivery, wait bridge, Pi lifecycle, packed install (U3–U6). Any change to the Product Contract, schema, package visibility or version.

## Execution notes

- One writer per checkout; feature branch `feat/u2-w3-launch-skeleton` from `main` `b63a64d`.
- Test-first: land the fixtures and the failing scenarios before `src/runner.ts`/`src/guardian.ts` bodies.
- Test-only seams (pause points, utility path overrides, guardian fixture modes) are environment-gated and must be unreachable from production entry arguments; document them as internal, like the worker test seams.
- The exploratory guardian spike is evidence for `ps` probe and escalation shape, not code to promote.
- Stop at local verification and review; shipping (commit/push/PR/merge) needs separate approval.
