# im-agent-gateway 操作手册

本文档用于把项目在本机跑起来，并完成最小可用验证。

## 1. 前置条件

1. Node.js >= 20（见 `/Users/oasis/workspace/im-agent-gateway/package.json`）。
2. 已安装 npm。
3. 已创建 Discord Bot，并拿到 Token。
4. Discord Bot 已开启 `MESSAGE CONTENT INTENT`，并被邀请到目标服务器。
5. 已准备至少一个本地项目目录（作为 `projectRoot`）。
6. 已准备可用的模型配置（`agent.provider` + `agent.model`），否则启动会报 model not found。

## 2. 初始化项目

在仓库根目录执行：

```bash
npm install
npm run check
```

## 3. 配置环境变量

先复制示例文件：

```bash
cp .env.example .env
```

编辑 `.env`，至少设置：

```bash
DISCORD_BOT_TOKEN=你的真实Token
LOG_LEVEL=info
```

重要：当前代码不会自动读取 `.env`，启动前请把变量导入当前 shell：

```bash
set -a
source .env
set +a
```

## 4. 配置路由与模型

先复制示例配置：

```bash
cp config/gateway.example.json config/gateway.json
cp config/models.custom.example.json config/models.custom.json
```

编辑 `/Users/oasis/workspace/im-agent-gateway/config/gateway.json`。

必须改的内容：

1. `routing.channelMap`：把 Discord 频道 ID 映射到 route。
2. `routing.routes.*.projectRoot`：改成你机器上的真实目录。
3. `routing.routes.*.systemPromptFile`：改成真实文件路径，或先删掉该字段。
4. `agent.provider` / `agent.model`：改成你本机可用的 provider/model。

如果使用自定义模型注册表，再编辑 `/Users/oasis/workspace/im-agent-gateway/config/models.custom.json`：
1. `baseUrl`
2. `models`

注意：

1. 线程消息会按父频道路由，`channelMap` 应填父频道 ID。
2. `allowMentionsOnly: true` 时，群聊里必须 @bot 才会触发。

## 5. 先跑通（推荐先用 host）

为了先验证链路，建议先改成 host sandbox：

```json
"sandbox": {
  "backend": "host"
}
```

启动：

```bash
npm run build
npm run start -- --config ./config/gateway.json
```

## 6. 切换到 Docker（MVP 默认）

确认 `config/gateway.json`：

1. `sandbox.backend = "docker"`
2. `sandbox.docker.hostWorkspaceRoot` 包含所有 `projectRoot`
3. `sandbox.docker.containerWorkspaceRoot` 与容器挂载路径一致（常用 `/workspace`）

示例（仅示意）：

```bash
docker run -dit --name im-agent-sandbox \
  -v /Users/you/workspace:/workspace \
  -w /workspace \
  ubuntu:24.04 sh
```

然后重启网关。

## 7. 最小验收

启动成功后，日志应出现：

1. `Discord connector ready`
2. `Gateway started`

在 Discord 中验证：

1. 在已映射频道 @bot 发送一条消息。
2. Bot 回 `_Thinking..._` 并持续更新结果。
3. 发送 `stop` 可中断当前会话。

## 8. 数据与产物目录

运行后会自动创建：

1. `/Users/oasis/workspace/im-agent-gateway/data/sessions`
2. `/Users/oasis/workspace/im-agent-gateway/data/attachments`
3. `/Users/oasis/workspace/im-agent-gateway/data/logs`
4. `/Users/oasis/workspace/im-agent-gateway/data/state`

## 9. 常见问题

1. `Discord bot token env 'DISCORD_BOT_TOKEN' is not set`
   - 未导出环境变量，重新执行 `set -a; source .env; set +a`。

2. `Configured model 'provider/model' not found`
   - `agent.provider`/`agent.model` 与本机可用模型不一致。

3. `Docker container 'im-agent-sandbox' is not running`
   - 容器不存在或未运行，先启动容器。

4. `Path '...' is outside docker hostWorkspaceRoot '...'`
   - `projectRoot` 不在 `hostWorkspaceRoot` 下，调整配置。

5. 机器人在群里没反应
   - 检查是否 @bot（当 `allowMentionsOnly=true`）。
   - 检查频道是否在 `channelMap`。
   - 检查 bot 在该频道是否有读写权限。
