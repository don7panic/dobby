# dobby

[![npm package](https://img.shields.io/badge/npm-%40dobby.ai%2Fdobby-CB3837?logo=npm)](https://www.npmjs.com/package/@dobby.ai/dobby)
[![npm version](https://img.shields.io/npm/v/@dobby.ai/dobby?logo=npm)](https://www.npmjs.com/package/@dobby.ai/dobby)

> Discord-first 本地 Agent Gateway，把聊天频道和 cron 任务变成你机器上 Agent 的统一入口。

`dobby` 让 Agent 继续跑在本机，直接使用本地仓库、凭据和工具链。你把一个频道或群聊绑定到一个项目目录，再按 route 选择 Provider、Sandbox 和工具权限；宿主本身保持轻量，只负责 CLI、路由、扩展加载、会话复用和调度。

## What is dobby

- 本地执行，不把代码仓库搬到远端中控。
- IM 入口统一成 `binding -> route -> runtime`，按频道切项目、切 Provider。
- Provider / Connector / Sandbox 都走扩展；当前仓库维护的包使用 `@dobby.ai/*`。
- 同一套链路同时支持聊天消息和 cron 计划任务。

## Quickstart

要求：Node.js `>=20`、npm，以及对应 Connector / Provider 的认证环境。

```bash
npm install -g @dobby.ai/dobby
dobby init
```

`init` 当前内建 starter：

- Provider: `provider.pi`、`provider.claude-cli`
- Connector: `connector.discord`、`connector.feishu`

然后编辑 `config/gateway.json`，至少替换这些占位值：

- `botToken` / Feishu 凭据
- 频道或群聊 ID
- route 的 `projectRoot`
- Provider 的模型、地址、认证信息

启动前先做一次诊断：

```bash
dobby doctor
dobby start
```

也可以显式指定配置路径：

```bash
DOBBY_CONFIG_PATH=./config/gateway.json dobby start
```

## What you can plug in

- Entrypoints: `connector.discord`、`connector.feishu`、cron
- Providers: `provider.pi`、`provider.codex-cli`、`provider.claude-cli`、`provider.claude`
- Sandboxes: `host.builtin`、`sandbox.boxlite`、`sandbox.docker`

`provider.codex-cli`、`provider.claude` 和 sandbox 扩展默认不在 `init` starter 里，需要手工安装 / 启用：

```bash
dobby extension install @dobby.ai/provider-codex-cli --enable
dobby extension install @dobby.ai/provider-claude --enable
dobby extension install @dobby.ai/sandbox-core --enable
```

## Docs

- 配置示例：[config/gateway.example.json](config/gateway.example.json)
- Cron 示例：[config/cron.example.json](config/cron.example.json)
- 运行与排障：[docs/RUNBOOK.md](docs/RUNBOOK.md)
- 架构与教程：[docs/tutorials/README.md](docs/tutorials/README.md)
- 扩展系统：[docs/EXTENSION_SYSTEM_ARCHITECTURE.md](docs/EXTENSION_SYSTEM_ARCHITECTURE.md)
- Cron 设计：[docs/CRON_SCHEDULER_DESIGN.md](docs/CRON_SCHEDULER_DESIGN.md)

## Development

最小校验：

```bash
npm run check && npm run build && npm run test:cli
```

如果你是在仓库里直接运行源码：

```bash
npm install
npm run build
npm run start -- init
```
