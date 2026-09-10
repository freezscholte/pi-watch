# pi-watch

A small Pi extension for durable, owner-scoped background commands.

**Status: pre-release development.** The internal owner-scoped SQLite storage and worker foundation is implemented and locally tested. Command execution and Pi integration are not implemented, so this is not yet a working extension. Research and disposable experiments remain local. No package has been published.

## Intended first iteration

Finite background commands with durable status/output, bounded execution, cancellation, and completion routed to the owning Pi session. No daemon, scheduler, PostgreSQL backend, or general orchestration framework.

The selected runtime is Node 26.x with linked SQLite 3.51.3 or newer. Real command, Pi and platform integration testing remains ahead; local storage tests do not establish those lifecycle guarantees.

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
- [Contributing](CONTRIBUTING.md)
- [Development and Compound Engineering workflow](docs/development.md)
- [Release process and first-publication gates](docs/releases.md)
- [Security policy](SECURITY.md)

## Packaging

The package is deliberately `private: true`, version `0.0.0`, with no extension entry points. `npm run check:package` verifies npm's actual file list; `npm run check:release` **must fail** until the first implementation is ready. Research, local Pi configuration, command logs and databases are excluded from the package.

Pi discovers npm packages through the `pi-package` keyword and the `pi` resource manifest. Installation instructions will be added only after a packaged extension passes a clean, isolated load test. See [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## License

[MIT](LICENSE).
