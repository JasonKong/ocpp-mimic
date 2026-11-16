# Scenarios

Scenario files for `ocpp-mimic run`, in the format described under
"Scenario format v1" in [docs/design.md](../docs/design.md).

- `examples/`: reference examples; all of them run against the built-in CSMS.
- `templates/`: starting points for testing your own CSMS and app backend,
  such as `app-triggered-start.yaml`; they need a real system under test.
- `regression/`: the regression suite, run against the built-in CSMS. It uses
  the personas in `personas/` (`--personas scenarios/personas`).
- `steve/`: scenarios that need SteVe (see `tools/steve/README.md`): CSMS
  commands sent through SteVe's REST API with `http` steps. The SteVe
  workflow runs them.
- `personas/`: personas for the regression suite, such as `regression-1.6`
  (generic-1.6 with short reset downtimes).

Run the regression suite (as CI does) with `pnpm test:scenarios`, or after
`pnpm build`:

```bash
node packages/cli/dist/main.js run scenarios/regression --personas scenarios/personas
```
