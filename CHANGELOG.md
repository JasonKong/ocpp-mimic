# Changelog

Every user-visible change to ocpp-mimic is listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semantic versioning](https://semver.org/) as the user guide's "Versions and compatibility" section describes.

## [Unreleased]

### Added

- **Ways to start a session**: free vending on 1.6 with ocpp-mimic's vendor keys `FreeVendEnabled` and `FreeVendIdTag` (plugging in starts, without a card); the built-in CSMS's auto start for valet stations (a session on every plug-in) and remote stop, as `auto-start` and `remote-stop` in its control API and `POST /api/stations/<id>/auto-start` and `POST .../connectors/<n>/remote-stop` on the engine.
- **Personas**: `generic-dual-1.6`, `generic-dual-2.0.1` and `generic-dual-2.1`, the generic personas with two ports.
- **Demo page** in the Web UI (`#/demo`): set up a charging site (its OCPP version, how sessions start and its single and dual charge points), then plug cars in and out, start them together and watch them fill up while the OCPP messages fly between the stations and the CSMS, and a site manager panel adds up power, energy and the cars charging or full. `ocpp-mimic demo` starts the built-in CSMS and the engine for it in one process.
- **API**: `GET /api/personas` reports each persona's `power`.
- **Site load management** in the built-in CSMS: a site's capacity is shared between its sessions with smart charging (equal shares, what a car does not take passed on, at least 6 A each; full cars, then the latest, wait at 0 when that does not fit), as TxProfiles in W. `PUT`, `GET` and `DELETE /api/sites/<id>` on its control API and on the engine.
- **Shared supply**: a persona's `power.stationW` is one supply the connectors share, as on a dual charger: equal shares, and what a car does not take goes to the others. `generic-dual-*` share 11.04 kW between two 7.36 kW ports.

### Changed

- A 2.x station with `AuthCtrlr.Enabled` false starts a transaction when an EV is plugged in, with an empty `NoAuthorization` token, instead of waiting for a card.
- A 1.6 transaction whose charging limit is 0 shows SuspendedEVSE until the limit rises, as 2.x already did; on 2.x a station-wide limit of 0 does too.
- A ChargePointMaxProfile (1.6) or ChargingStationMaxProfile (2.x) is shared between the charging connectors by demand instead of split equally, so a full or tapering car's share goes to the others; a limit in amperes is taken as three-phase at 230 V.

## [0.1.0] - 2026-11-17

The first release, 0.1.0. It collects milestones M1 to M8 of the [design](https://github.com/JasonKong/ocpp-mimic/blob/main/docs/design.md).

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
- **User guide checks**: every YAML and JSON example in both guides is validated, and every option they name must exist for its command. The install section starts from a release.
- **Versions**: version 0.1.0 in `--version`, both `/api/health` answers and OTLP's `service.version`; this changelog.

### Fixed

- Scenario waits (`within`, timeouts) count only the time the computer is awake, and a scenario reports how long the host slept (`host asleep`), instead of failing after a laptop sleep or taking an unexplained 15 minutes (#264).
