# im-agent-gateway

Discord-first 本地 Agent Gateway MVP。

设计目标：独立仓库、依赖 NPM 稳定版 `@mariozechner/pi-*`，不修改 `pi-mono` 源码。

## 架构

- `Gateway Core`：入站处理、幂等去重、路由、会话注册、串行队列。
- `Connector`：平台插件（MVP 仅 `discord`）。
- `Agent Runtime`：通过 `createAgentSession` 调用 pi 能力。
- `Sandbox`：`docker`（默认）/`host`（调试），`boxlite` 预留接口未实现。

## 关键目录

- `src/core`：gateway、routing、runtime-registry、dedup-store。
- `src/connectors/discord`：Discord 收发与消息映射。
- `src/agent`：session-factory、事件转发。
- `src/sandbox`：执行器抽象与 docker/host 实现。
- `config/gateway.example.json`：可提交的网关示例配置。
- `config/gateway.json`：本地实际运行配置（已加入 `.gitignore`）。
- `config/models.custom.example.json`：可提交的模型注册表示例。
- `config/models.custom.json`：本地模型注册表（已加入 `.gitignore`）。
- `data/`：sessions/attachments/logs/state。

## 运行

1. 配置环境变量：复制 `.env.example` 并设置 `DISCORD_BOT_TOKEN`。
2. 复制本地配置文件：
   - `cp config/gateway.example.json config/gateway.json`
   - `cp config/models.custom.example.json config/models.custom.json`
3. 修改 `config/gateway.json`：
   - 绑定 Discord `channelMap`。
   - 设置每个 route 的 `projectRoot`、`tools`、`systemPromptFile`。
   - `sandbox.backend` 默认 `docker`。
4. 按需修改 `config/models.custom.json`（`baseUrl`、模型列表等）。
5. 安装依赖：`npm install`
6. 类型检查：`npm run check`
7. 启动（先编译）：
   - `npm run build`
   - `npm run start -- --config ./config/gateway.json`

## 说明

- 同 channel（含 thread 维度）消息按会话串行执行。
- stop 控制事件会尝试中断当前会话。
- 工具调用会记录开始/结束（含错误）日志。
- Docker 执行器限制命令 cwd 必须在 `hostWorkspaceRoot` 内。
