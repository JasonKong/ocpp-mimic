# SteVe for local testing

[SteVe](https://github.com/steve-community/steve) is an open-source OCPP 1.6 CSMS. ocpp-mimic uses it as a second, independent CSMS for manual testing and for M1 acceptance, so the simulator is not only ever tuned against one CSMS. Automated tests and the regression suite use the built-in test CSMS (`packages/engine/src/csms/builtin-csms.ts`) instead; the manual **SteVe** workflow (`.github/workflows/steve.yml`) runs the charge-point scenarios against SteVe.

## Start and stop

Requires Docker. From the repository root:

```bash
docker compose -f tools/steve/docker-compose.yml up -d
```

The first start builds the image from SteVe's `steve-3.14.1` tag and compiles SteVe with Maven inside the container, which takes a few minutes. Follow it with:

```bash
docker compose -f tools/steve/docker-compose.yml logs -f steve
```

Stop it (add `-v` to also delete the database):

```bash
docker compose -f tools/steve/docker-compose.yml down
```

## Use it

- Web UI: <http://localhost:8180/steve/manager>, user `admin`, password `1234` (SteVe's defaults).
- OCPP 1.6J endpoint for a charge point with id `CP-1`: `ws://localhost:8180/steve/websocket/CentralSystemService/CP-1`.
- SteVe only accepts registered charge points: add the chargeBoxId under **Data Management → Charge Points** first, or run `tools/steve/register.sh --charge-points CP-1 --tags TAG-1` (inserts into SteVe's database; existing entries are kept).
- To start a charging session from SteVe, also add an OCPP tag under **Data Management → OCPP Tags** and use **Operations → OCPP v1.6 → Remote Start Transaction**.

## Run the regression scenarios against SteVe

```bash
tools/steve/register.sh --charge-points REG-CP-BOOT REG-CP-CARD REG-CP-UNPLUG REG-CP-FAULT REG-CP-OUTAGE REG-CP-HALFOPEN REG-CP-LOCK REG-CP-EV --tags TAG-REG
node packages/cli/dist/main.js run scenarios/regression/charge-point.yaml --personas scenarios/personas --csms ws://localhost:8180/steve/websocket/CentralSystemService
```

Only `charge-point.yaml` runs against SteVe; `csms-commands.yaml` needs the built-in CSMS to send commands.
