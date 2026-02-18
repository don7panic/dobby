# 统一扩展系统架构（Breaking v2）

## 1. 背景与目标
- 将 `provider`、`connector`、`sandbox` 统一为可插拔扩展系统。
- MVP 内置 `pi-coding-agent`、Discord connector、`host` sandbox（兜底）。
- `docker/boxlite` 作为外部 sandbox 扩展（本地 npm 包示例为 `@im-agent-gateway/sandbox-core`）。
- 后续通过本地安装插件接入 Claude/Codex（SDK-first）。
- 允许 breaking changes，不保留旧配置兼容层。

## 2. 核心设计原则
- 统一抽象：三类扩展共享同一套 Manifest 与加载流程。
- 显式治理：仅加载 `extensions.allowList` 中启用的插件包。
- 实例化配置：`contribution` 与 `instance` 分离，route 只引用实例 ID。
- 默认简单：全局 default provider/sandbox，route 可覆盖。
- 可观测优先：启动时输出已加载插件、贡献、实例绑定关系。

## 3. 统一扩展模型（Manifest、Contribution、实例）
- 扩展种类：`provider | connector | sandbox`。
- 插件包 Manifest：`im-agent-gateway.manifest.json`。
- 插件契约通过 `@im-agent-gateway/plugin-sdk` 暴露，插件实现不得直接依赖宿主 `src/*`。
- `contribution`：插件声明的能力单元（例如 `provider.pi`、`connector.telegram`）。
- `instance`：运行时实例，绑定一个 `contributionId` 和具体 `config`。
- route 通过 `providerId`、`sandboxId` 指向实例，connector 路由通过 `connectorId` 分组。

### Manifest 示例
```json
{
  "apiVersion": "1.0",
  "name": "my-extension-pack",
  "version": "0.1.0",
  "contributions": [
    {
      "id": "provider.codex",
      "kind": "provider",
      "entry": "./dist/provider-codex.js",
      "capabilities": {
        "supportsStreaming": true,
        "supportsAbort": true,
        "supportsImages": true
      }
    }
  ]
}
```

## 4. 配置模型（全新 v2，含示例）
- 旧顶层 `agent/discord/sandbox` 已移除。
- 新顶层：`extensions/providers/connectors/sandboxes/routing/data`。

```json
{
  "extensions": {
    "allowList": [
      { "package": "@im-agent-gateway/provider-pi", "enabled": true },
      { "package": "@im-agent-gateway/provider-claude", "enabled": true },
      { "package": "@im-agent-gateway/connector-discord", "enabled": true },
      { "package": "@im-agent-gateway/sandbox-core", "enabled": true }
    ]
  },
  "providers": {
    "defaultProviderId": "pi.main",
    "instances": {
      "pi.main": {
        "contributionId": "provider.pi",
        "config": {
          "provider": "custom-openai",
          "model": "kimi-k2.5",
          "thinkingLevel": "off",
          "modelsFile": "./models.custom.json"
        }
      },
      "claude.main": {
        "contributionId": "provider.claude",
        "config": {
          "model": "claude-sonnet-4-5",
          "maxTurns": 20,
          "sandboxedProcess": true,
          "requireSandboxSpawn": true,
          "dangerouslySkipPermissions": true,
          "settingSources": ["project", "local"],
          "authMode": "env"
        }
      }
    }
  },
  "connectors": {
    "instances": {
      "discord.main": {
        "contributionId": "connector.discord",
        "config": {
          "botTokenEnv": "DISCORD_BOT_TOKEN",
          "allowDirectMessages": true,
          "allowedGuildIds": []
        }
      }
    }
  },
  "sandboxes": {
    "defaultSandboxId": "host.builtin",
    "instances": {}
  },
  "routing": {
    "defaultRouteId": "projectA",
    "channelMap": {
      "discord.main": {
        "1468896805679792221": "projectA"
      }
    },
    "routes": {
      "projectA": {
        "projectRoot": "/Users/oasis/Documents/fazhi",
        "tools": "full",
        "allowMentionsOnly": true,
        "maxConcurrentTurns": 1,
        "providerId": "pi.main",
        "sandboxId": "host.builtin"
      }
    }
  },
  "data": {
    "rootDir": "./data",
    "dedupTtlMs": 604800000
  }
}
```

## 5. Provider 插件协议（SDK-first）
- Provider contribution 必须实现：
  - `kind: "provider"`
  - `createInstance({ instanceId, config, host, data })`
- Provider instance 必须实现：
  - `createRuntime({ conversationKey, route, inbound, executor })`
  - 返回统一 `GatewayAgentRuntime`：
    - `prompt()`
    - `subscribe()`
    - `abort()`
    - `dispose()`
- 内置 `provider.pi` 将 `pi-coding-agent` 事件映射到 `GatewayAgentEvent`。
- `provider.claude` 使用 Claude Agent SDK，默认启用 sandboxed process，并通过 `executor.spawn()` 在 route 选定 sandbox 中运行 Claude Code 子进程。
- `provider.claude` 第一期采用 Claude 内置工具白名单映射 `route.tools`：
  - `readonly`: `Read/Grep/Glob/LS`
  - `full`: `Read/Grep/Glob/LS/Edit/Write/Bash`

## 6. Connector 插件协议
- Connector contribution 必须实现：
  - `kind: "connector"`
  - `createInstance({ instanceId, config, host, attachmentsRoot })`
