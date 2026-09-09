# pi-watch

A small Pi extension for durable, owner-scoped background commands.

**Status: pre-release development.** SQLite and TypeScript are the selected direction. This repository establishes development foundations—not a working extension. Research and disposable experiments remain local pending separate publication review. No package has been published.

## Intended first iteration

Finite background commands with durable status/output, bounded execution, cancellation, and completion routed to the owning Pi session. No daemon, scheduler, PostgreSQL backend, or general orchestration framework.

The v0.1 behavior contract and runtime compatibility still need agreement and integration testing. Local experiments do not establish production guarantees.

## Development

Use Node **26** for the development tooling:

```sh
npm ci --ignore-scripts
npm run check
```

TypeScript checks types; **Biome** formats and lints; Node's test runner exercises the package policy. These tooling requirements do not yet define the extension's supported runtime range. The production SQLite binding and patched-engine requirement remain implementation decisions.

- [Contributing](CONTRIBUTING.md)
- [Development and Compound Engineering workflow](docs/development.md)
- [Release process and first-publication gates](docs/releases.md)
- [Security policy](SECURITY.md)

## Packaging

The package is deliberately `private: true`, version `0.0.0`, with no extension entry points. `npm run check:package` verifies npm's actual file list; `npm run check:release` **must fail** until the first implementation is ready. Research, local Pi configuration, command logs and databases are excluded from the package.

Pi discovers npm packages through the `pi-package` keyword and the `pi` resource manifest. Installation instructions will be added only after a packaged extension passes a clean, isolated load test. See [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## License

[MIT](LICENSE).
