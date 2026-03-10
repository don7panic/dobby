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
1. `npm run start --` 不会自动加载 `.env`，请先导出变量。
2. `npm run start:local --` 会通过 `--env-file-if-exists=.env` 自动加载。

手动导出方式：

```bash
set -a
source .env
set +a
```

## 4. 准备配置文件

配置路径优先级：
1. `DOBBY_CONFIG_PATH`（若设置）
2. 在 `dobby` 仓库内运行时自动使用 `./config/gateway.json`
3. 默认 `~/.dobby/gateway.json`

示例（强制指定配置文件）：

```bash
DOBBY_CONFIG_PATH=/tmp/gateway.dev.json npm run start -- config show providers --json
```

```bash
cp config/gateway.example.json config/gateway.json
```

说明：
1. 若你使用 `dobby init` 并选择了 `provider.pi`，`models.custom.json` 会在缺失时自动生成。
2. 手动维护配置时，仍可参考 `config/models.custom.example.json`。

### 4.1 CLI config 命令（硬切）

`config` 已切换为交互与结构化查看，不再支持路径式 `get/set/unset`。

可用命令：

```bash
dobby config show [section] [--json]
dobby config list [section] [--json]
dobby config edit
dobby config schema list [--json]
dobby config schema show <contributionId> [--json]
```

说明：
1. `config edit` 与 `configure` 在编辑 provider/connector 实例时，会优先读取扩展暴露的 `configSchema` 动态生成字段输入。
2. 默认仅询问关键字段；带默认值的高级选项可在提示时按需展开。
3. 若某个 contribution 没有可用 `configSchema`，CLI 会先提示原因（例如扩展 disabled/未安装）；未加载 schema 时会要求你确认是否继续使用 JSON 文本输入。
4. `dobby init` 也会在安装扩展后按 `configSchema` 动态询问 provider/connector 的配置字段（Discord connector 保留专用引导配置）。

旧命令映射：
1. `config get ...` -> `config show` 或 `config list`
2. `config set ...` -> `config edit`
3. `config unset ...` -> 使用专用删除命令（`channel unset`、`route remove`、`extension uninstall`）

`init` 语义说明：
1. `dobby init` 仅用于首次初始化。
2. 若配置文件已存在，`init` 会直接报错；请改用 `dobby config edit` 或 `dobby configure`。

## 5. 关键配置说明（v3）

编辑 `<repo-root>/config/gateway.json`。

必须检查：
1. `extensions.allowList`：声明启用的扩展包（仅声明启用，不等于已安装）。
2. `providers.items`：至少有一个 provider 实例，并与 `providers.default` 对应。
3. `connectors.items`：至少有一个 connector 实例（Discord）。
4. `routes.items.*.projectRoot`：改成你机器上的真实目录。
5. `bindings.items.*`：为每个入口声明 `(connector, source.type, source.id) -> route`。
6. `routes.items.*.provider`：可省略；省略时走 `routes.defaults.provider`。
7. `routes.items.*.sandbox`：可省略；省略时走 `routes.defaults.sandbox`。

默认 sandbox：
1. 全局默认是 `sandboxes.default = "host.builtin"`。
2. route 里若显式写 `sandbox`，则按 route 覆盖。

当前默认示例（推荐）：

```json
"sandboxes": {
  "default": "host.builtin",
  "items": {}
}
```

## 6. 扩展安装

首次运行前，需把 allowList 里的扩展安装到 extension store（`data/extensions`）：

```bash
npm run start -- extension install @dobby.ai/provider-pi
npm run start -- extension install @dobby.ai/connector-discord
```

可选扩展：

```bash
npm run start -- extension install @dobby.ai/provider-claude
npm run start -- extension install @dobby.ai/provider-claude-cli
npm run start -- extension install @dobby.ai/sandbox-core
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
npm run start -- extension list
```

## 7. 启动网关

```bash
npm run build
npm run start --
```

或：

```bash
npm run start:local --
```

## 8. 最小验收

启动成功后，日志应包含：
1. `Extension packages loaded`
2. `Discord connector ready`
3. `Gateway started`

在 Discord 中验证：
1. 在已绑定频道发送消息（群聊若 `mentions="required"` 需 @bot）。
2. Bot 先回复 `_Thinking..._`，随后流式更新。
3. 发送 `stop`、`/stop` 或 `/cancel` 可取消当前会话中正在执行和排队中的任务。
4. 发送 `/new` 或 `/reset` 会归档当前会话状态，并让下一条消息从新会话开始。

## 9. 切换到 Docker / BoxLite（可选）

如果需要容器沙箱，不再使用 `sandbox.backend` 字段，而是通过扩展实例配置：

1. 安装 `@dobby.ai/sandbox-core`。
2. 在 `sandboxes.items` 定义实例（如 `sandbox.docker` 或 `sandbox.boxlite`）。
3. 将 `sandboxes.default` 或 `routes.items.*.sandbox` 指向对应实例。

示意（只展示结构）：

```json
"sandboxes": {
  "default": "docker.main",
  "items": {
    "docker.main": {
      "type": "sandbox.docker",
      "container": "im-agent-sandbox",
      "hostWorkspaceRoot": "/Users/you/workspace",
      "containerWorkspaceRoot": "/workspace"
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
   - 先执行 `npm run start -- extension install <package>`。

4. Docker 沙箱报 `container is not running` 或越界错误
   - 检查 docker container 状态，以及 `hostWorkspaceRoot` 是否覆盖 route 的 `projectRoot`。

5. 机器人在群里没反应
   - 检查入口是否已经写进 `bindings.items`。
   - 检查是否需要 @bot（`mentions="required"`）。
   - 检查 bot 在频道内的读写权限与消息内容权限。
