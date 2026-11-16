# Sample logs

Synthetic logs in ocpp-mimic's log format (JSONL), recorded from the repository's own scenarios against the built-in CSMS with `ocpp-mimic run --log-dir`. They contain no data from real charge points or CSMSs. Tests and examples for import, replay and calibration use them. Lines recorded since M5 carry the station's OCPP version (`ocpp`); the older 1.6 logs have none, and readers tell it from the actions.

| File                              | Recorded from                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `local-card-session.yaml-1.jsonl` | `scenarios/examples/local-card-session.yaml`: a card session with meter values                                                      |
| `usage.yaml-1.jsonl`              | `scenarios/regression/usage.yaml`, first scenario: usage-model sessions that end with the card                                      |
| `usage.yaml-2.jsonl`              | `scenarios/regression/usage.yaml`, second scenario: a session that ends by unplugging                                               |
| `ocpp201-sessions.yaml-1.jsonl`   | `scenarios/examples/ocpp201-sessions.yaml`: an OCPP 2.0.1 card session, then a remote start and stop                                |
| `ocpp21-sessions.yaml-1.jsonl`    | `scenarios/examples/ocpp21-sessions.yaml`: an OCPP 2.1 card session with a CSMS limit, then a web payment the CSMS starts and stops |

Record them again with:

```bash
node packages/cli/dist/main.js run scenarios/examples/local-card-session.yaml scenarios/regression/usage.yaml scenarios/examples/ocpp201-sessions.yaml scenarios/examples/ocpp21-sessions.yaml --personas scenarios/personas --log-dir scenarios/logs
```
