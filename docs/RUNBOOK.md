# dobby 操作手册（v3）

本文档用于在本机启动 `dobby` 并完成最小验收。  
当前配置模型是扩展系统 v3，默认 sandbox 为 `host.builtin`。

> Scope 变更说明：扩展包已硬切到 `@dobby.ai/*`。若你的旧配置仍使用 `@dobby/*`，请先手动替换后再执行安装/启动命令。

## 1. 前置条件

1. Node.js >= 20（见 `<repo-root>/package.json`）。
2. 已安装 npm。
3. 已创建 Discord Bot，并拿到 Token。
4. Discord Bot 已开启 `MESSAGE CONTENT INTENT`，并被邀请到目标服务器。
5. 已准备至少一个本地项目目录（作为 route 的 `projectRoot`）。

## 2. 初始化项目

在仓库根目录执行：

```bash
npm install
npm run check
```

## 3. 环境变量

复制示例：

```bash
cp .env.example .env
```

编辑 `.env`，至少设置：

```bash
DISCORD_BOT_TOKEN=你的真实Token
LOG_LEVEL=info
```

说明：
1. `npm run start -- --config ...` 不会自动加载 `.env`，请先导出变量。
2. `npm run start:local -- --config ...` 会通过 `--env-file-if-exists=.env` 自动加载。

手动导出方式：

```bash
set -a
source .env
set +a
```

## 4. 准备配置文件

```bash
cp config/gateway.example.json config/gateway.json
cp config/models.custom.example.json config/models.custom.json
```

## 5. 关键配置说明（v3）

编辑 `<repo-root>/config/gateway.json`。

必须检查：
1. `extensions.allowList`：声明启用的扩展包（仅声明启用，不等于已安装）。
2. `providers.instances`：至少有一个 provider 实例，并与 `providers.defaultProviderId` 对应。
3. `connectors.instances`：至少有一个 connector 实例（Discord）。
4. `routing.channelMap`：`connectorId -> channelId -> routeId` 映射。
5. `routing.routes.*.projectRoot`：改成你机器上的真实目录。
6. `routing.routes.*.providerId`：指向已定义 provider 实例。
7. `routing.routes.*.sandboxId`：可省略；省略时走默认 sandbox。

默认 sandbox：
1. 全局默认是 `sandboxes.defaultSandboxId = "host.builtin"`。
2. route 里若显式写 `sandboxId`，则按 route 覆盖。

当前默认示例（推荐）：

```json
"sandboxes": {
  "defaultSandboxId": "host.builtin",
  "instances": {}
}
```

## 6. 扩展安装

首次运行前，需把 allowList 里的扩展安装到 extension store（`data/extensions`）：

```bash
npm run start -- extension install @dobby.ai/provider-pi --config ./config/gateway.json
npm run start -- extension install @dobby.ai/connector-discord --config ./config/gateway.json
```

可选扩展：

```bash
npm run start -- extension install @dobby.ai/provider-claude --config ./config/gateway.json
npm run start -- extension install @dobby.ai/provider-claude-cli --config ./config/gateway.json
npm run start -- extension install @dobby.ai/sandbox-core --config ./config/gateway.json
```

Claude provider 说明：
1. `provider.claude`（`@dobby.ai/provider-claude`）走 Claude Agent SDK。
2. `provider.claude-cli`（`@dobby.ai/provider-claude-cli`）走 Claude Code CLI（当前为 host-only）。

若使用 `provider.claude-cli`，启动前建议检查：

```bash
claude --version
claude auth status --json
```

说明：
1. 若配置 `authMode=subscription`，`claude auth status --json` 需显示 `loggedIn: true`。
2. 若配置 `authMode=apiKey`，需在网关启动环境提供 `ANTHROPIC_API_KEY`。

查看已安装扩展：

```bash
npm run start -- extension list --config ./config/gateway.json
```

## 7. 启动网关

```bash
npm run build
npm run start -- --config ./config/gateway.json
```

或：

```bash
npm run start:local -- --config ./config/gateway.json
```

## 8. 最小验收

启动成功后，日志应包含：
1. `Extension packages loaded`
2. `Discord connector ready`
3. `Gateway started`

在 Discord 中验证：
1. 在已映射频道发送消息（群聊若 `allowMentionsOnly=true` 需 @bot）。
2. Bot 先回复 `_Thinking..._`，随后流式更新。
3. 发送 `stop` 可中断当前运行。

## 9. 切换到 Docker / BoxLite（可选）

如果需要容器沙箱，不再使用 `sandbox.backend` 字段，而是通过扩展实例配置：

1. 安装 `@dobby.ai/sandbox-core`。
2. 在 `sandboxes.instances` 定义实例（如 `sandbox.docker` 或 `sandbox.boxlite`）。
3. 将 `sandboxes.defaultSandboxId` 或 `routing.routes.*.sandboxId` 指向对应实例。

示意（只展示结构）：

```json
"sandboxes": {
  "defaultSandboxId": "docker.main",
  "instances": {
    "docker.main": {
      "contributionId": "sandbox.docker",
      "config": {
        "container": "im-agent-sandbox",
        "hostWorkspaceRoot": "/Users/you/workspace",
        "containerWorkspaceRoot": "/workspace"
      }
    }
  }
}
```

## 10. 数据目录

运行后会自动创建：
1. `<repo-root>/data/sessions`
2. `<repo-root>/data/attachments`
3. `<repo-root>/data/logs`
4. `<repo-root>/data/state`
5. `<repo-root>/data/extensions`

## 11. 常见问题

1. `Discord bot token env 'DISCORD_BOT_TOKEN' is not set`
   - 未导出环境变量，先执行 `set -a; source .env; set +a`，或使用 `npm run start:local`。

2. `Configured model 'provider/model' not found`
   - 检查 provider 实例中的 `provider/model/modelsFile` 是否和 `config/models.custom.json` 一致。

3. `Extension package 'xxx' is not installed in '.../data/extensions'`
   - 先执行 `npm run start -- extension install <package> --config ./config/gateway.json`。

4. Docker 沙箱报 `container is not running` 或越界错误
   - 检查 docker container 状态，以及 `hostWorkspaceRoot` 是否覆盖 route 的 `projectRoot`。

5. 机器人在群里没反应
   - 检查频道是否在 `routing.channelMap[connectorId]` 下。
   - 检查是否需要 @bot（`allowMentionsOnly=true`）。
   - 检查 bot 在频道内的读写权限与消息内容权限。
