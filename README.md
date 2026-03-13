# dobby

Discord-first 本地 Agent Gateway。宿主只负责 CLI、网关主流程、扩展加载和计划任务调度；Provider / Connector / Sandbox 通过扩展 contribution 接入。

当前仓库内维护的扩展包：

- `@dobby.ai/connector-discord`
- `@dobby.ai/connector-feishu`
- `@dobby.ai/provider-pi`
- `@dobby.ai/provider-codex-cli`
- `@dobby.ai/provider-claude-cli`
- `@dobby.ai/provider-claude`
- `@dobby.ai/sandbox-core`

文档默认以 `@dobby.ai/*` 为准，不再把旧 `@dobby/*` 作为推荐配置。

## 核心能力

- connector source -> binding -> route -> provider / sandbox
- Discord 频道 / 线程接入；线程消息继续按父频道命中 binding
- Feishu 长连接消息接入（self-built app）
- Feishu 出站支持普通文本和 Markdown 卡片；默认群内直发，不走 reply thread
- conversation 级 runtime 复用与串行化
- 扩展 store 安装、启用、列举与 schema 驱动配置
- Discord 流式回复、typing、附件下载与图片输入
- cron 调度：一次性、固定间隔、cron expression
- 交互式初始化：`dobby init`（支持多 provider / 多 connector starter）
- 配置检查与 schema inspect：`dobby config show|list|schema`
- 诊断与保守修复：`dobby doctor [--fix]`

## 架构概览

```text
Discord / Cron
    -> Connector
    -> Gateway
       -> Dedup / Control Commands / Binding Resolver / Route Resolver
       -> Runtime Registry
       -> Provider Runtime
       -> Sandbox Executor
    -> Event Forwarder
    -> Connector Reply
```

主要目录：

- `src/cli`：CLI 程序和各子命令
- `src/core`：gateway 主流程、路由、去重、runtime registry
- `src/extension`：扩展 store、manifest 解析、扩展加载与实例化
- `src/cron`：计划任务配置、持久化与调度
- `src/sandbox`：宿主执行器接口与 `HostExecutor`
- `plugins/*`：本地维护的扩展源码
- `config/*.example.json`：示例配置

注意：运行时只从 `<data.rootDir>/extensions/node_modules` 加载扩展，不会从 `plugins/*` 源码目录 fallback。

## 环境要求

- Node.js `>=20`
- npm
- 对应 provider / connector 的外部运行条件
  - 例如 Discord bot token
  - Codex CLI、Claude CLI 或 Claude Agent SDK 所需认证
  - 可选的 Docker / Boxlite 运行环境

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 构建

```bash
npm run build
```

3. 初始化模板配置

```bash
npm run start -- init
```

`init` 会做这些事情：

- 交互选择 provider 和 connector（均可多选）
- 自动安装所选扩展到运行时 extension store
- 写入一份带占位符的 `gateway.json` 模板
- 把 `routes.default.projectRoot` 设为当前工作目录
- 为 direct message 生成 `bindings.default`，回落到默认 route
- 为每个所选 connector 生成一个默认 binding 到同一条 route
- 生成 `gateway.json`
- `provider.pi` 默认写入最小 inline 配置，不再依赖 `models.custom.json`

说明：当前 `init` 内建这些 starter 选择：

- provider：`provider.pi`、`provider.claude-cli`
- connector：`connector.discord`、`connector.feishu`

4. 编辑 `gateway.json`

把 `REPLACE_WITH_*` / `YOUR_*` 占位值替换成你的真实配置，例如：

- `connectors.items[*]` 中的 token / appId / appSecret
- `bindings.items[*].source.id`
- `routes.items[*].projectRoot`（如需覆盖默认 project root）

5. 运行诊断

```bash
npm run start -- doctor
```

`doctor` 会同时检查：

- 配置结构 / 引用关系
- 缺失的扩展安装
- `REPLACE_WITH_*` / `YOUR_*` 这类 init 占位值是否还未替换

6. 启动网关

```bash
npm run start --
```

说明：

- `dobby` 无子命令时，默认等价于 `dobby start`
- `dobby --version` 可直接查看当前 CLI 版本
- 在仓库内直接运行时，CLI 会自动使用 `./config/gateway.json`
- 在仓库内执行 `init` / `extension install` 时，会优先安装 `plugins/*` 的本地构建产物
- 也可以通过环境变量覆盖配置路径：

```bash
DOBBY_CONFIG_PATH=./config/gateway.json npm run start --
```

## 配置文件路径

gateway 配置路径优先级：

1. `DOBBY_CONFIG_PATH`
2. 当前目录向上查找 dobby 仓库时的 `./config/gateway.json`
3. 默认 `~/.dobby/gateway.json`

cron 配置路径优先级：

1. `--cron-config`
2. `DOBBY_CRON_CONFIG_PATH`
3. 与 gateway 配置同目录的 `cron.json`
4. `<data.rootDir>/state/cron.config.json`

如果 cron 配置文件不存在，启动时会自动生成默认文件。

## 运行时目录

