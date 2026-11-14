# ocpp-mimic

An OCPP charge point simulator: a headless engine runs many virtual charge points against the CSMS under test. See the design in [docs/design.md](docs/design.md) ([Chinese version](docs/design.zh-CN.md)).

> Status: M1 in progress — OCPP 1.6J Core charge points, engine API and Web UI work; see the M1 milestone.

## Requirements

- Node.js 24 (see `.nvmrc`; switch with fnm or nvm)
- pnpm 12 (see the `packageManager` field in `package.json`)

## Commands

| Command          | What it does                                                                     |
| ---------------- | -------------------------------------------------------------------------------- |
| `pnpm install`   | Install dependencies                                                             |
| `pnpm build`     | Build all packages and the Web UI                                                |
| `pnpm typecheck` | Type-check everything, including tests and Vue components                        |
| `pnpm test`      | Run unit tests (against sources; no build needed)                                |
| `pnpm lint`      | Run ESLint                                                                       |
| `pnpm format`    | Format with Prettier                                                             |
| `pnpm serve`     | Build everything and start the engine with the Web UI at `http://127.0.0.1:7300` |
| `pnpm dev:web`   | Start the Web UI dev server; `/api` is proxied to the local engine               |

## Running scenarios

Scenarios are YAML files of steps and expectations (see "Scenario format v1" in [docs/design.md](docs/design.md)). After `pnpm build`:

```bash
node packages/cli/dist/main.js run scenarios/examples
```

Each scenario runs on its own embedded engine, by default against the built-in test CSMS, and prints `PASS`, `FAIL` or `ERROR` with the failing step. Useful options: `--csms <url>` (with `--allow-csms <prefix>`) to test another CSMS, `--var NAME=value`, `--personas <dir>`, `--timeout <duration>` and `--bail`. The exit code is 0 when everything passed, 1 when something failed and 2 when a file does not validate.

## Layout

| Directory         | Contents                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`   | Protocol, state machines, persona interpreter. Pure logic with no IO: its tsconfig loads no Node or DOM types, so timers, sockets and files do not compile; time comes in through `Clock` |
| `packages/engine` | Runtime: HTTP / WebSocket API, charge point scheduling, persistence                                                                                                                       |
| `packages/cli`    | The `ocpp-mimic` command: starts the engine, and later runs scenarios                                                                                                                     |
| `apps/web`        | Vue 3 Web UI; calls only the engine API and holds no simulation logic                                                                                                                     |
| `docs`            | Design documents                                                                                                                                                                          |
| `scenarios`       | Scenario files for `ocpp-mimic run`: reference examples, later the regression suite                                                                                                       |

## Third-party material

`packages/engine/oca-schemas/ocpp16/` contains the Open Charge Alliance's official OCPP 1.6 JSON Schema files, © 2010 – 2025 Open Charge Alliance, shipped unchanged under the [Creative Commons Attribution-NoDerivatives 4.0 International licence](https://creativecommons.org/licenses/by-nd/4.0/legalcode). See [its README](packages/engine/oca-schemas/README.md) for the source and the rules for keeping them unchanged.
