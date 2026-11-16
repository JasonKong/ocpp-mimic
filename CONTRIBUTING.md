# Contributing to ocpp-mimic

Thank you for helping. This page says how to build and test ocpp-mimic, how changes are made, and under which terms contributions are accepted.

## Build and test

You need Node.js 24 (see `.nvmrc`) and pnpm 12 (see `packageManager` in `package.json`).

```bash
pnpm install
pnpm build
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:scenarios
```

`pnpm serve` starts the engine with the Web UI on <http://127.0.0.1:7300>. The [user guide](docs/guide.md) explains how to use it, and the [design](docs/design.md) how it works.

## How changes are made

- Open an issue first for anything larger than a small fix, so the approach can be agreed before the work.
- One issue, one branch, one pull request. The pull request has a summary and a verification section.
- Everything written to the repository is in English: code, comments, commit messages, pull requests and documentation. `docs/design.zh-CN.md` and `docs/guide.zh-CN.md` are translations; change the English file first.
- A change to the design updates `docs/design.md`. A change users can see (CLI, engine API, Web UI, scenario format, personas, the built-in CSMS, load tests, logs) updates `docs/guide.md` and adds a line to `CHANGELOG.md`.
- `packages/core` stays pure logic without IO; `packages/engine` owns all IO; the CLI and the Web UI only call the engine. `CLAUDE.md` lists these rules in detail.
- Tests use synthetic data only. Do not add logs, identifiers or other data from real charging stations, CSMSs or other projects.
- CI must be green before a pull request is merged.

## Terms for contributions

ocpp-mimic is licensed under the Business Source License 1.1 ([LICENSE](LICENSE)), and its licensor also offers commercial licenses. So that every contribution can be released under both, by submitting a contribution you confirm that:

1. you wrote it, or otherwise have the right to submit it under these terms; and
2. you license it to the licensor and to everyone who receives ocpp-mimic under the Apache License, Version 2.0, which lets the licensor include it in versions released under the Business Source License, under commercial licenses, and under the Change License.

If you cannot agree to this, please open an issue describing the change instead of a pull request.
