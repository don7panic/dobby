# Dobby Control Plane 架构设计（与 Domain Plane 交互）

## 1. 背景

`dobby` 当前是 Discord-first 的本地 Agent Gateway（扩展系统 v3）。  
现有实现已经具备：

1. 入站消息路由与会话串行执行。
2. Provider/Connector/Sandbox 通过扩展贡献接入。
3. `stop` 中断、去重、流式输出、附件处理等核心能力。

要补齐的能力是：**定时触发 + 跨 Domain Agent 的结构化协作协议**，使 `dobby` 能稳定扮演 Control Plane。

## 2. 目标与非目标

### 2.1 目标

1. 让 `dobby` 负责用户目标编排、计划管理、触发与结果回传。
2. 让 Domain Plane（例如 Newsletter-Agent）专注领域执行。
3. 通过结构化 Job 契约实现可追踪、可重试、可取消、可审计。
4. 在 macOS 上优先复用 `launchd` 作为调度触发器。

### 2.2 非目标

1. 不在本仓库实现具体领域流程（采集、清洗、发布等）。
2. 不让 `launchd` 承担业务状态管理或重试编排。
3. 不改动 `pi-mono` 源码。

## 3. 总体架构（当前体系下）

```text
User/Discord
  -> Dobby Gateway (existing)
  -> Control Plane Layer (new in dobby)
       - Plan Registry
       - Job Orchestrator
       - Domain Adapter(s)
       - Result Aggregator
  -> Domain Plane Agent(s) (external repo/service)

launchd (macOS)
  -> invoke dobby CLI schedule run <planId>
  -> Job Orchestrator
```

职责分层：

1. `launchd`：只负责“按时触发”。
2. `dobby Control Plane`：负责计划、幂等、调用、回执、状态机。
3. `Domain Plane`：负责领域逻辑与领域级容错。

## 4. 与现有 dobby 核心的映射

基于现有代码边界，新增能力应放在宿主控制层，不破坏现有扩展契约。

1. 保留 `src/core/gateway.ts` 的入站主流程和会话串行模型。
2. 新增 `schedule` 相关 CLI 子命令（在 `src/main.ts` 分发）。
3. 新增 `Plan/Job` 持久化（建议放 `data/state/*`）。
4. 新增 Domain Adapter（调用外部 Domain Agent 的 HTTP/IPC 客户端）。
5. 保持扩展加载不变量：仅从 `<data.rootDir>/extensions/node_modules` 解析。

## 5. Control Plane 核心组件

### 5.1 Plan Registry

负责保存计划定义（例如每天 10:00 执行 newsletter），包含：

1. `planId`
2. 调度表达（供 `launchd` 生成/绑定）
3. `domain`
4. 输入模板（参数、频道、通知策略）
5. `enabled/disabled`

### 5.2 Job Orchestrator

负责每次触发的运行编排：

1. 生成 `runId`、`idempotencyKey`、`traceId`
2. 执行防重（同一时间窗同一 plan 只触发一次）
3. 调用 Domain Adapter 发起 `create_job`
4. 轮询或回调处理 `job_status/result`
5. 更新本地状态并通知用户

### 5.3 Domain Adapter

作为 Control Plane 到 Domain Plane 的单一出口：

1. `create_job`
2. `get_job_status`
3. `cancel_job`

可按 domain 实现多个 adapter，但都走统一接口。

### 5.4 Result Aggregator

把 Domain 返回的结构化结果转换为用户可读输出：

1. `summary`
2. `warnings[]`
3. `errors[]`
4. `artifacts[]`（可选）

## 6. Job 协议（建议）

### 6.1 Dobby -> Domain

1. `create_job`
   - `idempotency_key`
   - `plan_id`
   - `run_id`
   - `trace_id`
   - `payload`
2. `get_job_status`
   - `job_id`
3. `cancel_job`
   - `job_id`
   - `reason`

