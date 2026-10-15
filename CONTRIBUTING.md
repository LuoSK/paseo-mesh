# Contributing

## Setup

```bash
npm install
```

Node.js 22 or newer. The end-to-end suite starts Paseo daemons from the `@getpaseo/cli` dev dependency with temporary homes and free ports; it never touches `~/.paseo` or a daemon on port 6767.

## Checks

Run these before every commit:

```bash
npm run typecheck
npm run lint        # biome; `npm run format` fixes formatting
npm test            # unit tests
npm run test:e2e    # real daemons, about a minute
```

`MESH_E2E_RELAY=1 npm run test:e2e` also tests connections through `relay.paseo.sh`.

## Layout rules

Paseo compiles the plugin itself and enforces its runtime boundaries:

- `index.server.ts` and `server/` run in Node. No React.
- `index.client.tsx` and `client/` run in the app. No Node built-ins; only `react`, `react-native`, `@tanstack/react-query`, `zod` and the `@getpaseo/plugin` client entries are available at runtime.
- `shared/` is imported by both and may only use `zod` and `@getpaseo/plugin`.
- No other code modules in the repository root besides the two entries and config files.

Server dependencies other than `zod` and `@getpaseo/plugin/*` are bundled from `node_modules`, so they must be in `dependencies`, not `devDependencies`.

## Lockfile

Git installs run `npm ci --omit=dev` with whatever npm the daemon host has, so `package-lock.json` must stay installable by npm 10 (Node 22) as well as npm 11. The Node 22 CI job enforces this. The `esbuild` dev dependency exists only for that: without it, npm 10 and npm 11 disagree about vite's optional `esbuild` peer and npm 10 rejects the lockfile.

## Tests

Add behavior tests to the existing suites: unit tests next to the module (`server/*.test.ts`), end-to-end tests in `test/e2e/mesh.e2e.test.ts`. If a scenario needs new agent behavior, extend the echo provider in `test/fixtures/echo-provider` instead of using a real model.

## Releases

See [docs/release.md](docs/release.md).
