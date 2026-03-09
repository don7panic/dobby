# AGENTS Guide (dobby)

本文件给在本仓库内工作的 AI / 自动化代理使用。目标是让文档、代码和配置改动都以当前实现为准，而不是沿用已经过时的假设。

## 1. 项目定位

- 项目名：`dobby`
- 形态：Discord-first 本地 Agent Gateway，宿主负责 CLI、网关主流程、扩展加载、计划任务调度
- 扩展模型：Provider / Connector / Sandbox 全部通过扩展 contribution 接入
- 运行时扩展目录固定：`<data.rootDir>/extensions`
- 启用模型：`extensions.allowList` 只声明“允许加载”，安装与卸载由 `dobby extension *` 管理
- 当前仓库内维护的扩展包 scope 是 `@dobby.ai/*`
- 代码事实优先级：
  - 第一优先级：`src/*`
  - 第二优先级：`config/gateway.example.json`、`config/cron.example.json`
  - 第三优先级：`docs/*`
  - 不要把仓库中的 `config/gateway.json` 当作通用示例，它可能包含本地机器路径、私有包名或敏感 token

## 2. 技术栈与常用命令

- Node.js `>=20`
- TypeScript + ESM（`module: NodeNext`，`strict: true`）
- 宿主核心依赖：`commander`、`pino`、`zod`、`ajv`、`@mariozechner/pi-ai`、`cron-parser`

仓库根目录常用命令：

```bash
npm install
npm run check
npm run build
npm run test:cli
npm run start --
npm run start -- doctor
DOBBY_CONFIG_PATH=./config/gateway.json npm run start --
```

本地开发辅助命令：

```bash
npm run dev
npm run dev:local
npm run start:local
```

插件开发命令（由 `scripts/local-extensions.mjs` 驱动）：

```bash
npm run plugins:install
npm run plugins:check
npm run plugins:build
npm run extensions:install:local
npm run extensions:list:local
npm run plugins:setup:local
```

注意：

- 普通运行路径不会自动读取 `.env`
- 只有 `npm run dev:local` 和 `npm run start:local` 使用 `--env-file-if-exists=.env`
- Discord connector 仍以显式 `botToken` 配置为主，不依赖 `botTokenEnv`

## 3. 代码结构与职责

- `src/main.ts`
  - CLI 入口，仅调用 `runCli`
- `src/cli/program.ts`
  - 注册全部顶层命令：`start`、`init`、`configure`、`config`、`bot`、`channel`、`route`、`extension`、`doctor`、`cron`
- `src/cli/commands/start.ts`
  - 启动网关、创建数据目录、加载扩展、实例化 provider / connector / sandbox、启动 cron 服务、接管优雅退出
- `src/cli/commands/init.ts`
  - 首次初始化向导；会先安装所需扩展，再根据扩展 `configSchema` 交互生成配置
- `src/cli/commands/config*.ts`
  - `config show|list|edit|schema *` 与 `configure`
- `src/cli/commands/topology.ts`
  - `bot/channel/route` 管理命令
- `src/cli/commands/extension.ts`
  - 运行时扩展 store 的安装、卸载、列举，以及 `--enable` 自动写入 allowList / 模板实例
- `src/cli/commands/cron.ts`
  - 计划任务 CRUD、状态查看、手动触发
- `src/core/gateway.ts`
  - 入站消息与计划任务的统一执行入口：去重、控制命令、路由解析、mention 策略、runtime 获取、事件转发、错误回写
- `src/core/runtime-registry.ts`
  - conversation 级 runtime 复用、串行队列、取消、reset、closeAll
- `src/core/control-command.ts`
  - 控制命令解析：`stop` / `/stop` / `/cancel` / `/new` / `/reset`
- `src/core/routing.ts`
  - `gateway.json` 的 zod 校验、相对路径归一化、legacy 字段拒绝、引用关系校验
- `src/core/dedup-store.ts`
  - 去重 TTL 持久化，文件位置：`data/state/dedup.json`
- `src/agent/event-forwarder.ts`
  - 统一处理流式增量、tool 事件、不同 connector `updateStrategy`
