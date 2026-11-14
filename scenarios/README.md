# Scenarios

Scenario files for `ocpp-mimic run`, in the format described under
"Scenario format v1" in [docs/design.md](../docs/design.md).

- `examples/`: reference examples. All but `app-triggered-start.yaml` run
  against the built-in CSMS; that one is a template for testing your own CSMS
  and app backend.
- `regression/`: the regression suite, run against the built-in CSMS. It uses
  the personas in `personas/` (`--personas scenarios/personas`).
- `personas/`: personas for the regression suite, such as `regression-1.6`
  (generic-1.6 with short reset downtimes).

Run the regression suite (as CI does) with `pnpm test:scenarios`, or after
`pnpm build`:

```bash
node packages/cli/dist/main.js run scenarios/regression --personas scenarios/personas
```
