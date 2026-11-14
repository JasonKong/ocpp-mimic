# ocpp-mimic

An OCPP charge point simulator: a headless engine runs many virtual charge points against the CSMS under test. See the design in [docs/design.md](docs/design.md) ([Chinese version](docs/design.zh-CN.md)).

> Status: monorepo skeleton; no OCPP behaviour implemented yet.

## Requirements

- Node.js 24 (see `.nvmrc`; switch with fnm or nvm)
- pnpm 12 (see the `packageManager` field in `package.json`)

## Commands

| Command          | What it does                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `pnpm install`   | Install dependencies                                               |
| `pnpm build`     | Build all packages and the Web UI                                  |
| `pnpm typecheck` | Type-check everything, including tests and Vue components          |
| `pnpm test`      | Run unit tests (against sources; no build needed)                  |
| `pnpm lint`      | Run ESLint                                                         |
| `pnpm format`    | Format with Prettier                                               |
| `pnpm serve`     | Build and start the engine, by default at `http://127.0.0.1:7300`  |
| `pnpm dev:web`   | Start the Web UI dev server; `/api` is proxied to the local engine |

## Layout

| Directory         | Contents                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`   | Protocol, state machines, persona interpreter. Pure logic with no IO: its tsconfig loads no Node or DOM types, so timers, sockets and files do not compile; time comes in through `Clock` |
| `packages/engine` | Runtime: HTTP / WebSocket API, charge point scheduling, persistence                                                                                                                       |
| `packages/cli`    | The `ocpp-mimic` command: starts the engine, and later runs scenarios                                                                                                                     |
| `apps/web`        | Vue 3 Web UI; calls only the engine API and holds no simulation logic                                                                                                                     |
| `docs`            | Design documents                                                                                                                                                                          |