- `src/extension/manager.ts`
  - 初始化扩展 store、调用 npm 安装 / 卸载、列出已安装扩展
- `src/extension/loader.ts`
  - 只从 `<data.rootDir>/extensions/node_modules` 解析 allowList 包并加载 contribution
- `src/extension/registry.ts`
  - 注册 contribution，暴露实例创建与 `configSchema` catalog
- `src/cron/*`
  - cron 配置解析、状态存储、调度与失败退避
- `src/sandbox/*`
  - 宿主执行器接口和内置 `HostExecutor`
- `plugins/*`
  - 本地维护的扩展源码：`connector-discord`、`provider-pi`、`provider-claude-cli`、`provider-claude`、`sandbox-core`、`plugin-sdk`
  - 运行时不会从这里 fallback 加载

## 4. 配置模型不变量

配置入口是 `gateway.json`，结构以 `src/core/routing.ts` 为准。

必须保持以下事实成立：

- `providers.defaultProviderId` 必须存在于 `providers.instances`
- `sandboxes.defaultSandboxId` 若存在且不是 `host.builtin`，必须存在于 `sandboxes.instances`
- `routing.defaultRouteId` 若存在，必须存在于 `routing.routes`
- 每条 route 的 `providerId` 若未设置，运行时回落到 `providers.defaultProviderId`
- 每条 route 的 `sandboxId` 若未设置，运行时回落到 `sandboxes.defaultSandboxId ?? host.builtin`
- `connectors.instances[*].config.botChannelMap[channelId]` 必须指向存在的 `routing.routes[routeId]`
- `providers/connectors/sandboxes.instances[*].contributionId` 必须能在“已安装且已启用的扩展 contribution”里找到
- `data.rootDir`、`projectRoot`、`systemPromptFile` 都会在加载时转成绝对路径
- `data.rootDir` 的相对路径有一条特殊规则：
  - 如果配置文件位于 `.../config/gateway.json`，则相对路径相对仓库根目录解析
  - 否则相对配置文件所在目录解析

legacy 字段会被直接拒绝：

- `routing.channelMap`
- `connectors.instances.<id>.config.botTokenEnv`

## 5. 运行时行为不变量

- 会话串行粒度：
  - `connectorId + platform + accountId + chatId + threadId(root)`
- 去重键：
  - `connectorId + platform + accountId + chatId + messageId`
- 线程路由规则：
  - Discord 线程消息使用父频道 ID 查 `botChannelMap`
- Discord connector 当前只处理已映射的 guild channel
  - DM 在 connector 侧被直接忽略，虽然核心类型保留了 `isDirectMessage`
- mention 策略：
  - `allowMentionsOnly=true` 时，群聊消息必须 @bot 才会进入 runtime
- 控制命令：
  - `stop`、`/stop`、`/cancel` 会取消当前与排队中的该会话任务
  - `/new`、`/reset` 会 reset runtime，并在 provider 支持时归档历史 session
- 附件处理：
  - Discord 附件优先下载到 `data/attachments/<connectorId>/<routeChannelId>/<messageId>/...`
  - 图片转为 `session.prompt(..., { images })`
  - 非图片附件路径或远程 URL 以 `<attachments>...</attachments>` 注入 prompt
- 流式输出：
  - 行为受 connector `updateStrategy` 控制，当前 Discord 是 `edit`
- 错误策略：
  - 主流程异常会向 connector 写回 `Error: ...`
  - 流式更新、typing、tool 状态发送失败只记 warning，不应打崩进程

## 6. 扩展系统约束

- 扩展包必须包含 `dobby.manifest.json`
- `manifest.contributions[*].entry` 必须指向包内已构建的 `.js/.mjs/.cjs`
- entry 必须位于包根目录内部，禁止路径越界
- 模块导出必须提供有效 contribution，对应 `kind` 必须和 manifest 一致
- 运行时加载来源只有 `<data.rootDir>/extensions/node_modules`
- 宿主不会从自身依赖树、`plugins/*` 源码目录或 `dist` 外路径 fallback
- `configSchema` 是可选的
  - `init`、`configure`、`config edit` 会优先按 schema 交互提问
  - `applyAndValidateContributionSchemas` 会用 Ajv 套默认值并验证实例配置

