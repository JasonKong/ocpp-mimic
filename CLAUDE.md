# ocpp-mimic: notes for development sessions

ocpp-mimic is an OCPP charge point simulator. Read [docs/design.md](docs/design.md) first: it is the source of truth for the design. The open issues in the current milestone are the task list.

## Environment

- **Node 24** (`.nvmrc`). Run `fnm use` in the repo root first. The machine's default shell Node can be much older and cannot run this toolchain.
- **pnpm 12** (the `packageManager` field in `package.json`). `pnpm-workspace.yaml` sets `minimumReleaseAge` to 7 days, so installs only pick versions that have been public for a week. If a fresh release is needed, wait or pin an older version; do not remove the setting.
- **TypeScript is pinned to `~6.0`.** typescript-eslint requires `<6.1`, and vue-tsc needs the TypeScript JS API, which TypeScript 7 (the native port) does not ship. Check both before upgrading.

## Commands

| Command               | What it does                                                   |
| --------------------- | -------------------------------------------------------------- |
| `pnpm install`        | Install dependencies                                           |
| `pnpm build`          | `tsc -b` for the packages, then the Web UI build               |
| `pnpm typecheck`      | Packages, test files (`tsconfig.test.json`) and Vue components |
| `pnpm test`           | Vitest over `packages/*/src/**/*.test.ts`, against sources     |
| `pnpm test:scenarios` | Build, then run `scenarios/regression` with the CLI            |
| `pnpm lint`           | ESLint                                                         |
| `pnpm format`         | Prettier (`docs/` is excluded on purpose)                      |
| `pnpm serve`          | Build and start the engine on `http://127.0.0.1:7300`          |
| `pnpm dev:web`        | Vite dev server; `/api` is proxied to the engine               |

CI runs lint, format check, typecheck, test and build, and in a second job the regression scenarios. Run the same before pushing.

## Layout and rules

- `packages/core` is **pure logic**. Its tsconfig has `types: []` and only the ES2023 lib, so Node and DOM APIs do not compile there. Time comes in through the `Clock` interface; tests use `ManualClock`, never real timers or sleeps. core has no runtime dependencies; keep it that way unless the design says otherwise.
- `packages/engine` owns all IO: sockets, HTTP, files, SQLite, the real clock.
- `packages/cli` stays thin: argument parsing, then calls into the engine.
- `apps/web` is an API client only; no OCPP logic in the UI.
- Packages import each other by name (`@ocpp-mimic/core`). `tsc -b` builds them in dependency order through project references; Vitest aliases the names to sources, so tests need no build.
- ESM everywhere; relative imports carry the `.js` extension (`NodeNext` resolution).
- Tests live next to the code as `*.test.ts`.

## Language

- Talk to the user in **Chinese**.
- Everything written to the repo or GitHub is **English**: code, comments, commit messages, PR titles and descriptions, issues, docs.
- `docs/design.zh-CN.md` is a Chinese translation kept for reference. Change `docs/design.md` first.

## Workflow

1. One issue, one branch, one PR. Branch names look like `t3-device-model`.
2. Before pushing, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm test:scenarios` must all pass.
3. The PR description has a summary and a verification section and ends with `Closes #<issue>`.
4. Squash-merge once CI is green.
5. A change to the design updates `docs/design.md` in the same PR.
6. Commits use the repo-local git identity (a GitHub noreply address). Do not change it and never commit with a work email.

## OCPP notes

- OCPP 1.6J is the baseline. The "OCPP 1.6J coverage" section of `docs/design.md` lists the M1 behaviour of every message.
- Persona examples use made-up values. Do not copy code, logs or data from other projects into this repository.
