# SteVe for local testing

[SteVe](https://github.com/steve-community/steve) is an open-source OCPP 1.6 CSMS. ocpp-mimic uses it as a second, independent CSMS for manual testing and for M1 acceptance, so the simulator is not only ever tuned against one CSMS. Automated tests use the in-repo mini CSMS (`packages/engine/src/testing/mini-csms.ts`) instead.

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
- SteVe only accepts registered charge points: add the chargeBoxId under **Data Management → Charge Points** first.
- To start a charging session from SteVe, also add an OCPP tag under **Data Management → OCPP Tags** and use **Operations → OCPP v1.6 → Remote Start Transaction**.
