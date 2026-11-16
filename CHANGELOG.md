# Changelog

Every user-visible change to ocpp-mimic is listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semantic versioning](https://semver.org/) as the user guide's "Versions and compatibility" section describes.

## [Unreleased]

The first release, 0.1.0. It collects milestones M1 to M8 of the [design](docs/design.md).

### Added

- **OCPP 1.6J charge points** (M1, M3): every feature profile (Core, Firmware Management, Local Auth List Management, Reservation, Smart Charging, Remote Trigger) and the Security Whitepaper (security profiles 1 to 3, certificates, signed firmware, security events and logs). Multiple connectors, an offline queue, reconnects and spec-compliant CALLERRORs.
- **Personas**: YAML descriptions of a charge point model (boot fields, connectors, power, features, configuration, timing, EV profiles, faults) with `extends`; `generic-1.6`, `generic-2.0.1` and `generic-2.1` built in, and samples in `scenarios/personas/`.
- **EV model**: battery capacity, SoC, charging curve with taper, phases, and an energy multiplier to charge faster than real time.
- **Web UI and engine HTTP API** (M1, M6): create and drive stations, inject faults, browse the Device Model, read the message log, follow charging sessions with their start timeline, energy, vehicle data, costs and a reference price.
- **Scenarios** (M2): YAML tests with station actions, expectations, built-in CSMS steps and HTTP calls, run by `ocpp-mimic run` with a JUnit report.
- **Built-in test CSMS** (M2, M4, M6, M7): in scenarios, or on its own with `ocpp-mimic csms`, with TLS, Basic Auth, answer delays, a reference tariff and a control API.
- **Fault injection** (M3): network, protocol, device and power faults from the Web UI, the API and scenarios.
- **Scale** (M4): bulk station templates, a usage model for stations that charge on their own, `ocpp-mimic load` with thresholds and reports, Prometheus and OpenTelemetry metrics, and `pnpm bench`. 1,000 stations run for an hour on a 2-vCPU machine.
- **Logs** (M4): a JSONL log format, `ocpp-mimic import` with masking, `ocpp-mimic replay` and `ocpp-mimic calibrate`.
- **OCPP 2.0.1** (M5): the Device Model, TransactionEvent, Core, Advanced Security, Local Authorization List, Smart Charging and Reservation, checked against CitrineOS.
- **Charging sessions** (M6): sessions with their start source, timeline, estimates against the EV's truth, vehicle data by OCPP version, and a reference price.
- **OCPP 2.1** (M7): tariffs and the station's own cost, payment terminals and web payments, transaction limits and resuming, priority and dynamic charging, ISO 15118-20 vehicle data and a virtual display.
- **User guide** in English and Chinese (`docs/guide.md`, `docs/guide.zh-CN.md`).
- **License**: the Business Source License 1.1, with third-party notices, `CONTRIBUTING.md` and `SECURITY.md`.
- **API token** (`--api-token`, `OCPP_MIMIC_API_TOKEN`) for the engine's API, `/metrics`, the events WebSocket and the Web UI, and for the built-in CSMS's control API (`csms --api-token`; `serve --csms-api-token` for remote starts through it). A server that listens beyond loopback without a token warns at start.
- **npm package** `ocpp-mimic`: one install with the CLI, the Web UI, the built-in personas, the OCA schemas, the test PKI and the samples; `ocpp-mimic samples <dir>` copies the samples to edit; the command names the Node.js version it needs on an older one.
- **Docker image** `ghcr.io/jasonkong/ocpp-mimic` for linux/amd64 and linux/arm64, running `serve` by default with its store in `/data`, and `docs/examples/docker-compose.yml` with the engine and the built-in CSMS.
- **Versions**: version 0.1.0 in `--version`, both `/api/health` answers and OTLP's `service.version`; this changelog.

### Fixed

- Scenario waits (`within`, timeouts) count only the time the computer is awake, and a scenario reports how long the host slept (`host asleep`), instead of failing after a laptop sleep or taking an unexplained 15 minutes (#264).
