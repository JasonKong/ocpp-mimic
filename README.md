# ocpp-mimic

An OCPP charge point simulator: a headless engine runs many virtual charge points against the CSMS under test.

- **[User guide](docs/guide.md)** ([中文版](docs/guide.zh-CN.md)): installing, the Web UI, personas, scenarios, the built-in CSMS, OCPP 2.1 features, load tests, logs and the API.
- **[Design](docs/design.md)** ([中文版](docs/design.zh-CN.md)): how it works and why, milestone by milestone.

> Status: M1 to M10 are done; [0.3.0](https://github.com/JasonKong/ocpp-mimic/releases/tag/v0.3.0) is the latest release:
>
> - OCPP 1.6J with every feature profile and the Security Whitepaper; scenarios and CI; fault injection.
> - Scale: 1,000 stations on one machine, load tests, metrics, log import, replay and calibration.
> - OCPP 2.0.1 (M5), checked against CitrineOS.
> - Charging sessions in the Web UI (M6).
> - OCPP 2.1 (M7): tariffs and the station's own cost, ad hoc payment, ISO 15118-20 vehicle data and the 2.1 smart charging features, checked against the built-in CSMS and CitrineOS.
> - A release (M8): an npm package and a Docker image, an API token, the Business Source License 1.1.
> - A demo (M9): `ocpp-mimic demo` and the Web UI's Demo page, a charging site to play with: seven ways to start a session, single and dual charge points sharing a supply, and the built-in CSMS's site load management.
> - Payments (M10): the built-in CSMS takes the drivers' money with a simulated payment provider. It holds on a test card before the session starts, prices the session with its idle fee, and captures, releases or fails the payment, on the Demo page too.

## Install

With Node.js 24 or later, from the latest release:

```bash
npm install --global https://github.com/JasonKong/ocpp-mimic/releases/latest/download/ocpp-mimic.tgz
ocpp-mimic samples scenarios
ocpp-mimic run scenarios/examples --personas scenarios/personas
```

Or with Docker, for linux/amd64 and linux/arm64:

```bash
export OCPP_MIMIC_API_TOKEN="$(openssl rand -hex 24)"
docker run --rm -p 127.0.0.1:7300:7300 -e OCPP_MIMIC_API_TOKEN ghcr.io/jasonkong/ocpp-mimic:0.3.0
```

The [user guide](docs/guide.md) starts from there. The rest of this page is for working on ocpp-mimic itself.

## Requirements

- Node.js 24 (see `.nvmrc`; switch with fnm or nvm)
- pnpm 12 (see the `packageManager` field in `package.json`)

## Commands

| Command               | What it does                                                                     |
| --------------------- | -------------------------------------------------------------------------------- |
| `pnpm install`        | Install dependencies                                                             |
| `pnpm build`          | Build all packages and the Web UI                                                |
| `pnpm typecheck`      | Type-check everything, including tests and Vue components                        |
| `pnpm test`           | Run unit tests (against sources; no build needed)                                |
| `pnpm test:scenarios` | Build, then run the regression scenarios (`scenarios/regression`)                |
| `pnpm lint`           | Run ESLint                                                                       |
| `pnpm format`         | Format with Prettier                                                             |
| `pnpm serve`          | Build everything and start the engine with the Web UI at `http://127.0.0.1:7300` |
| `pnpm dev:web`        | Start the Web UI dev server; `/api` is proxied to the local engine               |
| `pnpm bench`          | Build, then run the benchmark harness (see below)                                |

## Running scenarios

Scenarios are YAML files of steps and expectations (see "Scenario format v1" in [docs/design.md](docs/design.md)). After `pnpm build`:

```bash
node packages/cli/dist/main.js run scenarios/examples
```

Each scenario runs on its own embedded engine, by default against the built-in test CSMS, and prints `PASS`, `FAIL` or `ERROR` with the failing step. Useful options: `--csms <url>` (with `--allow-csms <prefix>`) to test another CSMS, `--var NAME=value`, `--personas <dir>`, `--timeout <duration>`, `--bail` and `--junit <file>` for a JUnit XML report. The exit code is 0 when everything passed, 1 when something failed and 2 when a file does not validate.

## Running the test CSMS on its own

`ocpp-mimic csms` runs the built-in test CSMS as its own process, for example as the target of a load test or for stations created in the Web UI:

```bash
node packages/cli/dist/main.js csms --delay 20ms-100ms
```

Stations connect to `ws://127.0.0.1:9100/ocpp/<chargeBoxId>`. It accepts every station and answers every request; idTags starting with `UNKNOWN-` are Invalid (`--unknown-prefix`). Options: `--port`, `--host`, `--delay` (a fixed or random answer delay), `--heartbeat-interval`, `--password` (Basic Auth for every station), `--tls-cert` / `--tls-key` / `--tls-ca` / `--client-certificates` for wss://, and `--status` for how often it prints a status line. It keeps no frames, so memory stays flat over long runs, and prints a summary of requests by action when stopped with Ctrl-C.

## Load tests

`ocpp-mimic load <plan>` runs a load plan: groups of stations from templates that charge on their own, a ramp-up, timed fleet events (reconnect storms, power losses, fault injections) and pass / fail thresholds. Start a CSMS (here the built-in one) and run the smoke plan:

```bash
node packages/cli/dist/main.js csms --port 9102 &
node packages/cli/dist/main.js load scenarios/load/smoke-100.yaml --personas scenarios/personas --report-dir reports/load
```

It prints a progress line every 10 s and, at the end, every threshold with its measured value; the exit code is 0 when all pass. Options: `--csms`, `--duration`, `--report-dir` (report.json, report.md), `--junit`, `--port` (watch the run in the Web UI and `/metrics`), `--log-dir` (every frame as JSONL). Plans live in `scenarios/load/`; `m4-exit.yaml` is the M4 exit criterion, which the `soak` workflow runs on a GitHub-hosted runner every week and by hand. Only load-test a CSMS you operate or may test.

## Logs: export and import

A station's frames download as a JSONL log from the Web UI (Export JSONL) or `GET /api/stations/<id>/messages?format=jsonl`; `run --log-dir <dir>` writes one per scenario. `ocpp-mimic import` turns other logs into that format and masks identifiers:

```bash
node packages/cli/dist/main.js import csms-export.csv --map scenarios/import/csv-mapping.yaml --salt-file salt.txt -o masked.jsonl
```

A mapping (`scenarios/import/`) says where the time, station, direction and frame are in JSONL, CSV or plain log lines. Masked logs keep stable pseudonyms for the same salt; see "M4 scale" in the design for the rules.

## Benchmark

`pnpm bench` runs N stations in one process, the way `ocpp-mimic serve` runs them, against `ocpp-mimic csms` in a child process, and samples the engine every 5 s: event-loop delay, CPU, memory and frames a second, plus how late heartbeats and meter values go out.

```bash
pnpm bench --stations 1000 --duration 10m --rate 10 --out bench-results/run
```

Options: `--stations`, `--duration`, `--rate` (stations started a second), `--persona` (default `load-ac-1.6`), `--charging` (share of stations charging), `--csms-delay`, `--sample`, `--store` (keep state in SQLite, as `serve --store`), `--out` (samples.csv and summary.json) and `--heap-snapshot`. For a CPU profile run `node --cpu-prof packages/cli/dist/bench-main.js ...`. The `bench` workflow runs it on a GitHub-hosted runner, the M4 reference machine.

## Layout

| Directory         | Contents                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`   | Protocol, state machines, persona interpreter. Pure logic with no IO: its tsconfig loads no Node or DOM types, so timers, sockets and files do not compile; time comes in through `Clock` |
| `packages/engine` | Runtime: HTTP / WebSocket API, charge point scheduling, persistence                                                                                                                       |
| `packages/cli`    | The `ocpp-mimic` command: starts the engine, runs scenarios, runs the test CSMS on its own                                                                                                |
| `apps/web`        | Vue 3 Web UI; calls only the engine API and holds no simulation logic                                                                                                                     |
| `docs`            | User guide and design                                                                                                                                                                     |
| `scenarios`       | Scenario files for `ocpp-mimic run` (examples, the regression suite, SteVe variants), personas, and the M4 load plans and import mappings                                                 |

## License

ocpp-mimic is source-available under the [Business Source License 1.1](LICENSE). It is not an open source license:

- **Free**: any non-production use, such as trying ocpp-mimic, evaluating it, learning and personal projects, and production use for personal, educational, research and other non-commercial purposes.
- **Commercial production use** needs a commercial license from the licensor. If you are not sure whether your use is covered, ask through [GitHub](https://github.com/JasonKong).
- **Each version becomes open source**: four years after it is published, it is also available under the Apache License 2.0.

Contributions are welcome under the terms in [CONTRIBUTING.md](CONTRIBUTING.md); report security problems as [SECURITY.md](SECURITY.md) describes.

## Third-party material

ocpp-mimic ships third-party material under its own licenses, listed with their texts in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md):

- The Open Charge Alliance's official JSON Schema files for OCPP 1.6, its Security Whitepaper, 2.0.1 and 2.1 (`packages/engine/oca-schemas/`), shipped unchanged under the [Creative Commons Attribution-NoDerivatives 4.0 International licence](https://creativecommons.org/licenses/by-nd/4.0/legalcode). See [their README](packages/engine/oca-schemas/README.md) for the sources and the rules for keeping them unchanged.
- The npm packages the engine depends on, and Vue in the Web UI (MIT, ISC and BSD licenses). `pnpm notices:check` fails when a shipped package's license is not on the allow list.
