# ocpp-mimic

OCPP 充电桩模拟器：一个无头引擎同时运行多个虚拟充电桩，连接被测的 CSMS。设计方案见 [docs/design.md](docs/design.md)。

> 当前状态：monorepo 骨架，还没有实现 OCPP 功能。

## 环境要求

- Node.js 24（见 `.nvmrc`，用 fnm 或 nvm 切换）
- pnpm 12（见 `package.json` 的 `packageManager` 字段）

## 常用命令

| 命令             | 作用                                                   |
| ---------------- | ------------------------------------------------------ |
| `pnpm install`   | 安装依赖                                               |
| `pnpm build`     | 构建所有包和 Web UI                                    |
| `pnpm typecheck` | 类型检查，包括测试文件和 Vue 组件                      |
| `pnpm test`      | 运行单元测试（直接跑源码，不需要先构建）               |
| `pnpm lint`      | ESLint 检查                                            |
| `pnpm format`    | Prettier 格式化                                        |
| `pnpm serve`     | 构建并启动 Engine，默认地址 `http://127.0.0.1:7300`    |
| `pnpm dev:web`   | 启动 Web UI 开发服务器，`/api` 请求代理到本机的 Engine |

## 目录结构

| 目录              | 内容                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`   | 协议、状态机、persona 解释器。纯逻辑、无 IO：tsconfig 不加载 Node 和 DOM 类型，用到定时器、网络或文件就编译不过；时间通过 `Clock` 注入 |
| `packages/engine` | 运行时：HTTP / WebSocket API、虚拟桩调度、持久化                                                                                       |
| `packages/cli`    | 命令行 `ocpp-mimic`：启动 Engine，以后还会运行场景                                                                                     |
| `apps/web`        | Vue 3 Web UI，只调用 Engine API，不含模拟逻辑                                                                                          |
| `docs`            | 设计文档                                                                                                                               |
