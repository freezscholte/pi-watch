# pi-watch

A small Pi extension for durable, owner-scoped background commands.

**Status: pre-release development.** The internal owner-scoped SQLite store, one-shot runner/guardian command lifecycle, and bounded output reader are implemented and locally tested. Pi owner authorization, tool registration and result delivery are not implemented, so this is not yet a working extension. Research and disposable experiments remain local. No package has been published.

## Intended first iteration

Finite background commands with durable status/output, bounded execution, cancellation, and completion routed to the owning Pi session. No daemon, scheduler, PostgreSQL backend, or general orchestration framework.

The selected runtime is Node 26.x with linked SQLite 3.51.3 or newer. Real Pi and platform integration testing remains ahead; internal lifecycle tests do not establish reload survival, packed installation, broad OS support, or Pi authorization or delivery.

## Current output boundary

pi-watch retains the first **5,242,880 bytes per stream**, separately for stdout and stderr, and drains observed overflow. The limit is not cumulative. The internal reader uses independent raw-byte offsets and returns a complete version-1 envelope limited to 2,000 logical lines and 51,200 serialized UTF-8 bytes. Parent-plan U3 still owns the authorization and `watch_output` registration that will expose this envelope.

Output and commands may contain secrets. Private local files do not protect them from processes running as the same OS user or from ordinary host/process inspection. Capture files are retained indefinitely, with no expiry or reclamation. Total disk use is unbounded across jobs, two streams, sidecars, SQLite/WAL files, failures, remnants, and orphans.

Capture finalization closes runner-owned read endpoints after a bounded healthy-runtime cutover instead of waiting for EOF; surviving writers may receive EPIPE/SIGPIPE. Timing is not hard real-time. The current implementation does not establish all-descendant stop, cancellation delivery, heartbeat/reconciliation, Pi authorization or delivery, reload survival, packed installation, or broad OS support.

## Development

Use Node **26** for the development tooling:

```sh
npm ci --ignore-scripts
npm run check
```

TypeScript checks types; **Biome** formats and lints; Node's test runner exercises storage, ownership, worker failures and package policy. The store uses built-in `node:sqlite` and checks the actual linked engine before opening disk state.

- [U1 storage contract and validation limits](docs/u1-storage.md)
- [U1 asynchronous worker and runtime checks](docs/u1-worker.md)
- [U2 launch control and development schema 2](docs/u2-launch-control.md)
- [U2-W4 launch and bounded-output contract](docs/u2-launch.md)
- [Contributing](CONTRIBUTING.md)
- [Development and Compound Engineering workflow](docs/development.md)
- [Release process and first-publication gates](docs/releases.md)
- [Security policy](SECURITY.md)

## Packaging

The package is deliberately `private: true`, version `0.0.0`, with no extension entry points. `npm run check:package` verifies npm's actual file list; `npm run check:release` **must fail** until the first implementation is ready. Research, local Pi configuration, command logs and databases are excluded from the package.

Pi discovers npm packages through the `pi-package` keyword and the `pi` resource manifest. Installation instructions will be added only after a packaged extension passes a clean, isolated load test. See [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## License

[MIT](LICENSE).
