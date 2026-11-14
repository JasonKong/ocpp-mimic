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

## REST API

SteVe 3.14.1 offers a REST API under `http://localhost:8180/steve/api/v1`, including `POST /operations/<Action>` for every command a CSMS sends (RemoteStartTransaction, Reset, SetChargingProfile, …). It takes `chargeBoxIdList` plus the command's parameters and answers once the charge point has replied, with `successResponses`, `errorResponses` and `exceptions`.

The API uses HTTP Basic with the admin user and its API password. `docker-compose.yml` sets that password to the test-only value `ocpp-mimic-test-api-secret` (`WEBAPI_VALUE`), but SteVe only applies it when it creates the admin user on the first start. A database created before this setting keeps an admin without API access; recreate it with `docker compose -f tools/steve/docker-compose.yml down -v` (this deletes SteVe's data).

Scenarios call the API with `http` steps and `basicAuth: { user: admin, password: "{{env.STEVE_API_SECRET}}" }`; see `scenarios/steve/`.

## Run the regression scenarios against SteVe

```bash
tools/steve/register.sh --charge-points $(grep -h -o 'id: REG-[A-Z]*-[A-Z]*' scenarios/regression/charge-point.yaml scenarios/steve/*.yaml | sed 's/id: //' | sort -u) --tags TAG-REG
STEVE_API_SECRET=ocpp-mimic-test-api-secret node packages/cli/dist/main.js run scenarios/regression/charge-point.yaml scenarios/steve --personas scenarios/personas --csms ws://localhost:8180/steve/websocket/CentralSystemService
```

`regression/charge-point.yaml` needs no CSMS commands; `scenarios/steve/` sends SteVe's commands through its REST API and is the SteVe counterpart of `regression/csms-commands.yaml`, which only the built-in CSMS can run. The SteVe workflow (`.github/workflows/steve.yml`) runs both.