- Connector instance（`ConnectorPlugin`）必须实现：
  - `id/platform/name/capabilities`
  - `start(ctx)`、`send(message)`、`stop()`
- 入站消息必须携带 `connectorId`，用于路由与去重隔离。

## 7. Sandbox 插件协议
- Sandbox contribution 必须实现：
  - `kind: "sandbox"`
  - `createInstance({ instanceId, config, host })`
- Sandbox instance 必须返回：
  - `id`
  - `executor`（统一 `exec/spawn/close` 协议）
- route 通过 `sandboxId` 选择 executor；未指定时回退 `sandboxes.defaultSandboxId`。

## 8. 插件加载与生命周期
- 启动阶段：
  - 读取并校验配置。
  - 读取 `allowList` 并加载插件包（内置或外部包）。
  - 解析 Manifest、加载 contribution entry。
  - 注册 contribution，实例化 provider/connector/sandbox。
  - 同时初始化宿主内置 `host` executor（不依赖插件）。
  - 启动 connectors，Gateway 开始收消息。
- 运行阶段：
  - connector 产生 `InboundEnvelope(connectorId, platform, ...)`
  - route resolver 用 `(connectorId, routeChannelId)` 查 route。
  - route 选 provider + sandbox，创建或复用 runtime。
  - runtimeRegistry 串行执行会话消息。
- 关闭阶段：
  - connector.stop()
  - runtimeRegistry.closeAll()
  - provider close（可选）
  - sandbox executor.close()

## 9. 插件开发与安装流程（本地安装优先）
- 开发者实现插件包并产出构建文件。
- 在 gateway 项目执行：
  - `npm install ../your-plugin`
  - 或 `npm install file:../your-plugin`
- 修改 `config/gateway.json`：
  - `extensions.allowList` 加入包名。
  - 在 `providers/connectors/sandboxes.instances` 新增实例。
  - route 绑定 `providerId` / `sandboxId`。
- 重启进程生效（不支持热重载）。

当前仓库提供本地包化样例：
- `/Users/oasis/workspace/im-agent-gateway/plugins/provider-pi`
- `/Users/oasis/workspace/im-agent-gateway/plugins/provider-claude`
- `/Users/oasis/workspace/im-agent-gateway/plugins/connector-discord`
- `/Users/oasis/workspace/im-agent-gateway/plugins/sandbox-core`

## 10. 安全与治理（白名单 + 能力闸门）
- 白名单：未列入 `allowList` 的包不会被加载。
- 宿主进程默认同进程加载扩展；provider 可通过 `executor.spawn()` 将实际模型子进程放入 sandbox。
- sandbox 边界由具体 executor 保证（例如 docker hostWorkspaceRoot 限制）。
- `provider.claude` sandboxed 模式下，Claude 执行与工具调用在 sandbox 内运行，并受 route/projectRoot 与 sandbox 配置共同约束。

## 11. 错误处理与可观测性
- 启动失败场景：
  - Manifest 不合法
  - contribution kind 与导出不匹配
  - instance 引用不存在的 contribution
  - route 引用不存在 provider/sandbox
- 运行时失败策略：
  - 主流程异常回写 `Error: ...` 到占位消息
  - tool/streaming 发送失败仅 warning，不崩溃进程
- 关键日志：
  - 已加载插件包、版本、contributions
  - route/provider/sandbox 绑定
  - tool start/end、abort、connector send failure

## 12. 测试与验收标准
- 配置校验：
  - 缺失 `contributionId`
  - instance 指向不存在 contribution
  - route 指向不存在 provider/sandbox
- 加载治理：
  - 非 allowList 包拒绝加载
  - `apiVersion` 不匹配时启动失败
- 功能冒烟：
  - `pi + discord + host.builtin` 可启动
  - 安装并启用 `sandbox-core` 后 `docker/boxlite` 可按 route 使用
  - `_Thinking..._` 与流式更新正常
  - `stop` 可中断当前会话
- 扩展验证：
  - 本地安装 provider 插件后可按 route 切换
  - 新 connector 插件可并存且路由不冲突
  - 新 sandbox 插件支持 route 级覆盖
- 最小检查命令：
  - `npm run check`
  - `npm run build`

## 13. Breaking Changes 清单
- 删除旧顶层配置：`agent`、`discord`、`sandbox`。
- `routing.channelMap` 改为：`connectorId -> channelId -> routeId`。
- `Platform` 由固定 `"discord"` 改为扩展字符串。
- `SessionFactory` 不再是唯一 provider 入口，替换为 provider instance/runtime。
- `event-forwarder` 不再绑定 `pi-coding-agent` 原始事件类型。
- `InboundEnvelope` 新增 `connectorId`，用于跨 connector 隔离。

## 14. 默认值与假设
- 插件来源：先支持本地安装验证，不支持 remote package 市场。
- 信任模型：显式 allowList。
- 隔离模型：同进程扩展 + 可选 provider sandboxed process（通过 `executor.spawn()`）。
- Provider 策略：SDK-first（Claude/Codex 目标适配策略）。
- Sandbox 策略：全局默认 + route 覆盖。
- 生效策略：重启生效，不支持热加载。
- `maxConcurrentTurns` 字段保留，当前不启用并发上限调度。
