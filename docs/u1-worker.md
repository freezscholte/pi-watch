# U1: asynchronous store worker

The worker/client layer completes the internal [U1 storage foundation](u1-storage.md). Synchronous SQLite operations run in a worker thread so a busy wait does not block the caller's event loop. This is not a command runner or a Pi extension entry point.

`openStoreClient` performs runtime preflight before creating the worker. Startup observes readiness, initialization errors, worker errors, early exit and a five-second startup timeout. A failed startup requests termination of the original worker. It waits up to one second for cleanup confirmation; a rejected or pending termination reports that cleanup was not confirmed rather than claiming the thread stopped.

Newer-schema errors retain guidance to update pi-watch. Diagnostics use fixed, redacted messages. An unsuccessful startup never exposes a usable client, including when readiness arrives after failure.

Post-startup requests retain owner and capability fences. A reservation's candidate ID is allocated before worker handoff, so a lost response can still name the possibly accepted job. Unknown and known-committed outcomes stay distinct across the worker protocol. Neither permits command replay. Closing the client terminates its store worker; there are no independent command processes in U1.

## Verification

With the pinned development dependencies installed, run:

```sh
npm ci --ignore-scripts
npm run check
```

On an unsupported runtime, the rejection test uses the current Node executable automatically. To include that test while running the full suite on supported Node 26, set `PI_WATCH_UNSUPPORTED_NODE` to an existing unsupported Node executable:

```sh
PI_WATCH_UNSUPPORTED_NODE=/path/to/node24 npm run check
```

Without an explicit executable on Node 26, that one test reports a skip; a skip is not unsupported-runtime proof. No runtime is downloaded by the tests.

Coverage includes twenty concurrent storage actors, independent-process replay/conflicts, pre/post-COMMIT process loss, busy waits, pending-request failures, startup cleanup, stale-witness races and actual SQLite fault/reopen cases. The test-only worker URL/mode/timeout/observer options are internal test seams, not a public extension API.

Local runtime evidence is macOS arm64, Node 26.7.0 / SQLite 3.53.4, plus Node 24.11.1 unsupported-runtime rejection. Minimum Node 26.0.0, other platforms, hardware/power-loss failures, real Pi/governed-child behavior and packed-extension loading remain separate validation targets. Worker termination cannot instantly interrupt an arbitrary native call.

The package remains private, version `0.0.0`. U2 must add command execution and bounded capture; later units must integrate trusted Pi ownership, tools, delivery and lifecycle validation before installation claims are appropriate.
