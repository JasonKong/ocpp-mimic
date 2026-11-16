# ocpp-mimic user guide

ocpp-mimic simulates OCPP charge points. One engine runs from one to thousands of virtual stations against the CSMS you are testing. You can drive them by hand in a Web UI, script them as YAML scenarios for CI, or let them charge on their own in a load test. It speaks OCPP 1.6J, 2.0.1 and 2.1.

This guide covers how to use it. For how it works inside and why, read the [design](design.md). [中文版](guide.zh-CN.md)

ocpp-mimic is source-available under the [Business Source License 1.1](../LICENSE): trying it, evaluating it and non-commercial use are free, and commercial production use needs a commercial license. The README's [License](../README.md#license) section explains it.

## Contents

1. [Install and first start](#1-install-and-first-start)
2. [Concepts](#2-concepts)
3. [The Web UI](#3-the-web-ui)
4. [Personas and EV profiles](#4-personas-and-ev-profiles)
5. [The built-in CSMS](#5-the-built-in-csms)
6. [Scenarios](#6-scenarios)
7. [OCPP versions and features](#7-ocpp-versions-and-features)
8. [Fault injection](#8-fault-injection)
9. [Fleets, load tests and metrics](#9-fleets-load-tests-and-metrics)
10. [Logs: export, import, replay and calibration](#10-logs-export-import-replay-and-calibration)
11. [Security profiles and the test PKI](#11-security-profiles-and-the-test-pki)
12. [Engine HTTP API](#12-engine-http-api)
13. [Command reference](#13-command-reference)
14. [Troubleshooting](#14-troubleshooting)

## 1. Install and first start

### Requirements

- **Node.js 24.** The repository's `.nvmrc` names it; `fnm use` or `nvm use` in the repository switches to it. An older Node fails at once with errors such as `does not provide an export named 'parseArgs'`.
- **pnpm 12**, as named in `package.json`'s `packageManager` field. `corepack enable` installs the right version.
- For the CitrineOS scenarios only: Docker.

### Build

```bash
git clone https://github.com/JasonKong/ocpp-mimic.git
cd ocpp-mimic
pnpm install
pnpm build
```

The command line tool is then `packages/cli/dist/main.js`. The examples in this guide call it `ocpp-mimic`; define that name in your shell from the repository root:

```bash
alias ocpp-mimic="node $PWD/packages/cli/dist/main.js"
```

`ocpp-mimic --help` lists every command and option, and `ocpp-mimic --version` prints the version.

### Installing the package instead

`pnpm pack:release` builds `release/ocpp-mimic-<version>.tgz`, the package a release publishes. It holds the command, the Web UI, the built-in personas and the samples, and installs with npm alone:

```bash
npm install --global ./release/ocpp-mimic-0.1.0.tgz
ocpp-mimic samples ./samples
```

`ocpp-mimic samples <dir>` copies the sample personas, example scenarios, load plans, import mappings and logs into `<dir>`; files already there are kept. Where this guide names `scenarios/personas` or `scenarios/examples`, use `<dir>/personas` and `<dir>/examples` instead. On a Node.js older than 24 the command says which version it needs.

### Running in Docker

Each release also publishes an image, `ghcr.io/jasonkong/ocpp-mimic`, for linux/amd64 and linux/arm64. Its entrypoint is `ocpp-mimic`, and its default command is `serve --host 0.0.0.0 --store /data/ocpp-mimic.db`. That listens beyond the container's loopback, so give it an [API token](#listening-beyond-this-machine-the-api-token):

```bash
export OCPP_MIMIC_API_TOKEN="$(openssl rand -hex 24)"
docker run --rm -p 127.0.0.1:7300:7300 -e OCPP_MIMIC_API_TOKEN -v ocpp-mimic-data:/data ghcr.io/jasonkong/ocpp-mimic
```

Any other command works the same way, for example `docker run --rm ghcr.io/jasonkong/ocpp-mimic --version`, or scenarios from the current directory with `docker run --rm -v "$PWD:/work" -w /work ghcr.io/jasonkong/ocpp-mimic run scenarios/ --junit report.xml`.

[`docs/examples/docker-compose.yml`](examples/docker-compose.yml) starts the engine and the built-in CSMS together. The CSMS shares the engine's network, so stations reach it at `ws://127.0.0.1:9100/ocpp` and remote starts from the Web UI work. Only the Web UI's port is published, and only on 127.0.0.1.

Inside a container, a CSMS on your machine is not on loopback. Allow its address, for example `--allow-csms ws://host.docker.internal:8180/`; on Linux, also pass `--add-host host.docker.internal:host-gateway` to `docker run`. `docker build -t ocpp-mimic .` builds the image from a clone.

### First start: a station against the built-in CSMS

You need two processes: a CSMS for the stations to connect to, and the engine that runs the stations and serves the Web UI. ocpp-mimic brings a small CSMS of its own for this.

1. Start the built-in CSMS in one terminal. Stations will connect to `ws://127.0.0.1:9100/ocpp/<station id>`.

   ```bash
   ocpp-mimic csms
   ```

2. Start the engine in a second terminal. `--personas scenarios/personas` adds the repository's sample personas to the three built-in ones.

   ```bash
   ocpp-mimic serve --personas scenarios/personas
   ```

3. Open <http://127.0.0.1:7300>.

4. Click **Add**. Enter an id such as `SIM-001`, pick `generic-1.6`, enter `ws://127.0.0.1:9100/ocpp` as the CSMS URL and click **Create and start**. The station connects, sends BootNotification, and shows its connectors as Available.

5. On connector 1, pick an EV such as `compact-40kwh`, click **Plug in**, type a card id such as `TAG-001` and click **Present card**. A transaction starts and meter values begin to flow. Open the **Sessions** tab to watch the session.

`pnpm serve` builds and starts the engine in one step, without the sample personas.

### Keeping stations across restarts

By default the engine keeps nothing: stopping it forgets every station. `serve --store <file>` keeps stations, their configuration or Device Model, transactions, local lists, charging profiles, tariffs and sessions in a SQLite file, and restarts them when the engine starts again.

```bash
ocpp-mimic serve --personas scenarios/personas --store ocpp-mimic.db
```

### Which CSMS addresses are allowed

To keep a mistyped URL from sending traffic to a system you did not mean to test, stations may only connect to this machine by default: `ws://127.0.0.1`, `ws://localhost`, `ws://[::1]` and their `wss://` forms. To test another CSMS, allow its address with `--allow-csms` (repeat it for more):

```bash
ocpp-mimic serve --allow-csms wss://csms.staging.example.com/
```

Only test a CSMS you operate or have permission to test, above all with load tests.

### Listening beyond this machine: the API token

The engine's API and the built-in CSMS's control API have no login: on 127.0.0.1, the default, only this machine reaches them. Before you listen on another address (`--host 0.0.0.0`, or a published container port), set an API token. Prefer the environment variable, which keeps the token out of the process list:

```bash
export OCPP_MIMIC_API_TOKEN="$(openssl rand -hex 24)"
ocpp-mimic serve --host 0.0.0.0 --personas scenarios/personas
```

With a token, every request to `/api/*` and `/metrics` needs `Authorization: Bearer <token>`; only `GET /api/health` stays open. The Web UI asks for the token once and keeps it until the browser tab closes. `serve`, `load --port` and `csms` take `--api-token <token>` as well. A server that listens beyond loopback without a token prints a warning at start.

The built-in CSMS reads the same variable. If it has a token, give the engine that token with `--csms-api-token` or `OCPP_MIMIC_CSMS_API_TOKEN`, so remote starts from the Web UI can go through it.

### Versions and compatibility

`ocpp-mimic --version` prints the version; the engine's and the built-in CSMS's `GET /api/health` report it too. [CHANGELOG.md](../CHANGELOG.md) lists every user-visible change.

Versions follow semantic versioning over what you write or call:

- the CLI's commands and options;
- the scenario, persona, load plan and log formats;
- the engine HTTP API and the built-in CSMS's control API.

The TypeScript packages inside the repository are not part of it. While the major version is 0, a minor version (0.1 → 0.2) may change these; the changelog then says what changed and how to adapt. A patch version (0.1.0 → 0.1.1) only fixes bugs.

## 2. Concepts

| Term | Meaning |
| --- | --- |
| **Engine** | The process that runs the virtual stations: `ocpp-mimic serve`, or one embedded in `run`, `load` and `replay`. It owns the sockets, timers, storage and the HTTP API |
| **Station** | One virtual charge point (Charging Station in 2.x). It has an id (the chargeBoxId / station identity), a persona, a CSMS URL, connectors (EVSEs in 2.x), and state such as configuration, transactions and charging profiles |
| **Persona** | A YAML description of one kind of charge point: OCPP version, BootNotification fields, connectors, power, features, configuration defaults, timing, EV profiles and faults. Stations are created from a persona |
| **EV profile** | A simulated car: battery size, starting SoC, maximum power, phases and how it talks to the station. Plugging in with an EV makes power, energy and SoC follow a battery model |
| **CSMS** | The central system the stations connect to. Either the one you are testing, or ocpp-mimic's **built-in CSMS** |
| **Scenario** | A YAML test: stations, steps and expectations. `ocpp-mimic run` runs scenarios and reports pass or fail |
| **Load plan** | A YAML description of a fleet, timed events and pass / fail thresholds, run by `ocpp-mimic load` |
| **Session** | One charging session as the engine recorded it: who started it and how, the frames, meter values, costs and the EV's true state |

The station id is appended to the CSMS URL: a station `SIM-001` with CSMS URL `ws://127.0.0.1:9100/ocpp` connects to `ws://127.0.0.1:9100/ocpp/SIM-001`. A station speaks its persona's OCPP version and offers only that subprotocol (`ocpp1.6`, `ocpp2.0.1` or `ocpp2.1`).

**Simulated time.** Timestamps are always real time. A station's **energy multiplier** (default 1) makes energy and SoC grow that many times faster, so a full charge can take minutes instead of hours. The Web UI shows times left in wall-clock time and marks the multiplier.

## 3. The Web UI

`ocpp-mimic serve` serves the Web UI on the same port as its API (default <http://127.0.0.1:7300>). `load --port <n>` serves it too, so you can watch a load test. When the engine has an [API token](#listening-beyond-this-machine-the-api-token), the UI asks for it first. The UI only calls the engine's API; everything it does can also be done with [the API](#12-engine-http-api) or in a scenario.

### Station list and the Add form

The left column lists the stations with their OCPP version badge, connection state and connector states. Search by id, and filter by state (Connected, Connecting, Offline, Stopped) or by group.

**Add** opens the form:

| Field | Meaning |
| --- | --- |
| Charge point id | The station id. With **How many** above 1 it must hold one counter in braces: `SIM-{001}` makes SIM-001, SIM-002, ...; the digits give the start and the width |
| How many | 1 to 10,000 stations from the same template |
| Group (optional) | For several stations: a group name to filter by and to label metrics |
| Persona | Each persona is listed with its OCPP version |
| CSMS URL | Without the station id, which is appended. The form remembers the last one |
| Password (optional) | The Basic Auth password (1.6 AuthorizationKey, 2.x BasicAuthPassword) |

**Create and start** creates the stations and connects them.

### Fleet overview

Above the station view, the **Fleet** card counts stations per persona or per group (online, offline, stopped, charging, faulted) and shows the engine's metrics: CSMS latency p50 / p95, timeouts, CALLERRORs, connections opened and failed, connections dropped by the CSMS or the network, and transactions.

### Station view

Selecting a station opens its view, with **Station** and **Sessions** tabs.

The header shows the id, version, persona, CSMS URL, connection state and, when it is not 1, the energy multiplier. Its buttons:

| Button | Effect |
| --- | --- |
| Stop / Start | Disconnect the station and stop its timers, or start it again |
| Go offline | A clean outage: the connection closes and messages queue until **Back online** |
| Half-open | The connection stays open but nothing goes through, as with a dead mobile link; the station notices only by its own timeouts |
| Delete | Remove the station and its stored state |

Below the header:

- **Inject**: pick a fault type and give its parameters as `key=value` pairs, for example `off=10s` for a power loss. Active injections are listed with a **Clear** link. See [Fault injection](#8-fault-injection).
- **Refuse remote starts**: answer every remote start with Rejected.
- **Lock the cable while charging**: a locked cable cannot be unplugged until the transaction ends or the CSMS unlocks it.
- **Energy ×**: the energy multiplier.

Each connector (each EVSE on a 2.x station) has a card with its status, charging state (2.x), transaction id, power, energy, SoC and, when a limit is in force, the limit. Its controls:

| Control | Effect |
| --- | --- |
| EV + **Plug in** | Plug in with an EV profile of the persona, or with no EV (the connector then draws the offered power without a battery model) |
| **Unplug** | Cable out |
| Card id, IdToken type (2.x) + **Present card** | Present a card. During a transaction the same card stops it (**Present card (stop)**) |
| **EV pauses / full**, **EV resumes** | The EV stops drawing power (SuspendedEV) and starts again |
| Fault + **Raise fault**, **Clear fault** | Raise one of the persona's faults on the connector, or clear it |

On a 2.1 station, depending on the persona's features:

| Control | Feature | Effect |
| --- | --- | --- |
| Card brand + **Pay by card**, **Stop payment** | Payment | A bank card at the EVSE's payment terminal, and the driver stopping at the terminal |
| **Priority on**, **Priority off** | (always on 2.1) | The driver's priority charging button |
| **Payment URL** | WebPayments | The URL a dynamic QR code would show, with its expiry |
| **Display** | (when there is something to show) | What the station's screen would show: tariff text, running cost, total cost |

Below the connectors, a 2.x station shows its **transaction events** (time, EVSE, transaction id, seqNo, eventType, triggerReason, chargingState, stoppedReason) and the **Device Model browser**: variables grouped by component, a filter, each variable's value, mutability and characteristics. A ReadWrite variable can be changed there as a local operator would.

The **message log** at the bottom lists every frame in and out, with a short summary, its version badge, and marks for schema problems, CALLERRORs and injected or dropped frames. Click a row to see its JSON. **Export JSONL** downloads the log in ocpp-mimic's log format.

### Sessions view

The **Sessions** tab lists the station's charging sessions, newest first: number, start source (Card, Remote start, No authorization, Payment), energy or the reason it failed, EVSE, token and time. The address `#/stations/<id>/sessions/<n>` links straight to a session.

A session shows:

- **Header**: the start source, token and its type, remoteStartId (2.x), transaction id, start and duration, why a start failed, the stop reason, transaction limits and payment settlement (2.1). Below it, the **start timeline**: each frame from the first request until the transaction ran, with the time each step took. Click a step to open the frame and its answer.
- **Energy panel**: delivered energy, power and SoC as reported, charging and suspended time, the time to the target as a third party would estimate it from the reported values, per-phase current and voltage, and the chart of reported and offered power and SoC. For a finished session: the total, peak power, SoC range and stop reason.
- **Vehicle card**: twelve facts about the car (battery capacity, SoC, target, departure time, maximum power, phases, ...), each with what the station reported, what can only be estimated, and what the OCPP version cannot carry at all.
- **Price card**: the CSMS's cost (2.0.1 and 2.1 send one; 1.6 has no cost messages), the station's own cost (2.1 with tariffs), and the **reference price** ocpp-mimic computes from the reported values with your tariff, with each item naming the frames it used. It says whether the costs match to the cent. **Edit the reference tariff** changes it: a fixed fee, a price per kWh with an optional off-peak price and its hours, a price per charging minute and per idle minute, a minimum and maximum cost, and one tax rate.
- **Session log**: the session's frames, each CALL with its answer and response time, filterable by action, direction, errors only, and log lines. Picking a meter value row marks its moment on the chart, and clicking the chart selects the nearest row. **Export JSONL** downloads the session's frames.

**CSMS view / Show truth.** By default the panels show only what a CSMS could know from the frames. **Show truth** adds the EV model's real values beside them: the exact SoC, energy, power and time until full. An estimate that is off by more than 5 minutes or 10 % is highlighted.

**Remote start.** When the station is connected to the built-in CSMS, the Sessions tab has a remote start form (EVSE, token and type): the built-in CSMS sends RemoteStartTransaction (1.6) or RequestStartTransaction (2.x). With any other CSMS, a remote start has to come from that CSMS.

## 4. Personas and EV profiles

### Personas that come with ocpp-mimic

Built in (`packages/engine/personas/`):

| Persona | Version | Description |
| --- | --- | --- |
| `generic-1.6` | 1.6 | One AC connector offering 7.36 kW, every feature profile, spec-default behaviour, three EV profiles |
| `generic-2.0.1` | 2.0.1 | One EVSE offering 7.36 kW, the covered 2.0.1 profiles, the same EV profiles |
| `generic-2.1` | 2.1 | `generic-2.0.1` as a 2.1 station; availability reported with NotifyEvent |

Samples in `scenarios/personas/` (load them with `--personas scenarios/personas`):

| Persona | Use |
| --- | --- |
| `regression-1.6`, `regression-2.0.1`, `regression-2.1` | Short delays for the regression scenarios |
| `load-ac-1.6`, `load-ac-2.0.1`, `load-ac-2.1` | Load tests: two connectors, 60 s heartbeat and meter interval; the 2.1 one prices with tariffs |
| `core-only-1.6`, `core-only-2.0.1` | Only the Core profile, to see how a CSMS copes without the others |
| `firmware-fails-1.6`, `firmware-fails-2.0.1`, `firmware-bad-signature-2.0.1` | Firmware updates that fail, or an image with a bad signature |
| `regression-iso15118-2.0.1`, `iso15118-20-2.1` | EVs that report charging needs (ISO 15118-2, ISO 15118-20) |
| `tariffs-2.1`, `payments-2.1` | 2.1 tariffs and local cost; payment terminal and web payments |
| `statusnotification-2.1` | A 2.1 station that reports availability with StatusNotification |

### Writing a persona

A persona is a YAML file whose name matches its `persona` id. Usually you extend a built-in one and list only the differences; `extends` merges objects key by key and replaces lists and single values.

```yaml
persona: vendorx-ac7 # made-up example
extends: generic-1.6
description: VendorX AC-7, firmware 2.5
boot:
  chargePointVendor: VendorX
  chargePointModel: AC-7
  firmwareVersion: "2.5.0"
connectors: 2
power: { offeredW: 11000 }
features: [Core, RemoteTrigger, SmartCharging]
config:
  HeartbeatInterval: 60
  MeterValueSampleInterval: 300
timing:
  startTransactionDelay: 2s
  commandDelays: { RemoteStopTransaction: 800ms }
  resetDowntime: { soft: 30s, hard: 3m }
evs:
  compact-40kwh: { capacityKWh: 40, initialSoc: 20, maxPowerW: 7400, phases: 1 }
faults:
  - { name: Ground fault, errorCode: GroundFailure, info: GND_FAULT, vendorErrorCode: E101 }
```

Put your personas in a directory and pass it with `--personas <dir>` to `serve`, `run`, `load` or `replay` (repeat it for more directories). Durations are milliseconds as a number, or a string ending in `ms`, `s`, `m` or `h`.

Fields every persona can have:

| Field | Meaning |
| --- | --- |
| `persona` | The id, up to 64 characters (required) |
| `ocpp` | `"1.6"` (default), `"2.0.1"` or `"2.1"` |
| `extends` | The persona this one builds on |
| `description` | Free text, shown in the Web UI |
| `boot` | BootNotification fields (required). 1.6: `chargePointVendor`, `chargePointModel`, `firmwareVersion`, ...; 2.x: the chargingStation block, `vendorName`, `model`, `serialNumber`, `firmwareVersion` |
| `connectors` | Number of connectors (1.6) or EVSEs with one connector each (2.x) (required) |
| `power` | `offeredW`: what each connector offers (default 7360); `evW`: what an EV draws when allowed (default: everything offered) |
| `features` | 1.6: feature profiles (Core, FirmwareManagement, RemoteTrigger, LocalAuthListManagement, Reservation, SmartCharging). 2.x: Core, AdvancedSecurity, LocalAuthListManagement, SmartCharging, Reservation, and on 2.1 also TariffAndCost, Payment, WebPayments. A message of a profile the station does not advertise gets NotSupported |
| `config` | 1.6: configuration key defaults |
| `deviceModel` | 2.x: Device Model values, component → variable → value (or an object with `actual`, `mutability`, `dataType`, `unit`, `valuesList`, ... for a variable of your own) |
| `connectorStatus` | 2.1: `NotifyEvent` (default) or `StatusNotification`, how connector availability is reported |
| `timing` | `startTransactionDelay`, `actionDelay`, `resetDowntime: { soft, hard }`, `bootRetry`, and `commandDelays` per CSMS command (how long the station takes to answer) |
| `firmware` | `downloadTime`, `installTime`, `uploadTime`; `download`, `install`, `upload`, `signature`: `succeed` or `fail`; `transfer: simulated` (default) or `real` (really download and upload over HTTP(S)) |
| `evs` | Named EV profiles (below) |
| `usage` | The usage model for stations that charge on their own (see [Fleets](#9-fleets-load-tests-and-metrics)) |
| `faults` | The fault catalogue offered in the Web UI: `name`, `errorCode`, `info`, `vendorErrorCode` |

### EV profiles

| Field | Meaning |
| --- | --- |
| `capacityKWh` | Battery capacity (required) |
| `initialSoc` | SoC in % when plugged in (required) |
| `maxPowerW` | The most the EV draws (required) |
| `phases` | 1 or 3 (required) |
| `taperSoc` | SoC where the power starts to fall (default 80) |
| `targetSoc` | SoC where the EV stops (default 100) |
| `communication` | `basic` (reports no SoC), `dc`, `iso15118` (2.x: sends NotifyEVChargingNeeds) or `iso15118-20` (2.1: the ISO 15118-20 needs and Display values). Without it, SoC is reported when the SoC measurand is configured |
| `departureMinutes` | ISO 15118: departure time, in minutes after plugging in |
| `controlMode` | ISO 15118-20: `ScheduledControl` (default) or `DynamicControl` |
| `minimumSoc` | ISO 15118-20: the minimum SoC the driver needs |

The API and scenarios also take an EV profile inline instead of a name.

## 5. The built-in CSMS

ocpp-mimic contains a small CSMS for testing the simulator itself and for trying things without a real back end. It accepts every station on `/ocpp/<id>`, takes the first subprotocol the station offers (1.6, 2.0.1 or 2.1), and answers every request: BootNotification Accepted, Authorize and transactions Accepted except for idTags starting with `UNKNOWN-`, and the 2.x and 2.1 notifications. It is a test tool, without authentication on its control API.

It runs in two ways:

- **Inside a scenario**: `csms: builtin`, the default. The CSMS steps `csmsCall` and `csmsReply` then let the scenario send commands and script answers.
- **As its own process**: `ocpp-mimic csms`, for the Web UI or a load test.

```bash
ocpp-mimic csms --port 9100 --delay 20ms-100ms
```

| Option | Meaning |
| --- | --- |
| `--port`, `--host` | Where to listen (default 127.0.0.1:9100) |
| `--delay <d>[-<d>]` | Answer every request after this time, or a random time in the range |
| `--heartbeat-interval <s>` | Interval given in BootNotification answers (default 60) |
| `--unknown-prefix <s>` | idTags starting with it are Invalid (default `UNKNOWN-`; empty accepts all) |
| `--password <p>` | Basic Auth password every station must present |
| `--tls-cert`, `--tls-key`, `--tls-ca`, `--client-certificates none\|optional\|required` | Serve `wss://`, optionally asking for client certificates |
| `--status <d>` | Print a status line this often (default 60s; 0 never). Ctrl-C prints a summary by action |
| `--tariff <file>` | Price 2.0.1 sessions with this tariff: totalCost in TransactionEvent answers, CostUpdated every minute |
| `--install-tariff` | Also send that tariff to 2.1 stations as their default tariff after each accepted boot |
| `--api-token <token>` | Require `Authorization: Bearer <token>` on the control API (default: `OCPP_MIMIC_API_TOKEN`) |

It keeps no frames, so its memory stays flat over long runs.

### Control API

The CSMS process serves a small HTTP API on its WebSocket port. Scenarios reach it as `{{csmsApiUrl}}`. With `--api-token`, every request but `GET /api/health` needs `Authorization: Bearer <token>`.

| Request | Effect |
| --- | --- |
| `GET /api/health` | `{ "service": "ocpp-mimic-csms", "protocols": [...] }` |
| `POST /api/stations/<id>/remote-start` | `{ "evseId": 1, "idToken": { "idToken": "TAG-001", "type": "Central" } }`: RemoteStartTransaction or RequestStartTransaction; answers with the station's answer |
| `POST /api/stations/<id>/call` | `{ "action": "Reset", "payload": { "type": "Soft" } }`: any CSMS command of the station's version |
| `POST /api/stations/<id>/default-tariff` | 2.1: SetDefaultTariff with the reference tariff or `tariff`, on `evseId` (default 0, every EVSE) |
| `POST /api/stations/<id>/transaction-limit` | 2.1: `{ "transactionLimit": { "maxEnergy": 5000 }, "transactionId": "..." }`, sent with the next TransactionEvent answer |
| `POST /api/stations/<id>/driver-tariff` | 2.1: `{ "tariff": {...} }` to send with Authorize answers; `null` removes it |
| `POST /api/stations/<id>/web-payment` | 2.1: `{ "url": "..." }`, the payment page behind a QR code: checks the TOTP code, queues the URL's limits and sends NotifyWebPaymentStarted |

For example, from the shell:

```bash
curl -s -X POST http://127.0.0.1:9100/api/stations/SIM-001/call \
  -H 'content-type: application/json' \
  -d '{"action":"TriggerMessage","payload":{"requestedMessage":"Heartbeat"}}'
```

The engine notices when a station's CSMS is the built-in one (it asks `GET /api/health` on CSMS addresses on this machine), so the Web UI's remote start and `POST /api/stations/<id>/remote-start` on the engine go through it. For any other CSMS they answer 409.

### The reference tariff

`--tariff` and the Web UI's price card use the same tariff format, an OCPP 2.1 TariffType as JSON. `scenarios/load/tariff.json` is an example:

```json
{
  "tariffId": "reference",
  "currency": "NZD",
  "fixedFee": { "prices": [{ "priceFixed": 1.0 }] },
  "energy": { "prices": [{ "priceKwh": 0.35 }], "taxRates": [{ "type": "GST", "tax": 15 }] },
  "chargingTime": { "prices": [{ "priceMinute": 0.02 }] },
  "idleTime": { "prices": [{ "priceMinute": 0.5 }] },
  "minCost": { "exclTax": 2.0 },
  "maxCost": { "exclTax": 80.0 }
}
```

Energy may have several prices with time-of-day, weekday or date conditions before a last price without conditions, for off-peak rates. The other parts take one price each. The built-in CSMS evaluates times in UTC; the reference price uses the station's time zone (`ClockCtrlr.TimeZone` on 2.x, UTC otherwise).

## 6. Scenarios

A scenario is a YAML test: stations, steps that act like a driver, the network or the CSMS, and expectations about the frames and the stations' state. `ocpp-mimic run` runs each scenario on a fresh embedded engine and reports the result, so CI needs nothing else running.

```yaml
name: Card session with periodic meter values
station:
  id: SIM-001
  persona: generic-1.6
  config: { MeterValueSampleInterval: 10 }
vars:
  TAG: TAG-001
steps:
  - presentCard: { connector: 1, idTag: "{{TAG}}", result: authorized }
  - plugIn: { connector: 1 }
  - expect: { sent: StartTransaction, payload: { connectorId: 1, idTag: "{{TAG}}" } }
  - expectConnector: { connector: 1, status: Charging }
  - expect: { sent: MeterValues, within: 15s }
  - presentCard: { connector: 1, idTag: "{{TAG}}", result: stopping }
  - expect: { sent: StopTransaction, payload: { reason: Local } }
  - unplug: { connector: 1 }
  - expectConnector: { connector: 1, status: Available }
```

### Running scenarios

```bash
ocpp-mimic run scenarios/examples
ocpp-mimic run my-tests/ --csms ws://127.0.0.1:8081 --var APP=http://127.0.0.1:3000 --junit report.xml
```

`run` takes files and directories (searched for `.yaml` and `.yml`). A file can hold several scenarios separated by `---`.

| Option | Meaning |
| --- | --- |
| `--csms <url>` | Run every scenario against this CSMS instead of its own `csms` |
| `--var NAME=value` | A template variable; repeat for more |
| `--timeout <d>` | Timeout for scenarios without their own (default 5m) |
| `--bail` | Stop after the first scenario that does not pass |
| `--junit <file>` | Also write a JUnit XML report: a test suite per file, a test case per scenario |
| `--log-dir <dir>` | Write each scenario's frames as JSONL logs |
| `--personas <dir>`, `--allow-csms <prefix>` | As for `serve` |

Each scenario prints PASS, FAIL (a step failed; the rest are skipped) or ERROR (an invalid file, a timeout, an engine failure), with the failing step's expected and actual values. The exit code is 0 when every scenario passed, 1 when any failed, and 2 for usage errors and files that do not validate. Every frame is checked against the Open Charge Alliance's JSON schemas; a violation fails the scenario unless it sets `checkSchemas: false`.

Example scenarios are in `scenarios/examples/`; `scenarios/regression/` is the suite CI runs against the built-in CSMS, and `scenarios/citrineos/` and `scenarios/steve/` run against those CSMSs.

### Scenario fields

| Field | Meaning |
| --- | --- |
| `name` | Test case name (required) |
| `description` | Free text for reports |
| `csms` | `builtin` (default) or a WebSocket URL; the station id is appended |
| `station` or `stations` | One station or a list. Fields: `id`, `persona`, and optionally `password`, `config` (1.6), `deviceModel` (2.x), `behaviour`, `energyMultiplier`, `security`, `waitForBoot` (default true: wait until BootNotification is Accepted) |
| `vars` | Default values for templates |
| `csmsOptions` | Built-in CSMS only: `tls` (`true` or `{ clientCertificates: ... }`) and `passwords` (station id → password) |
| `timeout` | Limit for the whole scenario (default 5 minutes) |
| `checkSchemas` | Default true |

### Steps

Each step is a map with one step key. Steps that act on a station take `station` (default: the first), connector steps take `connector` (default 1), or `evse` on 2.x stations. Any step can carry a `name` that reports show.

Station actions:

| Step | Arguments | Effect |
| --- | --- | --- |
| `plugIn` | `connector`, `ev` | Cable in, with an EV profile by name or inline |
| `unplug` | `connector` | Cable out |
| `presentCard` | `connector`, `idTag` / `idToken`, `type`, `result` | A card; `result` optionally asserts `authorized`, `rejected`, `stopping` or `busy` |
| `presentPaymentCard` | `connector`, `brand`, `recognition`, `decline`, `settlement`, `declineIncrement`, ..., `result` | 2.1: a bank card at the payment terminal, and how its payment provider answers |
| `stopPayment` | `connector`, `result` | 2.1: the driver stops at the terminal |
| `changeEvNeeds` | `connector`, `targetSoc`, `departureMinutes`, `minimumSoc`, `result` | 2.x: the EV's needs change |
| `validateVat` | `vatNumber`, `evse`, `result` | 2.1: a VAT number for the CSMS to check |
| `evSuspend`, `evResume` | `connector` | The EV pauses or resumes |
| `fault`, `clearFault` | `connector` (0: the whole station), `errorCode`, `info`, `vendorErrorCode` | Raise or clear a fault |
| `offline` | `mode`: `clean` or `half-open` | Simulated outage |
| `online` | | End the outage |
| `stopStation`, `startStation` | | Disconnect or reconnect |
| `setBehaviour` | `refuseRemoteStart`, `cableLock` | Test switches |
| `inject`, `clearInjections` | `type`, parameters, `for` | Fault injection |
| `wait` | a duration | Pause |
| `charge` | `connector`, `duration` | Wait, and fail unless a transaction runs at the start and the end |

A step the engine refuses (unplugging a locked cable, say) fails the scenario. With `expectError: <text>` the step instead requires a refusal containing that text.

Expectations:

| Step | Passes when |
| --- | --- |
| `expect: { sent \| received: <action>, payload, answer, within, from }` | A matching CALL is recorded in time. `sent` is station → CSMS, `received` CSMS → station. `answer` matches the CALLRESULT |
| `expectNo: { sent \| received, payload, within }` | No matching CALL during `within` |
| `expectConnector: { connector, status, ..., within }` | The connector's state matches (status, errorCode, plugged, locked, transactionId, chargingState on 2.x, ...) |
| `expectStation: { registration, transport, ..., within }` | The station's state matches |

`within` defaults to 10 s. It counts only time the computer is awake, as timeouts do, so a laptop that sleeps during a wait does not fail the step. `expect` steps search after the message the previous `expect` matched, so consecutive ones also check the order; `from: step` looks only at messages after the step began and `from: start` at the whole scenario.

Built-in CSMS steps:

| Step | Effect |
| --- | --- |
| `csmsCall: { action, payload, answer \| error \| noAnswer }` | The CSMS sends a command and checks the answer, an expected CALLERROR code, or that no answer comes within `noAnswer` |
| `csmsReply: { action, payload \| error \| ignore, times }` | How the CSMS answers the station's next `times` calls of `action` (default: all) |

`http` calls the system under test, for example your app's API that starts a session:

```yaml
- http:
    method: POST
    url: "{{APP}}/charges/start"
    json: { station: SIM-001 }
    expect: { status: 201, json: { state: pending } }
    save: { CHARGE: $.json.id }
```

It takes `method`, `url`, `headers`, `basicAuth`, `json`, `expect` (`status`, `json`), `within` (retry every 250 ms until it matches) and `save`.

### Matching, variables and templates

- `payload`, `answer`, the state steps and `http` `expect.json` match **partially**: fields you give must be present and equal; others are ignored. Arrays match element by element. Operators: `$exists`, `$regex`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, and for arrays `$contains` and `$size`.
- `save: { NAME: <path> }` keeps a value for later steps, on `expect` (`$.payload...`, `$.answer...`), `expectConnector`, `expectStation`, `csmsCall` (`$.answer...`) and `http` (`$.status`, `$.json...`, `$.text`).
- `{{NAME}}` is replaced from `vars`, then `--var`, then saved values. `{{env.NAME}}` reads an environment variable and is shown as `***` in reports. A string that is only a template keeps the value's type.
- Built-in variables: `{{csmsUrl}}`, `{{engineUrl}}` (the embedded engine's API), `{{csmsApiUrl}}` (the built-in CSMS's control API), `{{now}}`, `{{now+30m}}`, `{{now-1h}}`.

### Testing your own CSMS

1. Write scenarios with `csms:` set to your CSMS, or keep `builtin` and pass `--csms` when running.
2. Allow the address: `--allow-csms ws://my-csms.test:8180/`.
3. Make the CSMS know the stations and cards the scenarios use, for example with `http` steps against its API at the start of the scenario.
4. Run with `--junit` in CI.

CSMS steps (`csmsCall`, `csmsReply`) need the built-in CSMS; against your CSMS, trigger its commands through its own API with `http` and then `expect` the CALL at the station. `scenarios/citrineos/` is a complete example of this against CitrineOS (`tools/citrineos/docker-compose.yml` starts it).

## 7. OCPP versions and features

### OCPP 1.6J

Every feature profile: Core, Firmware Management, Local Auth List Management, Reservation, Smart Charging and Remote Trigger, plus the Security Whitepaper (security profiles 1 to 3, certificates, signed firmware, security events and logs). The design's "OCPP 1.6J coverage" lists each message.

### OCPP 2.0.1

The station has EVSEs with connectors, a Device Model with the standard controller components, and transactions through TransactionEvent. Covered: provisioning (boot, reports, variables, network profiles, reset), authorization (local list, cache), availability, transactions with configurable start and stop points, remote control, meter values, smart charging, reservations, firmware, logs, security profiles and certificates, and ISO 15118 charging needs from the EV. Display messages, monitoring, external charging limits, ISO 15118 certificates and local controllers are out of scope and answered NotSupported. Variables a CSMS sets with SetVariables change behaviour the way ChangeConfiguration does in 1.6; you can set them in a persona's or station's `deviceModel`, in the Web UI's Device Model browser, or with `PATCH /api/stations/<id>/device-model`.

### OCPP 2.1

A 2.1 station keeps all of 2.0.1 and adds:

| Feature | How to use it |
| --- | --- |
| **Tariffs and the station's own cost** | Feature `TariffAndCost`. The CSMS sets default tariffs (SetDefaultTariff) or driver tariffs (in Authorize answers); the station prices the session itself and reports costDetails, running costs and the final cost. `ocpp-mimic csms --tariff <file> --install-tariff` sends a default tariff to every 2.1 station. Persona: `tariffs-2.1` |
| **Transaction limits** | maxEnergy, maxTime, maxSoC, maxCost in a TransactionEvent answer (`transaction-limit` in the CSMS control API). The station echoes them and suspends or stops when one is reached |
| **Resuming after reset or power loss** | Set `TxCtrlr.ResumptionTimeout` above 0; Reset ImmediateAndResume and a `powerLoss` injection then resume transactions with TxResumed |
| **Payment terminal** | Feature `Payment`: **Pay by card** in the Web UI, `presentPaymentCard` in scenarios. The terminal reserves an amount, the transaction gets maxCost, and the terminal settles at the end (NotifySettlement). Cards can be declined, and settlements can fail. Persona: `payments-2.1` |
| **Web payments (dynamic QR code)** | Feature `WebPayments`: **Payment URL** shows the URL with its TOTP code; the CSMS control API's `web-payment` plays the payment page |
| **Priority charging** | **Priority on / off** in the Web UI (the driver's button) or UsePriorityCharging from the CSMS |
| **Dynamic charging profiles** | Profiles of kind Dynamic, updated by UpdateDynamicSchedule or pulled with PullDynamicScheduleUpdate |
| **ISO 15118-20 vehicle data** | EV profile with `communication: iso15118-20`: NotifyEVChargingNeeds with the 2.1 fields, and Display.\* measurands in meter values and the vehicle card. Persona: `iso15118-20-2.1` |
| **Virtual display** | The station keeps what its screen would show (tariff text, running and total cost); the Web UI shows it and scenarios can check `display` |
| **Connector availability** | Reported with NotifyEvent by default; `connectorStatus: StatusNotification` in the persona for CSMSs that expect the older message |

Not simulated: bidirectional charging (V2X), DER control, battery swap, Plug & Charge certificates and local controllers. The design's "OCPP 2.1 coverage" lists every block.

## 8. Fault injection

Faults make a station misbehave on purpose, to see how the CSMS copes. Start one from the Web UI's **Inject** row, the API (`POST /api/stations/<id>/injections` with `{ "type": ..., parameters, "for": "1m" }`), or a scenario step (`inject: { type: latency, ms: 2000, for: 1m }`). `for` ends an injection after a time; counted ones end when used up.

| Type | Parameters | Effect |
| --- | --- | --- |
| `latency` | `ms`, `direction` (sent, received, both) | Delay frames |
| `drop` | `direction`, `count` or `probability`, `action` | Lose frames |
| `flap` | `down`, `up`, `times` | The connection drops and comes back |
| `reconnectStorm` | | Every station of the engine reconnects at once |
| `malformedJson` | `count` | Send broken JSON |
| `duplicateId` | `count` | Reuse a message id |
| `unknownId` | `count` | Answer with an id the CSMS never sent |
| `outOfOrder` | | Swap the next two frames sent |
| `noAnswer` | `action` | Ignore the CSMS's calls of an action |
| `callError` | `action`, `errorCode` (default InternalError) | Answer them with a CALLERROR |
| `schemaViolation` | `action`, `count` | An extra property in the next call of an action |
| `meterRollback` | `wh`, `connector` | The energy register goes back |
| `meterReset` | `connector` | The energy register goes to zero |
| `clockDrift` | `ms` (negative: behind) | Shift every timestamp |
| `badTimestamp` | `count` | Send malformed timestamps |
| `powerLoss` | `off`, `on`, `times` | The station goes dark for `off`, then boots from its saved state; transactions end with PowerLoss (or resume on 2.1, see above) |

Injected frames are marked in the message log and left out of the schema check. Faults of the persona's catalogue (StatusNotification errorCode, info and vendorErrorCode) are raised with **Raise fault** or the `fault` step.

## 9. Fleets, load tests and metrics

### Many stations at once

`POST /api/stations/bulk` (or **How many** in the Add form) creates stations from a template:

```json
{
  "count": 100,
  "id": "SIM-{0001}",
  "persona": "load-ac-1.6",
  "csmsUrl": "ws://127.0.0.1:9100/ocpp",
  "group": "ac",
  "tags": ["north"],
  "usage": true,
  "rampUp": { "rate": 10, "jitter": 0.5 }
}
```

It creates all of them or none (409 when an id exists). `rampUp` starts `rate` stations a second (default 20); `false` starts them all at once. `POST /api/stations/bulk/start` (or `stop`, `offline`, `online`) and `DELETE /api/stations/bulk` act on a selection `{ ids, tag, group }`.

### Stations that charge on their own

The usage model makes stations charge without anyone clicking: drivers arrive at free connectors, present a card, plug in, stay, and leave. It is off by default. Turn it on in the persona (`usage`), the template or load plan group (`usage: true` or an object of overrides), or per station with `PATCH /api/stations/<id>/usage` `{ "enabled": true }`.

```yaml
usage:
  sessionsPerHour: 1 # per free connector, random arrivals
  stay: { min: 20m, max: 2h }
  evs: { compact-40kwh: 3, sedan-75kwh: 1 } # weights over the persona's evs
  idTags: { prefix: LOAD-, count: 500, unknownShare: 0.05, unknownPrefix: UNKNOWN- }
  cardFirst: 0.3 # share of drivers who present the card before plugging in
  stopBy: { card: 0.7, unplug: 0.3 }
  steps: { min: 5s, max: 30s }
```

| Field | Meaning |
| --- | --- |
| `sessionsPerHour` | Average arrivals per free connector and hour (random arrivals) |
| `stay` | How long the driver stays, uniform in the range |
| `evs` | Weights for picking among the persona's EV profiles |
| `idTags` | Card prefix and count, and the share and prefix of unknown cards |
| `cardFirst` | Share of drivers who present the card before plugging in |
| `stopBy` | Share who end with the card, and who just unplug |
| `steps` | Waits between card and plug, and before unplugging |

Each station's random choices come from the run's `seed` and its id, so a run repeats when the CSMS answers the same way.

### Load tests

`ocpp-mimic load <plan.yaml>` runs a fleet for a time, applies timed events and judges thresholds. The CSMS can be your own (with `--allow-csms`) or `ocpp-mimic csms` in another terminal:

```bash
ocpp-mimic csms --port 9102 --delay 20ms-100ms
ocpp-mimic load scenarios/load/smoke-100.yaml --personas scenarios/personas --report-dir reports/load
```

A plan (see `scenarios/load/example.yaml`):

```yaml
name: Two groups for an hour, with a reconnect storm
csms: ws://127.0.0.1:9100/ocpp
seed: 1
duration: 60m
rampUp: { rate: 10, jitter: 0.5 }
groups:
  - name: ac
    count: 900
    id: LOAD-AC-{0001}
    persona: load-ac-1.6
    tags: [ac]
  - name: busy
    count: 100
    id: LOAD-BUSY-{0001}
    persona: load-ac-2.0.1
    usage: { sessionsPerHour: 4, stay: { min: 5m, max: 20m } }
events:
  - { at: 30m, reconnectStorm: {} }
  - at: 45m
    inject: { type: powerLoss, off: 30s }
    stations: { share: 0.05, group: ac }
thresholds:
  bootAcceptedWithin: 60s
  recoverWithin: 120s
  unexpectedDisconnects: 0
  lateWork: { p99: 1s, max: 5s }
  csmsLatency: { p95: 1s }
  timeouts: 0
  callErrors: 0
  schemaViolations: 0
  eventLoopDelay: { p99: 100ms }
  memory: { rss: 2GB, heapGrowth: 10% }
  sessions: { min: 0.8 }
```

Groups can mix OCPP versions; 2.x groups take `deviceModel` as 1.6 groups take `config`. Write groups in block form as above: the braces of the id's counter break a one-line `{ ... }` map. While it runs, `load` prints a progress line every 10 s. At the end it prints each threshold with its measured value and exits with 1 if any failed.

| Threshold | Meaning |
| --- | --- |
| `bootAcceptedWithin` | Every station's BootNotification is Accepted this long after the ramp-up |
| `recoverWithin` | Every station is back online this long after each fleet event |
| `unexpectedDisconnects` | Disconnects other than the injected ones |
| `lateWork` | How late scheduled work runs (heartbeats, meter samples, usage events, retries) |
| `csmsLatency` | CSMS answer times, per action and overall |
| `timeouts`, `callErrors`, `schemaViolations` | Timeouts, CALLERRORs and schema violations, either side |
| `eventLoopDelay` | The engine's event-loop delay |
| `memory` | The engine's RSS, and heap growth at the end over the floor after the warm-up |
| `sessions` | The share of the expected sessions that ran, at least |

| Option | Meaning |
| --- | --- |
| `--csms`, `--duration` | Override the plan's CSMS and duration |
| `--report-dir <dir>` | Write `report.json` and `report.md` |
| `--junit <file>` | A test case per threshold |
| `--port <n>` | Also serve the API, the Web UI and `/metrics`, to watch the run |
| `--log-dir <dir>` | Write every frame to `<dir>/frames.jsonl` |
| `--record-limit <n>` | Records kept per station for the Web UI (default 10) |
| `--api-token <token>` | Require it on the API served with `--port` (default: `OCPP_MIMIC_API_TOKEN`) |
| `--otlp-endpoint`, `--otlp-header` | Push metrics over OTLP |

`scenarios/load/m4-exit.yaml` (1,000 1.6 stations for an hour) and `m7-exit-21.yaml` (the same with 2.1 stations and tariffs) are the plans the project's acceptance runs use.

### Benchmark

`pnpm bench` measures the engine itself: N stations in one process against `ocpp-mimic csms` in a child process, sampled every 5 s (event-loop delay, CPU, memory, frames a second, late heartbeats and meter values).

```bash
pnpm bench --stations 1000 --duration 10m --rate 10 --out bench-results/run
```

Options: `--stations`, `--duration`, `--rate`, `--persona` (default `load-ac-1.6`), `--charging` (share of stations charging), `--csms-delay`, `--tariff`, `--sample`, `--store`, `--out`, `--heap-snapshot`.

### Metrics

`serve` and `load --port` serve Prometheus metrics at `GET /metrics`, and the same numbers as JSON at `GET /api/metrics`. Labels are `action`, `persona` and `group` (plus `direction`, `outcome`, `code` or `ocpp` where they apply), never the station, so 1,000 stations cost no more series than one.

| Metric | What it counts |
| --- | --- |
| `ocpp_mimic_stations`, `ocpp_mimic_connectors` | Stations by connection state, connectors by status |
| `ocpp_mimic_csms_response_seconds` | How long the CSMS takes to answer, per action |
| `ocpp_mimic_csms_answers_total` | Answers by outcome: result, error, timeout |
| `ocpp_mimic_calls_received_total` | Commands from the CSMS |
| `ocpp_mimic_callerrors_total`, `ocpp_mimic_schema_violations_total` | Errors, by direction and action |
| `ocpp_mimic_frames_total`, `ocpp_mimic_frame_bytes_total` | Traffic, by direction and OCPP version |
| `ocpp_mimic_connections_total`, `ocpp_mimic_disconnects_total` | Connections opened and failed; disconnects by cause |
| `ocpp_mimic_transactions_total` | Transactions started, stopped and refused |
| `ocpp_mimic_sessions_turned_away_total` | Usage-model arrivals that found no free connector |
| `ocpp_mimic_energy_wh_total` | Energy delivered |
| `ocpp_mimic_offline_queue_messages` | Messages waiting while offline |
| `ocpp_mimic_work_lateness_seconds`, `ocpp_mimic_eventloop_delay_seconds` | How late scheduled work runs; engine event-loop delay |

To push the same metrics to an OpenTelemetry collector, give `--otlp-endpoint <url>` (and `--otlp-header k=v`), or set the standard `OTEL_EXPORTER_OTLP_ENDPOINT` and related variables.

## 10. Logs: export, import, replay and calibration

### The log format

ocpp-mimic's log is JSON Lines: an optional header `{"format":"ocpp-mimic-log","version":1,"masked":false}`, then one frame per line:

```json
{"at":"2026-11-15T09:00:00.000Z","station":"SIM-001","ocpp":"1.6","direction":"cp-to-csms","frame":[2,"19223201","BootNotification",{"chargePointVendor":"VendorX","chargePointModel":"AC-7"}]}
```

Get one from the Web UI (**Export JSONL** in the message log or a session's log), from `GET /api/stations/<id>/messages?format=jsonl` or `GET /api/stations/<id>/sessions/<n>/frames?format=jsonl`, or with `run --log-dir` and `load --log-dir`. `scenarios/logs/` has small synthetic samples.

### Importing other logs, with masking

`ocpp-mimic import` turns logs from a CSMS or a charge point into this format. A mapping file says where the time, station, direction and frame are, for JSONL (field paths), CSV (columns) or plain log lines (a regular expression with named groups):

```bash
ocpp-mimic import csms-export.csv --map scenarios/import/csv-mapping.yaml --salt-file salt.txt -o masked.jsonl
```

Masking is on for mapped input (`--mask` / `--no-mask` change it). It replaces station ids, idTags, serial numbers, ICCID and IMSI with stable pseudonyms (the same value gets the same pseudonym under one salt, so sessions still line up) and removes DataTransfer data, passwords, AuthorizationKey values, certificates and CSRs. Error info and vendor error codes are kept. Without `--salt` / `--salt-file` / `OCPP_MIMIC_MASK_SALT`, a random salt is used, so two imports cannot be linked.

Keep real logs out of the repository: mask them and store them where your own data belongs.

### Replay

`ocpp-mimic replay <log>` sends a station's recorded frames to a CSMS again, in order, and compares the CSMS's answers with the recorded ones. Timestamps move to the present, message ids are fresh, and transaction ids, remoteStartIds and tariff ids map to the ones the CSMS assigns.

```bash
ocpp-mimic replay scenarios/logs/local-card-session.yaml-1.jsonl --speed 10
ocpp-mimic replay incident.jsonl --station SIM-0042 --csms ws://127.0.0.1:8081 --compare strict
```

| Option | Meaning |
| --- | --- |
| `--station <id>` | The station to replay, when the log has several |
| `--csms <url>` | The CSMS (default: the built-in one) |
| `--persona <id>` | Persona of the replaying station (default `generic-<the log's version>`) |
| `--speed <n>`, `--max-gap <d>` | Divide the recorded gaps by n; cap each wait (default 30s) |
| `--compare status \| strict \| none` | `status` (default) compares results, error codes and status fields; `strict` whole payloads except volatile fields |
| `--write <file>` | Write the replay as a scenario, frames inline, to edit and run with `run` |

### Calibration

`ocpp-mimic calibrate <log>...` derives a persona from logs of stations of one model: boot fields, connectors, configuration or Device Model values, intervals, measurands, offered power, timing, faults, EV profiles and the usage model. Each value comes with its sample count; values with fewer than 3 samples are reported as not derived.

```bash
ocpp-mimic calibrate masked.jsonl --name vendorx-ac7 -o vendorx-ac7.yaml --report calibration.md
```

Options: `--station` (repeatable), `--name`, `--extends` (default `generic-<the logs' version>`), `-o`, `--report`.

## 11. Security profiles and the test PKI

Stations take `security: { profile, ca, cert, key }` in the API, templates and scenarios:

| Profile | Connection |
| --- | --- |
| 0 | `ws://`, no authentication |
| 1 | Basic Auth with the station's password, over `ws://` or `wss://` |
| 2 | `wss://` with the server certificate checked against `ca`, plus Basic Auth |
| 3 | `wss://` with the client certificate `cert` and `key` |

A CSMS that changes the password (1.6 AuthorizationKey, 2.x BasicAuthPassword) or raises the security profile makes the station reconnect with the new settings, and fall back if that fails. Certificate management (SignCertificate, CertificateSigned, installing CA certificates) works on both versions.

`packages/engine/test-pki/` holds a fixed test CA with server and client certificates, for tests only (see its README; `generate.sh` makes a new set). In scenarios, `test-pki:<file>` names one of its files. To run the built-in CSMS with TLS:

```bash
ocpp-mimic csms --tls-cert packages/engine/test-pki/server.crt --tls-key packages/engine/test-pki/server.key \
  --tls-ca packages/engine/test-pki/ca.crt --client-certificates optional
```

## 12. Engine HTTP API

`serve` listens on `http://127.0.0.1:7300` by default (`--port`, `--host`). Requests and answers are JSON. Errors answer `{ "error": "..." }` with 400 (bad input), 401 (the [API token](#listening-beyond-this-machine-the-api-token) is missing or wrong), 404 (unknown station or connector), 409 (not possible in the current state) or 405. With a token, send `Authorization: Bearer <token>` on every request but `GET /api/health`.

General:

| Request | Meaning |
| --- | --- |
| `GET /api/health` | Engine version and the subprotocols it speaks |
| `GET /api/metrics` | Metrics as JSON; `GET /metrics` in Prometheus format |
| `GET /api/personas` | Personas with their version and features |
| `GET /api/tariff`, `PUT /api/tariff` | The reference tariff |

Stations:

| Request | Meaning |
| --- | --- |
| `GET /api/stations` | All stations; filter with `?tag=`, `?group=`, `?state=`; `?view=summary` for a short form |
| `POST /api/stations` | Create one: `id`, `persona`, `csmsUrl`, and optionally `password`, `config`, `deviceModel`, `security`, `energyMultiplier`, `tags`, `group`, `usage`, `seed`, `start` (default true) |
| `POST /api/stations/bulk` | Create many from a template (see [Fleets](#9-fleets-load-tests-and-metrics)) |
| `POST /api/stations/bulk/{start,stop,offline,online}`, `DELETE /api/stations/bulk` | Act on `{ ids, tag, group }` |
| `GET`, `DELETE /api/stations/<id>` | One station's state; delete it |
| `POST /api/stations/<id>/{start,stop,online}` | Start, stop, end an outage |
| `POST /api/stations/<id>/offline` | `{ "mode": "clean" \| "half-open" }` |
| `PATCH /api/stations/<id>/behaviour` | `{ "refuseRemoteStart": true, "cableLock": false }` |
| `PATCH /api/stations/<id>/energy-multiplier` | `{ "energyMultiplier": 60 }` |
| `PATCH /api/stations/<id>/usage` | `{ "enabled": true }` |
| `GET`, `POST`, `DELETE /api/stations/<id>/injections` | Fault injections |
| `POST /api/stations/<id>/security-events` | `{ "type": ..., "techInfo": ... }`: report a security event |
| `GET`, `PATCH /api/stations/<id>/device-model` | 2.x: list variables; set one with `{ component, variable, value }` |
| `POST /api/stations/<id>/remote-start` | Through the built-in CSMS: `{ evseId, idToken: { idToken, type } }` |
| `POST /api/stations/<id>/vat-number` | 2.1: `{ vatNumber, evseId }` |

Connectors (`<n>` is the connector, or the EVSE on 2.x):

| Request | Body |
| --- | --- |
| `POST .../connectors/<n>/plug` | `{ "ev": "compact-40kwh" }` (a name or an inline profile; optional) |
| `POST .../connectors/<n>/unplug` | |
| `POST .../connectors/<n>/id-tag` | `{ "idTag": "TAG-001", "type": "ISO14443" }` (type on 2.x) |
| `POST .../connectors/<n>/ev-suspend`, `ev-resume` | |
| `POST`, `DELETE .../connectors/<n>/fault` | `{ errorCode, info, vendorErrorCode }` |
| `POST .../connectors/<n>/ev-needs` | 2.x: `{ targetSoc, departureMinutes, minimumSoc }` |
| `POST .../connectors/<n>/priority` | 2.1: `{ "activate": true }` |
| `POST .../connectors/<n>/payment` | 2.1: `{ brand, recognition, decline, settlement, declineIncrement, ... }` |
| `POST .../connectors/<n>/payment/stop` | 2.1 |
| `GET .../connectors/<n>/payment-url` | 2.1: `?maxenergy=&maxtime=&maxcost=` |

Records and sessions:

| Request | Meaning |
| --- | --- |
| `GET /api/stations/<id>/messages` | The station's frames and log lines; `?limit=`, `?action=`, `?kind=`, `?format=jsonl` |
| `GET /api/stations/<id>/sessions` | Session summaries, newest first |
| `GET /api/stations/<id>/sessions/<n>` | One session with its estimate and reference price |
| `GET /api/stations/<id>/sessions/<n>/frames` | Its frames; `?format=jsonl` |

Live updates come over the WebSocket `/api/events`: send `{ "type": "subscribe", "stations": ["SIM-001"] }` to get those stations' records, snapshots and session summaries; every client gets fleet summaries. With a token, send it as the `Authorization` header, or, from a browser, offer the subprotocols `ocpp-mimic` and `ocpp-mimic.token.<the token in base64url>`.

A short walk through with curl:

```bash
API=http://127.0.0.1:7300/api
curl -s -X POST $API/stations -H 'content-type: application/json' \
  -d '{"id":"SIM-100","persona":"generic-2.0.1","csmsUrl":"ws://127.0.0.1:9100/ocpp"}'
curl -s -X POST $API/stations/SIM-100/connectors/1/plug -H 'content-type: application/json' -d '{"ev":"compact-40kwh"}'
curl -s -X POST $API/stations/SIM-100/connectors/1/id-tag -H 'content-type: application/json' -d '{"idTag":"TAG-001"}'
curl -s $API/stations/SIM-100/sessions
```

## 13. Command reference

| Command | Purpose |
| --- | --- |
| `ocpp-mimic serve` | The engine, its API and the Web UI |
| `ocpp-mimic run <file\|dir>...` | Run scenarios |
| `ocpp-mimic csms` | The built-in CSMS on its own |
| `ocpp-mimic load <plan>` | A load test |
| `ocpp-mimic import <file>...` | Convert and mask logs |
| `ocpp-mimic replay <log>` | Replay a log against a CSMS |
| `ocpp-mimic calibrate <log>...` | Derive a persona from logs |
| `ocpp-mimic samples <dir>` | Copy the samples into a directory to edit |

Options of `serve`:

| Option | Meaning |
| --- | --- |
| `--port`, `--host` | Where to listen (default 127.0.0.1:7300) |
| `--store <file>` | SQLite file that keeps stations across restarts |
| `--record-limit <n>` | Frames and log lines kept per station for the UI and API (default 1000; 0 keeps none) |
| `--sessions-per-station <n>` | Sessions kept per station, with their frames (default 20) |
| `--personas <dir>` | Extra persona directory; repeatable |
| `--allow-csms <prefix>` | Allow CSMS URLs starting with it; repeatable |
| `--otlp-endpoint`, `--otlp-header` | Push metrics over OTLP |
| `--api-token <token>` | Require it on the API, `/metrics` and the Web UI (default: `OCPP_MIMIC_API_TOKEN`) |
| `--csms-api-token <token>` | The built-in CSMS's control API token, for remote starts (default: `OCPP_MIMIC_CSMS_API_TOKEN`) |

`ocpp-mimic --help` prints every option of every command.

## 14. Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| `SyntaxError: ... does not provide an export named 'parseArgs'` or other start-up errors | Node is too old. Use Node 24 (`fnm use`) |
| `CSMS address ... is not allowed` | Add `--allow-csms <prefix>` for that CSMS |
| `unknown persona ...` | Pass the persona's directory with `--personas` (the samples need `--personas scenarios/personas`) |
| A station stays Connecting | The CSMS is not listening at that URL, or it refused the subprotocol or the password. The message log and the engine's output say which |
| BootNotification Pending or Rejected | The CSMS does not know the station. Register its id in the CSMS, or use the built-in CSMS |
| Cards are Invalid | The CSMS does not know the idTag. The built-in CSMS rejects only ids starting with `UNKNOWN-` |
| Requests answer 401 | The engine or the CSMS has an API token. Send `Authorization: Bearer <token>`; in the Web UI, enter the token when it asks |
| Remote start answers 502 with "answered 401" | The built-in CSMS has an API token and the engine does not know it. Start the engine with `--csms-api-token` or `OCPP_MIMIC_CSMS_API_TOKEN` |
| Remote start answers 409 | The station's CSMS is not the built-in one. Start the session from your CSMS |
| `EADDRINUSE` | Another process uses the port. Pick another with `--port` |
| Charging takes too long to watch | Set the station's energy multiplier, e.g. 60 |
| Scenario fails with a schema violation | A frame broke the official JSON schema. Look at the frame in the report; set `checkSchemas: false` only if the test is about invalid frames |
| A scenario takes about 15 minutes, and its line says `host asleep` | The computer slept while the scenario waited; the time is part of the duration but not of any `within`. Keep it awake for long runs: `caffeinate -i ocpp-mimic run ...` on macOS, `systemd-inhibit ocpp-mimic run ...` on Linux |
| CitrineOS scenarios cannot connect | Start it with `docker compose -f tools/citrineos/docker-compose.yml up -d` and wait until the server is healthy; see `scenarios/citrineos/README.md` |

Questions and bug reports go to the repository's GitHub issues.