`data.rootDir` 默认是 `./data`。如果配置文件是仓库内的 `./config/gateway.json`，它会相对仓库根目录解析；否则相对配置文件所在目录解析。加载后会生成这些目录：

- `sessions/`
- `attachments/`
- `logs/`
- `state/`
- `extensions/`

扩展 store 实际路径是：

```text
<data.rootDir>/extensions/node_modules/*
```

## CLI 概览

顶层命令：

```bash
dobby --version
dobby start
dobby init
dobby doctor [--fix]
```

配置检查：

```bash
dobby config show [section] [--json]
dobby config list [section] [--json]
dobby config schema list [--json]
dobby config schema show <contributionId> [--json]
```

配置变更建议直接编辑 `gateway.json`，再通过 `dobby doctor` 或 `dobby start` 做校验。

扩展管理：

```bash
dobby extension install <packageSpec>
dobby extension install <packageSpec> --enable
dobby extension uninstall <packageName>
dobby extension list [--json]
```

计划任务：

```bash
dobby cron add <name> --prompt <text> --connector <id> --route <id> --channel <id> [--thread <id>] [--at <iso> | --every-ms <ms> | --cron <expr>] [--tz <tz>]
dobby cron list [--json]
dobby cron status [jobId] [--json]
dobby cron run <jobId>
dobby cron update <jobId> ...
dobby cron pause <jobId>
dobby cron resume <jobId>
dobby cron remove <jobId>
```

## Release 流程

仓库现在内置了两条 GitHub Actions：

- `.github/workflows/ci.yml`
  - 在 PR / push 到 `main` 时执行 `npm ci`、`npm run plugins:install`、`npm run check`、`npm run build`、`npm run test:cli`、`npm run plugins:check`、`npm run plugins:build`
- `.github/workflows/release.yml`
  - 在 push 到 `main` 时运行 Release Please
  - 有 releasable commit 时自动维护 release PR
  - release PR 合并后自动发布对应 npm 包，并为每个包生成独立 GitHub release / tag

推荐的日常流程：

1. 正常提交功能改动到 PR（建议继续使用 Conventional Commits 风格，例如 `feat(...)` / `fix(...)`）
2. 合并到 `main`
3. 等待 Release Please 自动更新或创建 release PR
4. review 并合并 release PR
5. 合并后由 `release.yml` 自动执行 npm trusted publishing

注意：

- 首次启用前，需要在 npm 后台为每个 `@dobby.ai/*` 包配置 GitHub trusted publisher，指向当前仓库和 `.github/workflows/release.yml`
- 建议在 GitHub 仓库里创建 `npm-publish` environment，后续若需要人工审批可以直接加保护规则
- 进入自动发版流程后，后续版本号应由 Release Please 维护，不再手动执行 `npm version`
- 本地手动兜底发布仍然保留，可用：

```bash
node scripts/publish-packages.mjs --package plugins/provider-codex-cli --skip-existing
node scripts/publish-packages.mjs --package . --tag next
```

## Gateway 配置模型

顶层结构：

- `extensions`
- `providers`
- `connectors`
- `sandboxes`
- `routes`
- `bindings`
- `data`

关键语义：

- `extensions.allowList`
  - 只声明启用状态，不负责安装
- `providers.default`
  - 默认 provider instance ID
- `providers.items[*].type` / `connectors.items[*].type` / `sandboxes.items[*].type`
  - 指向某个 contribution，实例配置直接内联在对象里
- `routes.default`
  - 统一提供 route 默认的 `projectRoot`、`provider`、`sandbox`、`tools`、`mentions`
- `routes.items[*]`
  - route 是可复用的执行 profile，可继承默认 `projectRoot`，并按需覆盖 `provider`、`sandbox`、`tools`、`mentions`、`systemPromptFile`
- `bindings.default`
  - direct message 未命中显式 binding 时使用的默认 route fallback
- `bindings.items[*]`
  - `(connector, source.type, source.id) -> route` 的入口绑定
- `sandboxes.default`
  - 未指定时默认使用 `host.builtin`
- 未匹配 binding 的入站消息会被直接忽略；仅 direct message 可回落到 `bindings.default`

示例配置：

- gateway：[`config/gateway.example.json`](config/gateway.example.json)
- cron：[`config/cron.example.json`](config/cron.example.json)

`provider.pi` 现在使用 inline custom provider 配置。最小常用字段是：

- `model`
- `baseUrl`
- `apiKey`

这些字段默认自动补齐：

- `provider = "custom-openai"`
- `api = "openai-completions"`
- `authHeader = false`
- `thinkingLevel = "off"`
- `models = [{ id: model }]`

只有在你需要多模型元数据或覆盖能力参数时，才需要手工展开 `models`。

`apiKey` 支持直接写 literal，也支持写环境变量名，由 `pi` 的 `AuthStorage` / `ModelRegistry` 按上游规则解析。

## 扩展包与 contribution

仓库内现有 contribution：

- `connector.discord`
- `provider.pi`
- `provider.codex-cli`
- `provider.claude-cli`
- `provider.claude`
- `sandbox.boxlite`
- `sandbox.docker`