当前仓库内的扩展源码与 contribution：

- `@dobby.ai/connector-discord` -> `connector.discord`
- `@dobby.ai/provider-pi` -> `provider.pi`
- `@dobby.ai/provider-claude-cli` -> `provider.claude-cli`
- `@dobby.ai/provider-claude` -> `provider.claude`
- `@dobby.ai/sandbox-core` -> `sandbox.boxlite`、`sandbox.docker`

注意：

- `dobby init` 当前只内建选择 `provider.pi`、`provider.claude-cli` 和 `connector.discord`
- `provider.claude` 与 sandbox 扩展需要手工安装 / 启用 / 配置

## 7. Cron / 计划任务约束

- 启动时总会加载 cron 配置，并在缺失时自动创建默认文件
- cron 配置路径优先级：
  - `--cron-config`
  - `DOBBY_CRON_CONFIG_PATH`
  - 与 gateway 配置同目录下的 `cron.json`
  - fallback 到 `<data.rootDir>/state/cron.config.json`
- job 支持三种 schedule：
  - `at`
  - `every`
  - `cron`
- 状态存储：
  - job store：`cron-jobs.json`
  - run log：`cron-runs.jsonl`
- 调度器支持：
  - `maxConcurrentRuns`
  - 启动时补跑 `runMissedOnStartup`
  - 连续失败退避重试
- 当前真实运行语义：
  - 所有 scheduled run 都走 `Gateway.handleScheduled`
  - conversation key 固定为 `cron:<runId>`
  - runtime 始终按 `stateless + ephemeral` 执行
  - `cron` CLI / store 虽然有 `sessionPolicy` 字段，但当前调度路径没有把它传到运行时

## 8. 文档和代码改动建议

- 改配置模型时，同步检查：
  - `src/core/types.ts`
  - `src/core/routing.ts`
  - `src/cli/shared/config-types.ts`
  - `src/cli/shared/config-mutators.ts`
  - `src/cli/shared/configure-sections.ts`
  - `config/gateway.example.json`
  - `README.md`
- 改 CLI 时，同步检查：
  - `src/cli/program.ts`
  - 对应 `src/cli/commands/*.ts`
  - `README.md`
- 改扩展加载链路时，同步检查：
  - `src/extension/manager.ts`
  - `src/extension/loader.ts`
  - `src/extension/registry.ts`
  - `docs/EXTENSION_SYSTEM_ARCHITECTURE.md`
- 改计划任务时，同步检查：
  - `src/cron/config.ts`
  - `src/cron/store.ts`
  - `src/cron/service.ts`
  - `src/cli/commands/cron.ts`
  - `config/cron.example.json`
  - `docs/CRON_SCHEDULER_DESIGN.md`
- 涉及执行器和路径边界时优先保守，避免放宽 `projectRoot` / `workspaceRoot` 约束

## 9. 提交前最小校验

默认最小校验：

```bash
npm run check
npm run build
npm run test:cli
```

如果改了插件实现，额外执行：

```bash
npm run plugins:check
npm run plugins:build
```

如果改了扩展安装 / 加载链路，建议再执行：

```bash
npm run extensions:list:local
```

手工冒烟建议：

1. 启动后确认日志包含 `Extension packages loaded`、`Discord connector ready`、`Cron scheduler started`（若启用）以及 `Gateway started`
2. 在映射频道 @bot 发消息，确认流式更新与 typing
3. 发送 `stop` 或 `/cancel`，确认能取消当前会话
4. 发送 `/new` 或 `/reset`，确认会话被重置且 provider 归档成功
5. 若启用 cron，执行 `dobby cron run <jobId>` 并确认正在运行的 gateway 会在下一次 scheduler tick 执行任务

## 10. 当前已知边界

- 有一批 focused tests，但仍缺少端到端自动化测试
- `maxConcurrentTurns` 已在 schema / CLI 中存在，但运行时还没有按 route 并发上限执行
- cron job 的 `sessionPolicy` 目前是 schema / CLI 字段，调度执行时未生效
- Discord connector 仍不处理 DM
- `extension uninstall` 不会自动清理 `gateway.json` 中的 allowList 和实例引用
