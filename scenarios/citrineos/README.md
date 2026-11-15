# Scenarios against CitrineOS

OCPP 2.0.1 scenarios with CitrineOS v2.1.0 as the CSMS
(`tools/citrineos/docker-compose.yml`). ocpp-mimic plays the charging
station, so each scenario follows the Part 6 test case for a CSMS
(`TC_…_CSMS`) named at the start of its name. Commands come from CitrineOS
through its REST API: an `http` step gets a local-dev token from
`POST /dev/token`, then calls `POST /ocpp/2.0.1/<module>/<action>?identifier=<station>&tenantId=1`.
That answer only says the CALL was sent; the scenario then expects the CALL at
the station and checks the station's answer.

Run them locally:

```bash
docker compose -f tools/citrineos/docker-compose.yml up -d
pnpm build
node packages/cli/dist/main.js run scenarios/citrineos --personas scenarios/personas
```

With other ports, pass `--csms ws://localhost:<ws port>` and
`--var CITRINE=http://localhost:<http port>`. CI runs them in
`.github/workflows/citrineos.yml`.

## Known CitrineOS deviations

None found so far. When a scenario has to work around CitrineOS behaviour
that differs from OCPP 2.0.1, it is listed here with the scenario and how it
copes; nothing is reported upstream without asking first.
