# AGENTS Guide (im-agent-gateway)

本文件给在本仓库内工作的 AI/自动化代理使用。目标是让改动和当前实现保持一致，减少“看起来合理但和代码无关”的输出。

## 1. 项目定位

- 项目名：`im-agent-gateway`
- 形态：Discord-first 的本地 Agent Gateway（MVP）
- 关键约束：
  - 独立仓库开发，不改 `pi-mono` 源码
  - 依赖 NPM 稳定版 `@mariozechner/pi-*`
  - 当前只实现 Discord connector
  - `sandbox.backend` 仅支持 `host` / `docker`，`boxlite` 明确未实现

## 2. 技术栈与运行命令

- Node.js `>=20`
- TypeScript + ESM (`module: NodeNext`, `strict: true`)
- 主要依赖：`discord.js`、`pino`、`zod`、`@mariozechner/pi-coding-agent`

常用命令（仓库根目录）：

```bash
npm install
npm run check
npm run build
npm run start -- --config ./config/gateway.json
```

开发态可用：

```bash
npm run dev
```

注意：代码不会自动加载 `.env`。本地运行前需手动导出环境变量（例如 `DISCORD_BOT_TOKEN`）。

## 3. 代码结构与职责

- `src/main.ts`
  - 解析 `--config`
  - 加载配置并创建 data 子目录
  - 初始化 executor / dedup / routing / runtime registry / session factory / connector
- `src/core/gateway.ts`
  - 入站处理总流程：去重 -> 路由 -> mention 策略 -> 会话获取 -> 串行执行 -> 事件转发
  - 处理 `stop` 控制事件
- `src/core/routing.ts`
  - `gateway.json` 的 zod 校验与归一化（相对路径转绝对路径）
- `src/core/runtime-registry.ts`
  - conversation 级 runtime 复用 + 队列串行化 + abort + closeAll
- `src/core/dedup-store.ts`
  - 去重键 TTL 持久化（`data/state/dedup.json`）
- `src/agent/session-factory.ts`
  - 创建 `createAgentSession`
  - 根据 route 的工具权限组装 tools（`full` / `readonly`）
  - 强制文件访问不越过 route 的 `projectRoot`
- `src/agent/event-forwarder.ts`
  - 把 Agent 事件转成 Discord 消息（流式 update + tool start/end 通知）
- `src/connectors/discord/*`
  - Discord 消息映射、附件下载、消息发送/编辑、`stop` 指令识别
- `src/sandbox/*`
  - executor 抽象
  - `HostExecutor` 本机执行
  - `DockerExecutor` 通过 `docker exec` 执行并校验路径映射

## 4. 配置不变量（改动前先确认）

配置来源：`config/gateway.json`，结构定义在 `src/core/routing.ts`。

必须保持以下一致性：

- `routing.channelMap[channelId]` 必须指向存在的 `routing.routes[routeId]`
- `routing.defaultRouteId` 若设置，必须存在于 `routes`
- 路由字段语义：
  - `projectRoot`: agent 运行 cwd 根目录（工具访问边界）
  - `tools`: `full` 或 `readonly`
  - `allowMentionsOnly`: 群聊是否只在 @bot 时触发
  - `maxConcurrentTurns`: 当前 schema 有此字段，但运行时尚未使用并发上限
- `sandbox.backend = "docker"` 时：
  - `projectRoot` 必须在 `docker.hostWorkspaceRoot` 之内
  - `containerWorkspaceRoot` 要和容器挂载路径一致

## 5. 行为不变量（改代码时不要破坏）

- 会话串行粒度：`platform + accountId + chatId + threadId(root)`，同会话必须顺序执行
- 消息去重键：`platform + accountId + chatId + messageId`
- 线程路由规则：线程消息用父频道 ID 做路由（`routeChannelId`）
- `stop` 文本（大小写不敏感）触发 `runtimeRegistry.abort`
- 附件处理：
  - Discord 附件优先下载到 `data/attachments/...`
  - 图片会转为 `session.prompt(..., { images })`
  - 非图片附件路径以 `<attachments>` 文本注入 prompt
- 出错策略：
  - 主流程异常会回写 `Error: ...` 到占位消息
  - tool/streaming 的发送失败只记录 warning，不应导致进程崩溃

## 6. 改动建议

- 修改配置模型时，同步更新这 3 处：
  - `src/core/types.ts`
  - `src/core/routing.ts`（zod schema + normalize）
  - `config/gateway.json`（示例配置）
- 新增平台 connector 时，至少补齐：
  - `Platform` 类型
  - connector 初始化分支（`src/main.ts`）
  - message mapper 与 outbound send/edit 语义
- 涉及执行器安全边界时，优先保守，避免放宽 `projectRoot` / `hostWorkspaceRoot` 越界检查

## 7. 提交前最小校验

```bash
npm run check
npm run build
```

如果改动了 Discord 路径、路由或 executor，建议再做一次手工冒烟：

1. 启动网关后确认日志出现 `Discord connector ready` 和 `Gateway started`
2. 在已映射频道 @bot 发消息，确认能看到 `_Thinking..._` 和后续流式更新
3. 发送 `stop`，确认收到停止反馈

## 8. 当前已知边界（不是 bug）

- 无自动化测试；当前依赖类型检查 + 手工冒烟
- `boxlite` backend 在 MVP 中故意未实现
- `.env` 不会被自动读取，必须由启动环境提供变量