`dobby init` 当前只内建这些 starter 选择：

- provider：`provider.pi`、`provider.claude-cli`
- connector：`connector.discord`、`connector.feishu`

`provider.codex-cli`、`provider.claude` 与 sandbox 相关扩展需要手工安装和配置，例如：

```bash
npm run start -- extension install @dobby.ai/provider-codex-cli --enable
npm run start -- extension install @dobby.ai/provider-claude --enable
npm run start -- extension install @dobby.ai/sandbox-core --enable
```

若使用 `provider.codex-cli`，启动前建议检查：

```bash
codex --version
codex login status
```

最小配置字段：

- `command`（默认 `codex`）
- `commandArgs`（默认 `[]`）
- `model`（可选；未设置时沿用 Codex CLI 当前 profile / `~/.codex/config.toml` 的默认模型）
- `profile`（可选；等价于 `codex -p <profile>`）
- `approvalPolicy`（可选；默认 `never`）
- `sandboxMode`（可选；不填时按 route 的 `tools` 推导：`readonly -> read-only`，`full -> workspace-write`）
- `configOverrides`（可选；字符串数组，按原样转成重复的 `codex -c key=value`）
- `skipGitRepoCheck`（默认 `false`）

例如希望网关里的 Codex 会话复用本机 profile，并显式打开无人值守执行：

```json
{
  "type": "provider.codex-cli",
  "command": "codex",
  "profile": "background",
  "approvalPolicy": "never",
  "sandboxMode": "danger-full-access",
  "configOverrides": [
    "model_reasoning_effort = \"xhigh\""
  ]
}
```

注意：`provider.codex-cli` 当前是 host-only，`danger-full-access` 会直接作用在宿主机上。

`--enable` 的行为：

- 把包写入 `extensions.allowList`
- 按 manifest contribution 生成默认实例模板
- 在需要时补默认 provider

## 计划任务 / Cron

job 支持三种调度方式：

- `--at <ISO timestamp>`
- `--every-ms <ms>`
- `--cron "<expr>" [--tz <timezone>]`

示例：

```bash
npm run start -- cron add daily-report \
  --prompt "Summarize open issues in this repo" \
  --connector discord.main \
  --route projectA \
  --channel 1234567890 \
  --cron "0 9 * * 1-5" \
  --tz "Asia/Shanghai"
```

说明：

- `cron run <jobId>` 会额外排队一次立即执行，不会恢复 paused 状态，也不会改写原有 `nextRunAtMs`
- 需要已有一个正在运行的 `dobby start`
- 当前 scheduled run 一律按 stateless / ephemeral 执行

## Discord 连接器的当前行为

- guild channel 仍按显式 binding 匹配
- DM 可通过 `bindings.default` 回落到默认 route
- 线程消息使用父频道 ID 做 binding 查找
- 会自动下载附件到本地
- 图片会作为 image input 传给 provider
- 非图片附件会把路径注入 prompt
- 内置 reconnect watchdog
  - `reconnectStaleMs` 默认 `60000`
  - `reconnectCheckIntervalMs` 默认 `10000`

## 会话控制命令

在 Discord 频道内可用：

- `stop`
- `/stop`
- `/cancel`
- `/new`
- `/reset`

当前语义：

- `stop` / `/cancel`：取消该会话当前和排队中的任务
- `/new` / `/reset`：重置当前会话，并在 provider 支持时归档旧 session

## 本地插件开发

开发流程：

```bash
npm run plugins:install
npm run plugins:check
npm run plugins:build
npm run extensions:install:local
```

或一步完成：

```bash
npm run plugins:setup:local
```

补充说明：

- `plugins/*` 是扩展源码，不是运行时加载入口
- 本地扩展安装到 extension store 后，才会被宿主识别
- `@dobby.ai/plugin-sdk` 在插件里按 `peerDependencies` 暴露，开发期通过 `file:../plugin-sdk` 提供

## 检查与测试

最小校验：

```bash
npm run check
npm run build
npm run test:cli
```

如果改了插件代码，建议再执行：

```bash
npm run plugins:check
npm run plugins:build
```

当前测试现状：

- 已有 CLI / core 的 focused tests
- 暂无完整的 e2e 自动化
- 仍建议做一次手工 Discord 冒烟

## 本地运行小提示

- `npm run dev:local` 与 `npm run start:local` 会尝试读取 `.env`
- 普通 `npm run start -- ...` 不会自动载入 `.env`
- `dobby init` 生成的是模板配置；运行前先替换 `gateway.json` 中的 placeholder

## 相关文档

- 扩展系统：[`docs/EXTENSION_SYSTEM_ARCHITECTURE.md`](docs/EXTENSION_SYSTEM_ARCHITECTURE.md)
- cron 设计：[`docs/CRON_SCHEDULER_DESIGN.md`](docs/CRON_SCHEDULER_DESIGN.md)
- 运行与排障：[`docs/RUNBOOK.md`](docs/RUNBOOK.md)
- Teamwork handoff：[`docs/TEAMWORK_HANDOFF_DESIGN.md`](docs/TEAMWORK_HANDOFF_DESIGN.md)
