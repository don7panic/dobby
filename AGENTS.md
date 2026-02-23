# AGENTS Guide (im-agent-gateway)

本文件给在本仓库内工作的 AI/自动化代理使用。目标是让改动与当前实现保持一致，减少“看起来合理但和代码无关”的输出。

## 1. 项目定位

- 项目名：`im-agent-gateway`
- 形态：Discord-first 本地 Agent Gateway（扩展系统 v3）
- 关键约束：
  - 独立仓库开发，不改 `pi-mono` 源码
  - 宿主只负责核心流程与扩展加载
  - Provider / Connector / Sandbox 通过扩展包贡献（contribution）接入
  - 扩展运行时目录固定：`<data.rootDir>/extensions`
  - `extensions.allowList` 只声明启用，不负责安装

## 2. 技术栈与常用命令

- Node.js `>=20`
- TypeScript + ESM (`module: NodeNext`, `strict: true`)
- 宿主主要依赖：`pino`、`zod`、`@mariozechner/pi-ai`
- 插件依赖在各自包内声明（例如 Discord 插件依赖 `discord.js`）

常用命令（仓库根目录）：

```bash
npm install
npm run check
npm run build
npm run start -- --config ./config/gateway.json
```

扩展管理命令（运行时 extension store）：

```bash
npm run start -- extension install <packageSpec> --config ./config/gateway.json
npm run start -- extension uninstall <packageName> --config ./config/gateway.json
npm run start -- extension list --config ./config/gateway.json
```

本地插件开发命令（由 `scripts/local-extensions.mjs` 统一驱动）：

```bash
npm run plugins:install
npm run plugins:check
npm run plugins:build
npm run extensions:install:local
npm run extensions:list:local
npm run plugins:setup:local
```

注意：代码不会自动加载 `.env`。运行前需手动导出环境变量（例如 `DISCORD_BOT_TOKEN`）。

## 3. 代码结构与职责

- `src/main.ts`
  - 启动入口与 CLI 分发（`start` / `extension install|uninstall|list`）
  - 解析配置、创建 data 目录、加载扩展、实例化网关
- `src/core/gateway.ts`
  - 入站主流程：去重 -> 路由 -> mention 策略 -> runtime 获取 -> 串行执行 -> 事件转发
  - 处理 `stop` 控制事件
- `src/core/routing.ts`
  - `gateway.json` 的 zod 校验与归一化（相对路径转绝对路径）
- `src/core/runtime-registry.ts`
  - conversation 级 runtime 复用 + 队列串行化 + abort + closeAll
- `src/core/dedup-store.ts`
  - 去重键 TTL 持久化（`data/state/dedup.json`）
- `src/agent/event-forwarder.ts`
  - Agent 事件 -> Connector 消息（流式 update + tool start/end/status）
- `src/extension/manager.ts`
  - 扩展 store 初始化、npm 安装/卸载、已安装扩展清单
- `src/extension/loader.ts`
  - 仅从 `<data.rootDir>/extensions/node_modules` 解析 allowList 包并加载 contribution
- `src/extension/registry.ts`
  - contribution 注册与 provider/connector/sandbox 实例化
- `src/sandbox/*`
  - 宿主内置执行器接口与 `HostExecutor`
- `plugins/*`
  - 扩展包源码（`plugin-sdk`、`connector-discord`、`provider-pi`、`provider-claude`、`sandbox-core`）
  - 注意：宿主运行时不会从 `plugins/*` 回退加载

## 4. 配置不变量（改动前先确认）

配置来源：`config/gateway.json`，结构定义在 `src/core/routing.ts`。

必须保持以下一致性：

- `extensions.allowList[*].package` 若启用，必须可从 `<data.rootDir>/extensions/node_modules` 解析，否则启动 fail-fast
- `providers/connectors/sandboxes.instances[*].contributionId` 必须存在于已加载贡献
- `routing.channelMap[connectorId][channelId]` 必须指向存在的 `routing.routes[routeId]`
- `routing.defaultRouteId` 若设置，必须存在于 `routing.routes`
- 路由字段语义：
  - `projectRoot`: agent 运行目录边界
  - `tools`: `full` 或 `readonly`
  - `allowMentionsOnly`: 群聊是否仅 @bot 触发
  - `maxConcurrentTurns`: 当前 schema 存在，但运行时尚未启用并发上限
