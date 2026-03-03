# Dobby A2A Core 设计说明（Draft v0.1）

- 状态：Draft
- 日期：2026-03-03
- 适用范围：单机单进程 `dobby`
- 相关文档：`Control_Plane.md`、`docs/EXTENSION_SYSTEM_ARCHITECTURE.md`

## 1. 目标与定位

`dobby` 的定位不是“平台型大而全 agent”，而是“可基于源码定制的本地 AI agent gateway”。  
A2A 在本项目中的目标是补齐基础协作能力，而不是引入复杂编排平台。

本设计只提供最小可用 A2A 内核：

1. `delegate`：委派任务给另一个 route/provider
2. `status`：查询委派任务状态
3. `cancel`：取消委派任务

## 2. 非目标

以下能力不在 A2A Core v1 范围内：

1. 多节点/分布式 A2A
2. 图形化编排 DSL 或 workflow 编辑器
3. 自动智能路由与策略优化器
4. 机器人消息互相触发式回环
5. 通用“平台协议网关”能力

## 3. 外部实现对比结论（用于边界校准）

## 3.1 OpenClaw 的可借鉴点

1. A2A 是显式能力，默认关闭后按策略开启
2. 有清晰访问控制：`tools.agentToAgent` + `tools.sessions.visibility`
3. 有回路约束：`session.agentToAgent.maxPingPongTurns`
4. 对高风险工具做默认 deny

参考：
- https://github.com/openclaw/openclaw/blob/16df7ef4a973c86339774dcd9c851c3210cd0ff2/README.md#L255-L263
- https://github.com/openclaw/openclaw/blob/16df7ef4a973c86339774dcd9c851c3210cd0ff2/src/config/types.tools.ts#L540-L560
- https://github.com/openclaw/openclaw/blob/16df7ef4a973c86339774dcd9c851c3210cd0ff2/src/config/zod-schema.session.ts#L58-L63
- https://github.com/openclaw/openclaw/blob/16df7ef4a973c86339774dcd9c851c3210cd0ff2/src/security/dangerous-tools.ts#L9-L20

## 3.2 NanoClaw 的可借鉴点

1. 协作主轴偏任务调度：`schedule_task/list/pause/resume/cancel`
2. 权限模型直观：main group 与非 main group 分权
3. 单进程、小系统、易定制，贴近 `dobby` 初衷

参考：
- https://github.com/qwibitai/nanoclaw/blob/5c58ea04e29a24626da0e120a9de7e358990e689/README.md#L123-L137
- https://github.com/qwibitai/nanoclaw/blob/5c58ea04e29a24626da0e120a9de7e358990e689/container/agent-runner/src/ipc-mcp-stdio.ts#L65-L155
- https://github.com/qwibitai/nanoclaw/blob/5c58ea04e29a24626da0e120a9de7e358990e689/src/ipc.ts#L202-L209

## 3.3 本项目取舍

A2A Core v1 采用“OpenClaw 的策略边界 + NanoClaw 的任务导向”：

1. 先做任务委派模型，不先做会话 ping-pong
2. 默认关闭 + allowlist 显式放行
3. 先保证可靠性和安全，再谈高级协作体验

## 4. A2A Core v1 能力

## 4.1 必须能力

1. 跨 route 委派任务（异步为主）
2. 查询 run 状态与结果摘要
3. 取消 queued/running run
4. 强制权限校验（source route -> target route）
5. 深度限制（防递归失控）
6. 运行状态持久化（重启后可查）

## 4.2 可选能力

1. 同步等待模式（`mode=sync`）
2. 级联取消（父 run cancel 时取消子 run）

## 5. 配置模型（提案）

在 `gateway.json` 增加：

```json
{
  "agent2agent": {
    "enabled": false,
    "maxDelegationDepth": 2,
    "defaultSyncWaitMs": 120000,
    "maxSyncWaitMs": 300000
  }
}
```

在 `routing.routes.<routeId>` 增加：

```json
{
  "a2a": {
    "enabled": false,
    "allowTargetRoutes": [],
    "allowSyncWait": false
  }
}
```

语义：

1. `agent2agent.enabled=false` 时全局禁用 A2A
2. route 需同时 `a2a.enabled=true` 才可发起委派
3. 目标 route 必须在 `allowTargetRoutes` 列表中
4. sync 等待受全局与 route 双重限制

## 6. 工具契约（provider 统一）

## 6.1 `a2a_delegate`

输入：

1. `targetRouteId: string`
2. `prompt: string`
3. `mode?: "async" | "sync"`（默认 async）
4. `waitMs?: number`
5. `metadata?: Record<string,string>`

输出：

1. `runId: string`
2. `accepted: boolean`
3. `status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out"`
4. `summary?: string`
5. `error?: string`

## 6.2 `a2a_status`

输入：

1. `runId: string`

输出：

1. `runId`
2. `status`
3. `createdAt`
4. `startedAt?`
5. `endedAt?`
6. `summary?`
7. `error?`

## 6.3 `a2a_cancel`

输入：

1. `runId: string`

输出：

1. `runId`
2. `cancelled: boolean`
3. `finalStatus`

## 7. 运行与状态机

状态机：

1. `queued`
2. `running`
3. `succeeded`
4. `failed`
5. `cancelled`
6. `timed_out`

约束：

1. 终态不可逆
2. `cancel` 对终态幂等成功
3. sync 超时返回 `timed_out`，并按配置决定是否自动 cancel

## 8. 安全与边界

1. 默认拒绝所有跨 route 委派
2. 限制 `maxDelegationDepth`
3. 禁止 sandbox 降级委派
4. 委派请求必须携带 `sourceRouteId` 与 `traceId`
5. 不通过 connector bot message 回流触发 A2A

## 9. 可观测性

每个 run 统一记录：

1. `runId`
2. `traceId`
3. `parentRunId?`
4. `sourceRouteId`
5. `targetRouteId`
6. `status`
7. `errorCode?`
8. `durationMs?`

建议落盘路径：

1. `data/state/a2a-runs.json`

## 10. 验收标准

1. 未授权 target route 委派返回 `accepted=false`
2. 授权后 run 能进入 `queued -> running -> terminal`
3. 超过深度限制必须拒绝
4. cancel 行为幂等
5. 重启后可通过 `a2a_status` 查询历史 run
6. 关闭 A2A 后现有消息流程无行为变化

## 11. 与现有架构的兼容说明

1. 不改变 Connector 协议形态
2. 不依赖 bot-to-bot message 触发
3. 不打破现有 runtime 串行语义
4. 与扩展系统 v3 兼容（provider 仅新增工具，不改加载机制）

## 12. 后续演进（非 v1）

1. `session.send` 型协作（可选 reply-back）
2. 更细粒度 source/target 双向策略
3. CLI 诊断命令：`a2a runs list/show/cancel`
