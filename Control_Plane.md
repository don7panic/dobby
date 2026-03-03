# Dobby Control Plane 架构设计（与 Domain Plane 交互）

> A2A Core 实施文档：`docs/A2A_CORE_DESIGN.md`  
> 说明：Control Plane 文档描述总体架构；A2A Core 文档描述当前仓库可落地的最小能力边界与接口契约。

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

1. OpenClaw：强调多 Agent 隔离（workspace + state + sessions）与确定性路由（most-specific wins），并通过 `agentToAgent` + session tools 做“默认拒绝、显式放行”的 A2A 通道。
2. AutoGen：分层架构（Core/AgentChat/Extensions）清晰，适合借鉴“协议层与业务层分离”。
3. LangChain/LangGraph Supervisor：中心协调者 + 专业子代理，适合当前 `dobby` 作为 Control Plane 的角色。

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
2. OpenClaw Session Tools: https://docs.openclaw.ai/tools/session-tools
3. OpenClaw Configuration Reference (`tools.agentToAgent`, `tools.sessions.visibility`): https://docs.openclaw.ai/format/configuration-reference
4. Microsoft AutoGen (GitHub): https://github.com/microsoft/autogen
5. AutoGen Distributed Agent Runtime: https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/framework/distributed-agent-runtime.html
6. AutoGen Topic & Subscription: https://microsoft.github.io/autogen/0.4.6/user-guide/core-user-guide/core-concepts/topic-and-subscription.html
7. LangChain Supervisor/Subagents: https://docs.langchain.com/oss/javascript/langchain/multi-agent/subagents-personal-assistant
8. LangChain Handoffs: https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs

## 13. Control Plane 与 Domain Plane 交互方式对比（含 CLI + Skills）

### 13.1 统一对比维度

为避免“实现细节不同导致无法横向比较”，建议固定 8 个维度：

1. 契约显式性：接口是否可类型化、可版本化。
2. 可靠性语义：是否天然支持重试、幂等、恢复。
3. 可观测性：是否容易拿到结构化状态流与审计轨迹。
4. 耦合度：Control/Domain 是否强绑定同语言、同进程、同部署。
5. 延迟与吞吐：单次调用开销、并发扩展方式。
6. 安全边界：权限隔离、网络暴露面、最小权限执行。
7. 工程成本：接入/调试/运维复杂度。
8. 适配范围：单机脚本、多服务集群、跨团队协作的适配能力。

### 13.2 OpenClaw Multi-Agent 的 A2A 是怎么做的（重点补充）

OpenClaw 的 Agent-to-Agent 不是“任意代理互相自由调用”，而是“**受控 session 通道**”：

1. 入口是 session tools，而不是裸 RPC：主要通过 `sessions_send`（发消息）和 `sessions_spawn`（拉起会话）来做跨 Agent 协作。
2. A2A 默认关闭：需要显式开启 `tools.agentToAgent`，并配置 allowlist（哪些 source agent 可调用哪些 target agent）。
3. 会话可见性受策略约束：`tools.sessions.visibility` 支持 `self/tree/agent/all`，并可叠加 `allowAgents` 白名单，限制可见/可操作的 session。
4. 同步与异步都支持：`sessions_send` 可设置等待回复与超时；不等待时就是异步投递。
5. 循环与归因有保护：文档提供 ping-pong 回路上限配置，并在跨 session 消息中带 `inter_session` 归因字段，便于审计与调试。

对 `dobby` 的直接启发：

1. Control -> Domain 的调用通道应默认拒绝、按 allowlist 放行。
2. 运行单元要绑定会话/任务边界（避免“全局广播式”副作用）。
3. 归因字段（`traceId/runId/source`）应作为协议强制项，而不是可选项。

### 13.3 模式 A：Supervisor / Tool-Calling（同进程编排）

代表：LangChain Supervisor/HandOff、AutoGen AgentChat Teams（偏会话编排）。

交互形态：

1. Control Agent 在一次对话上下文中调用子 Agent（通常以“工具调用”抽象）。
2. 子 Agent 的结果直接回到主 Agent 继续推理。

优势：

1. 上手快，原型验证速度最快。
2. 对“同一用户会话内的多专家协作”很自然（问答、规划、解释）。
3. 调试链路短，开发体验好。

约束：

1. 跨进程/跨服务隔离弱，长任务可靠性一般依赖宿主自行补齐。
2. 幂等、重试、任务级状态机通常不是一等公民。
3. 当 Domain 变成独立团队维护时，契约治理压力增大。

最适场景：

1. 交互式 Copilot、助手对话、多专家短任务。
2. 单仓库、单团队、低运维门槛阶段。

### 13.4 模式 B：Job API（create/status/cancel，异步任务协议）

代表：当前文档第 6 节提议（也是 Control/Domain 解耦最清晰的通用模型）。

交互形态：

1. Control 发 `create_job`。
2. Domain 返回 `job_id` 并异步执行。
3. Control 通过 `get_job_status`/回调订阅状态，必要时 `cancel_job`。

优势：

1. 契约稳定、可版本化，跨语言/跨团队边界最清晰。
2. 天然适配“至少一次触发 + 幂等键”。
3. 易接入审计、重试、SLA、告警与配额策略。

约束：

