# im-agent-gateway

Discord-first 本地 Agent Gateway MVP（已升级到统一扩展系统 v2）。

设计目标：独立仓库、依赖 NPM 稳定版 `@mariozechner/pi-*`，不修改 `pi-mono` 源码。

## 架构

- `Gateway Core`：入站处理、幂等去重、路由、会话注册、串行队列。
- `Extension Loader/Registry`：按 allowList 加载 provider/connector/sandbox 扩展。
- `Connector`：平台扩展（MVP 内置 `discord`）。
- `Provider Runtime`：provider 扩展创建会话 runtime（MVP 内置 `pi`）。
- `Sandbox`：`host` 为宿主内置兜底，`docker`/`boxlite` 通过 sandbox 扩展包提供。

## 关键目录

- `src/core`：gateway、routing、runtime-registry、dedup-store。
- `src/agent`：事件转发。
- `src/extension`：插件宿主加载器与注册表（只负责包加载和实例化）。
- `src/sandbox`：执行器抽象与内置 host 执行器。
- `plugins/provider-pi`：provider 插件包（含 manifest、entry、实现源码）。
- `plugins/connector-discord`：Discord connector 插件包（含 manifest、entry、实现源码）。
- `plugins/sandbox-core`：sandbox 插件包（docker、boxlite）。
- `plugins/plugin-sdk`：插件公共契约包（类型与接口）。
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
   - `extensions.allowList`：启用插件包。
   - `providers/connectors/sandboxes.instances`：配置实例。
   - `routing.channelMap`：按 connectorId 绑定 route。
   - `routing.routes.*`：配置 `projectRoot/tools/providerId/sandboxId`。
4. 按需修改 `config/models.custom.json`（`baseUrl`、模型列表等）。
5. 安装依赖：`npm install`
6. 类型检查：`npm run check`
7. 启动（先编译）：
   - `npm run build`
   - `npm run start -- --config ./config/gateway.json`

## 说明

- 同 connector + channel（含 thread 维度）消息按会话串行执行。
- stop 控制事件会尝试中断当前会话。
- 工具调用会记录开始/结束（含错误）日志。
- Docker 执行器限制命令 cwd 必须在 `hostWorkspaceRoot` 内。
