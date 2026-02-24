# Discord-First MVP（独立仓库，依赖 pi 包，不改 pi 源码）

## Summary
最终落地决策如下：
1. 不在 `pi-mono` 内开发 MVP，不修改其源码。
2. 新建你自己的独立仓库（建议名：`dobby`）。
3. 通过 NPM 稳定版依赖 `@mariozechner/pi-*` 包。
4. MVP 仅做 Discord。
5. 架构采用 `Gateway Core + Connector 插件`，单进程运行。
6. 频道能力通过静态 `channelId -> route profile` 映射实现。
7. 沙箱 MVP 先 Docker，Boxlite 作为后续里程碑。

## 1. 代码放置位置
建议新目录（仓库外）：
1. `~/workspace/dobby`（或你的组织仓库）。
2. `pi-mono` 作为只读参考，不参与提交。

## 2. 新仓库结构（MVP）
```text
dobby/
  package.json
  tsconfig.json
  .env.example
  config/
    gateway.example.json         # 可提交示例；复制为 gateway.json 后本地使用
  src/
    main.ts
    core/
      gateway.ts
      routing.ts
      types.ts
      runtime-registry.ts
      dedup-store.ts
    connectors/
      discord/
        connector.ts
        mapper.ts
    agent/
      session-factory.ts
      event-forwarder.ts
    sandbox/
      executor.ts                # interface
      docker-executor.ts
      host-executor.ts
  data/
    sessions/
    attachments/
    logs/
```

## 3. 依赖策略（已锁定）
`package.json` 依赖使用 NPM 稳定版（固定 minor，按需要升级）：
1. `@mariozechner/pi-coding-agent`
2. `@mariozechner/pi-agent-core`
3. `@mariozechner/pi-ai`
4. `discord.js`
5. 你选择的日志与配置库（如 `pino`、`zod`）

不使用：
1. `file:` 本地路径依赖
2. 直接改 `pi-mono/packages/*`

## 4. 与 pi 的边界（不修改源码）
只通过公开 API 使用：
1. `createAgentSession`
2. `SessionManager`
3. `AuthStorage`
4. `ModelRegistry`
5. `createCodingTools(cwd)` / `createReadOnlyTools(cwd)`

你自己的业务逻辑放在独立仓库：
1. Discord 事件接入
2. Channel 路由
3. 队列与幂等
4. 审计与监控
5. 沙箱后端选择

## 5. 频道差异化能力（Discord）
配置文件固定支持：
```json
{
  "channelMap": {
    "1234567890": "projectA",
    "2234567890": "projectB"
  },
  "routes": {
    "projectA": {
      "projectRoot": "/Users/you/workspace/project-a",
      "tools": "full",
      "systemPromptFile": "/Users/you/config/prompts/project-a.md"
    },
    "projectB": {
      "projectRoot": "/Users/you/workspace/project-b",
      "tools": "full",
      "systemPromptFile": "/Users/you/config/prompts/project-b.md"
    }
  }
}
```
这样每个 channel 会绑定不同项目目录与行为。

## 6. Sandbox 方案
MVP：
1. 默认 `docker` 执行器。
2. `host` 仅调试可选。

Post-MVP：
1. 新增 `BoxliteExecutor`，实现同一 `Executor` 接口。
2. 配置切换 `sandbox.backend = "boxlite"`。
3. 对接完成后做稳定性与性能回归。

## 7. 里程碑（更新后）
1. M0：独立仓库初始化 + 配置加载 + 类型定义 + 运行骨架。
2. M1：Discord Connector + Gateway Pipeline + Session 串行队列。
3. M2：频道静态路由（不同 channel -> 不同 projectRoot）。
4. M3：工具全能力 + Docker sandbox + 审计日志。
5. M4：错误恢复、重试、幂等、上线监控。
6. M5：Boxlite 集成（非 MVP）。
7. M6：Telegram/WhatsApp（MVP 后）。

## Test Cases
1. 两个 Discord channel 分别写入不同项目目录，互不污染。
2. 同 channel 并发消息串行执行，不乱序。
3. `message_update` 流式编辑稳定，无覆盖错乱。
4. 工具调用日志完整记录（开始、结束、错误）。
5. Docker 模式下不能越界访问未挂载路径。
6. 进程重启后会话可恢复。

## Assumptions & Defaults
1. 你不会修改 `pi-mono` 源码。
2. 依赖源固定为 NPM 稳定版。
3. MVP 只支持 Discord。
4. 默认工具权限 `full`。
5. 默认 sandbox 为 Docker。
6. channel 路由采用静态配置，不做动态 `/bind`。
