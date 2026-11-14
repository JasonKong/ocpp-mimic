# Sample logs

Synthetic logs in ocpp-mimic's log format (JSONL), recorded from the repository's own scenarios against the built-in CSMS with `ocpp-mimic run --log-dir`. They contain no data from real charge points or CSMSs. Tests and examples for import, replay and calibration use them.

| File                              | Recorded from                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `local-card-session.yaml-1.jsonl` | `scenarios/examples/local-card-session.yaml`: a card session with meter values                 |
| `usage.yaml-1.jsonl`              | `scenarios/regression/usage.yaml`, first scenario: usage-model sessions that end with the card |
| `usage.yaml-2.jsonl`              | `scenarios/regression/usage.yaml`, second scenario: a session that ends by unplugging          |

Record them again with:

```bash
node packages/cli/dist/main.js run scenarios/examples/local-card-session.yaml scenarios/regression/usage.yaml --personas scenarios/personas --log-dir scenarios/logs
```