### 6.2 Domain -> Dobby

1. `job_status`
   - `queued | running | succeeded | failed | cancelled | timed_out`
2. `result`
   - `summary`
   - `warnings[]`
   - `errors[]`
   - `metrics`（可选）

### 6.3 状态机约束

1. 终态：`succeeded/failed/cancelled/timed_out`
2. 终态不可逆。
3. `cancel_job` 对终态返回幂等成功（不抛异常）。

## 7. 调度策略（macOS / launchd）

推荐方案：`launchd` + `dobby schedule run <planId>`。

1. `launchd` 仅触发，不记录业务状态。
2. 真正的“是否已执行、是否重试、是否取消”由 `dobby` 判定。
3. 防止重复触发依赖 `idempotencyKey` 与本地状态锁，而不是依赖 `launchd` 语义。

这样可以避免在 `dobby` 里重复实现一个 OS 级调度器，同时保持业务一致性。

## 8. 可靠性与安全

### 8.1 可靠性

1. 触发语义按“至少一次”设计，业务语义靠幂等保证“效果一次”。
2. Job 状态落盘，支持进程重启后继续查询与回传。
3. 超时策略分层：
   - Control Plane 超时（编排超时）
   - Domain Plane 超时（业务超时）
4. 失败分类：
   - 可重试（网络抖动/429/5xx）
   - 不可重试（参数错误/权限错误）

### 8.2 安全

1. Domain Adapter 出站地址白名单。
2. 认证凭据由环境变量或系统安全存储注入，不落日志。
3. 对外返回给用户的信息默认脱敏（token/path/PII）。

## 9. 设计决策（借鉴开源项目）

以下模式对本架构有直接参考价值：

1. OpenClaw：强调多 Agent 隔离（workspace + state + sessions）与确定性路由（most-specific wins），适合借鉴“路由可预测性”和“状态隔离”设计。
2. AutoGen：分层架构（Core/AgentChat/Extensions）清晰，适合借鉴“协议层与业务层分离”。
3. OpenHands：事件驱动与 append-only event log，适合借鉴“可追踪状态流”和“审计友好”。
4. LangChain/LangGraph Supervisor：中心协调者 + 专业子代理，适合当前 `dobby` 作为 Control Plane 的角色。

## 10. 分阶段落地建议

### Phase 1（最小可用）

1. 新增 `schedule run <planId>` CLI。
2. 增加 `Plan/Job` 本地存储与幂等键。
3. 接入一个 Domain Adapter（Newsletter）。
4. 输出基本状态回传（running/succeeded/failed）。

### Phase 2（可运维）

1. 支持 `cancel_job` 与超时控制。
2. 增加重试策略与错误分类。
3. 增加结构化审计日志与 traceId 贯通。

### Phase 3（可扩展）

1. 多 Domain Adapter 并存。
2. 计划模板与权限策略（谁可触发哪些 plan）。
3. 更细粒度的结果协议与工件管理。

## 11. 结论

在当前 `dobby` 架构下，最稳妥路线是：

1. `launchd` 负责时钟触发；
2. `dobby` 负责 Control Plane 的编排与状态；
3. Domain Agent 负责领域执行；
4. 双方通过 Job 契约解耦并可演进。

这条路线与现有扩展系统 v3 和 gateway 主流程兼容，改造成本低，且长期可扩展。

## 12. 参考资料

1. OpenClaw Multi-Agent Routing: https://docs.openclaw.ai/concepts/multi-agent
2. Microsoft AutoGen (GitHub): https://github.com/microsoft/autogen
3. OpenHands Agent Architecture: https://docs.openhands.dev/sdk/arch/agent
4. OpenHands Events Architecture: https://docs.openhands.dev/sdk/arch/events
5. LangChain Supervisor/Subagents: https://docs.langchain.com/oss/javascript/langchain/multi-agent/subagents-personal-assistant