- sandbox 默认值：
  - 未指定时使用 `host.builtin`
  - 外部 sandbox（docker/boxlite）由扩展包实例提供

## 5. 行为不变量（改代码时不要破坏）

- 会话串行粒度：`connectorId + platform + accountId + chatId + threadId(root)`，同会话必须顺序执行
- 消息去重键：`connectorId + platform + accountId + chatId + messageId`
- 线程路由规则：线程消息用父频道 ID 做路由（`routeChannelId`）
- `stop` 文本（大小写不敏感）触发 `runtimeRegistry.abort`
- 附件处理：
  - Discord 附件优先下载到 `data/attachments/...`
  - 图片转为 `session.prompt(..., { images })`
  - 非图片附件路径以 `<attachments>` 注入 prompt
- 出错策略：
  - 主流程异常回写 `Error: ...` 到占位消息
  - tool/streaming 发送失败仅记录 warning，不应导致进程崩溃
- 扩展加载策略：
  - 只允许 extension store 解析，不允许宿主依赖树或源码目录 fallback

## 6. Discord Connector 约束

当前 Discord 插件（`plugins/connector-discord`）除消息处理外，包含连接韧性逻辑：

- 依赖 `discord.js` 默认 gateway 心跳与自动重连
- 监听并记录 `shardDisconnect` / `shardReconnecting` / `shardResume` / `shardError` / `error` / `invalidated`
- 内置 watchdog：长时间非 ready 会触发强制重连
- 配置项：
  - `reconnectStaleMs`（默认 `60000`）
  - `reconnectCheckIntervalMs`（默认 `10000`）

## 7. 插件包契约（作者侧）

- 插件包必须包含 `im-agent-gateway.manifest.json`
- `manifest.contributions[*].entry` 必须是包内已构建 JS（`.js/.mjs/.cjs`）
- entry 必须位于包根目录内部（禁止路径越界）
- 插件第三方依赖放在插件自身 `dependencies`
- `@im-agent-gateway/plugin-sdk` 建议作为 `peerDependencies`（开发态可在 `devDependencies` 用 `file:../plugin-sdk`）
- 插件运行时不得依赖宿主源码路径或宿主构建产物路径

## 8. 改动建议

- 修改配置模型时，同步更新：
  - `src/core/types.ts`
  - `src/core/routing.ts`（schema + normalize + references 校验）
  - `config/gateway.example.json`（示例配置）
- 修改扩展系统时，同步检查：
  - `src/extension/manager.ts`
  - `src/extension/loader.ts`
  - `src/extension/registry.ts`
  - `docs/EXTENSION_SYSTEM_ARCHITECTURE.md` 与 README 对应章节
- 涉及执行器安全边界时优先保守，避免放宽 `projectRoot`/workspaceRoot 越界约束

## 9. 提交前最小校验

```bash
npm run check
npm run build
```

若改动了插件实现，额外执行：

```bash
npm run plugins:check
npm run plugins:build
```

若改动了扩展安装/加载链路，建议再执行：

```bash
npm run extensions:list:local
```

手工冒烟建议：

1. 启动后确认日志包含 `Extension packages loaded`、`Discord connector ready`、`Gateway started`
2. 在映射频道 @bot 发消息，确认 `_Thinking..._` 与流式更新
3. 发送 `stop`，确认能中断当前运行
4. 断网后恢复网络，确认 Discord 连接可自动恢复（查看 shard/reconnect 日志）

## 10. 当前已知边界（不是 bug）

- 无自动化测试；当前以类型检查 + 手工冒烟为主
- `maxConcurrentTurns` 尚未在运行时生效
- 扩展安装/卸载不会自动改写 `gateway.json`
- `.env` 不会被自动读取，必须由启动环境提供变量