1. 首次接入成本比同进程调用高（状态机、存储、超时分类都要做）。
2. 需要明确错误码、终态语义、取消语义。

最适场景：

1. 定时任务、批处理、分钟级到小时级长任务。
2. 多 Domain、多环境（dev/staging/prod）和长期演进。

### 13.5 模式 C：消息总线 / Pub-Sub（事件驱动协作）

代表：AutoGen Core Runtime 的 topic/subscription 与 distributed runtime 思路。

交互形态：

1. Control 与 Domain 通过主题发布/订阅消息。
2. 多个 worker/agent 消费并协同处理。

优势：

1. 扩展性强，天然支持 fan-out/fan-in。
2. 异步解耦好，适合高吞吐和跨节点分布式。

约束：

1. 语义一致性与时序调试复杂度高于 Job API。
2. 重放、去重、顺序保证、死信治理是额外工程负担。

最适场景：

1. 高并发事件处理、流水线式多阶段处理。
2. 需要把“Domain 能力”拆成多个微代理/微服务时。

### 13.6 模式 D：CLI + Skills（你提出的方案）

定义（建议精确定义）：

1. Domain Plane 以可执行 CLI 提供能力（`domain-agent run ...`）。
2. Control Plane 通过 skill 提示词知道“何时、如何调用该 CLI”。
3. 返回通过 stdout/stderr/exit code（可选 JSON）交付。

核心优势：

1. 接入快：Domain 团队只需交付 CLI，不必先做服务化。
2. 本地优先：非常适合单机、内网、无常驻服务场景。
3. 运维轻：无需先维护 API 网关、服务发现、鉴权网关。

核心风险（与 Job API 的本质差异）：

1. `skills` 是“软契约”（prompt 级），不是“强契约”（schema 级）。
2. 参数和返回若不结构化，长期容易漂移（版本兼容脆弱）。
3. 可观测性与取消语义默认较弱（除非显式补齐 runId/status 协议）。
4. 多租户隔离与权限治理难度高于独立服务协议。

最适场景：

1. 早期探索期：Domain 能力变化快，先验证价值再服务化。
2. 单团队可控环境：同仓库/同语言/同发布节奏。
3. 任务规模中小、并发低、可接受“本机进程级”可靠性。

不建议直接采用为长期主协议的场景：

1. 多团队独立发布、需要严格 SLA 与契约治理。
2. 高并发多租户、强隔离、强审计要求。

## 14. 场景选型矩阵（简化）

| 场景 | 推荐主模式 | 说明 |
| --- | --- | --- |
| 单会话多专家协作（实时对话） | A Supervisor/Tool-Calling | 交互自然、延迟低、迭代快 |
| 定时批处理（日报/周报/发布流水线） | B Job API | 幂等、重试、取消、状态机最清晰 |
| 高吞吐事件流水线（多阶段异步） | C Pub-Sub | 扩展性强，但要有消息治理能力 |
| 本地快速落地（先跑起来） | D CLI + Skills | 接入最轻，但需尽快补强契约 |
| 跨 Agent 严格边界协作 | OpenClaw 式 A2A（session tools + allowlist） | 默认拒绝、显式放行，边界清晰 |

## 15. 对 dobby 的建议（务实路线）

建议采用“**B 为主，D 为辅**”的双层策略：

1. 统一内部抽象仍保持 `create_job/get_job_status/cancel_job`（即 B）。
2. 对于还未服务化的 Domain，提供 `CLIAdapter` 作为实现细节（即 D）。
3. skill 只负责“何时调用哪个能力”，不负责定义协议本身。
4. 协议真相放在 typed schema（TS 类型 + zod）而不是 prompt 文本。
5. Agent 间调用权限采用 allowlist 策略（借鉴 OpenClaw 的默认拒绝模型）。

这样能同时拿到：

1. 短期速度（CLI 快接入）。
2. 长期治理（Job 契约稳定演进）。
3. 迁移平滑（后续 CLI -> HTTP/gRPC 时，上层编排不改）。

## 16. 若采用 CLI + Skills，最小补强清单

至少补齐以下 6 项，才能把 D 从“demo 可用”提升到“生产可控”：

1. 固定输入输出协议：CLI 输入用 JSON 文件/JSON stdin；输出用 JSON lines（禁止纯自然语言）。
2. 强制携带标识：`plan_id/run_id/trace_id/idempotency_key` 全链路传递。
3. 退出码规范：`0` 成功；可重试失败与不可重试失败用不同 code。
4. 超时与取消：Control 维护进程组 + 超时 kill，并映射到 `cancelled/timed_out`。
5. 结构化日志：每次调用记录 command、duration、result size、stderr 摘要（脱敏）。
6. 版本协商：CLI 暴露 `--protocol-version`，Control 拒绝不兼容版本。

一个建议的 CLI 形态（示意）：

```bash
domain-agent run \
  --plan-id newsletter.daily \
  --run-id 2026-02-25T10:00:00Z \
  --trace-id trc_xxx \
  --idempotency-key plan:newsletter.daily:2026-02-25T10 \
  --input-json /tmp/dobby-input.json \
  --output-json /tmp/dobby-output.json
```

这时 `skills` 负责“如何选择该命令”，而 **Control Plane 代码** 负责“如何可靠执行该命令并解释其结果”。
