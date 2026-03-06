# dobby Teamwork Handoff Loop 技术方案（Draft）

> 状态：Draft / 待 Review  
> 日期：2026-03-06  
> 范围：单机单进程 `dobby`，Discord-first，多 bot 串行协作  
> 相关代码：`src/core/gateway.ts`、`src/core/runtime-registry.ts`、`plugins/connector-discord/src/connector.ts`

---

## 1. 背景与目标

`dobby` 当前的主执行模型是“单条入站消息 -> 单 route runtime -> 串行执行 -> 回写 connector”。  
在多 bot 场景下，现有能力更接近“一个 bot 完成一轮响应”，缺少“任务级多轮协作”。

本方案目标是引入 **Teamwork Handoff Loop（v1）**：

1. 用户发起消息可创建一个 `Task`。
2. Task 在多个 bot（角色 route）之间串行 `handoff`。
3. 支持 `complete` 与 `cancel` 终止语义。
4. 支持 `maxRound` 与 `maxPingPong` 防止无限循环。
5. 用户可通过 `stop` 取消当前 Task，并级联中断执行中的 actor。

---

## 2. 非目标

本版不包含以下能力：

1. 多 Task 并发（同会话仅单活跃 Task）。
2. 图编排 DSL / 可视化工作流编辑器。
3. 分布式多节点 Team Runtime。
4. 跨会话共享 Task 状态。
5. “任意 bot 消息均可触发”开放模式（需 trusted gating）。

---

## 3. 当前架构约束与改造边界

### 3.1 现状约束

1. `Gateway.handleInbound` 以消息为单位处理，按 route 选择 provider/runtime，单次 prompt 完成后结束该轮处理。  
   参考：`src/core/gateway.ts`
2. `RuntimeRegistry` 以 conversation key 串行排队，不提供 task-level 状态机。  
   参考：`src/core/runtime-registry.ts`
3. Discord connector 默认忽略 bot 消息（`if (message.author.bot) return`）。  
   参考：`plugins/connector-discord/src/connector.ts`

### 3.2 改造边界

1. 保持扩展系统 v3 边界不变（provider/connector/sandbox contribution 机制不变）。
2. 不依赖 bot-to-bot “纯聊天回环”直接替代状态机；仍由 Host 维护 task 状态。
3. 在 v1 中优先保障“可控 + 可观测 + 可取消”，再优化“更自然语言”的 handoff 体验。

---

## 4. 核心术语与状态机

### 4.1 术语

1. **Task**：一次从用户消息触发的协作任务执行单元。
2. **Active Actor**：当前被授权推进 Task 的 route/bot。
3. **Round**：每发生一次有效 `handoff`，round +1。
4. **PingPong Pair**：同一对 route 的来回跳转（`A->B->A`）计数单元。
5. **Conversation Scope**：`connectorId + platform + accountId + chatId + threadId(root)`。

### 4.2 Task 状态机

状态定义：

1. `running`
2. `completed`
3. `cancelled`
4. `failed`
5. `max_round_exceeded`
6. `pingpong_exceeded`
7. `timed_out`（预留）

状态约束：

1. Task 创建即 `running`。
2. 终态不可逆。
3. `cancel` 对终态幂等成功。

---

## 5. 协议语义（start / handoff / complete / cancel）

### 5.1 start（用户消息创建 Task）

触发条件：

1. 消息作者是用户（非 bot）。
2. 同一会话没有 `running` Task（单活跃约束）。
3. 消息满足“`@ 且仅 @ 一个团队 bot`”。

结果：

1. 创建 `Task`，`activeRouteId = 被@bot对应route`。
2. 该 route 作为第一位 actor 继续执行。

### 5.2 handoff（actor -> actor）

触发条件：

1. 来源消息作者为 trusted bot。
2. 来源 route 必须等于当前 `activeRouteId`。
3. 消息 `@` 到一个目标 bot。
4. 目标 route 在 `allowHandoffTo` 白名单内。

语义：

1. `activeRouteId` 切换到目标 route。
2. `currentRound += 1`。
3. 更新 pair bounce 计数（用于 pingpong 上限判定）。

### 5.3 complete

触发条件：

1. 当前 active actor 明确给出“任务完成”意图（由 intent extractor 判定）。

语义：

1. Task 进入 `completed`。
2. 记录 `complete` 事件并回写最终摘要。

### 5.4 cancel

触发条件：

1. 用户发送 `stop`；或
2. 当前 active actor 发出 cancel 意图（受策略控制）。

语义：

1. Task 进入 `cancelled`。
2. 级联中断当前 runtime（调用 `runtimeRegistry.abort`）。

---

## 6. 配置模型（文档规范）

### 6.1 `GatewayConfig.teamwork`（新增）

建议结构：

```json
{
  "teamwork": {
    "enabled": false,
    "maxRoundPerTask": 12,
    "maxPingPongPerPair": 4,
    "singleActiveTaskPerConversation": true,
    "taskIntentTimeoutMs": 300000
  }
}
```

字段语义：

1. `enabled`：全局开关，默认 `false`。
2. `maxRoundPerTask`：单 Task handoff 上限，默认 `12`。
3. `maxPingPongPerPair`：单 route pair 来回上限，默认 `4`。
4. `singleActiveTaskPerConversation`：同会话单活跃 Task，默认 `true`。
5. `taskIntentTimeoutMs`：Task 意图推进超时阈值，默认 `300000`。

### 6.2 `RouteProfile.a2a`（新增）

建议结构：

```json
{
  "a2a": {
    "enabled": false,
    "allowHandoffTo": []
  }
}
```

字段语义：

1. `enabled`：该 route 是否允许参与 handoff。
2. `allowHandoffTo`：可 handoff 到的目标 route 列表。

### 6.3 Discord connector 配置扩展（新增）

建议结构：

```json
{
  "allowBotMessages": false,
  "trustedBotUserIds": []
}
```

字段语义：

1. `allowBotMessages=false` 时保持现状（忽略 bot 消息）。
2. 开启后仅处理 `trustedBotUserIds` 中 bot 的消息。
3. 无论如何都忽略“自己发出的消息”。

---

## 7. 处理流程（用户入口 / bot入口 / 跳转 / 终态）

### 7.1 用户消息入口

1. Gateway 收到用户消息并完成 dedup + route resolve。
2. 若 teamwork 关闭，按现有单轮逻辑执行。
3. 若 teamwork 开启，先检查当前会话是否已有 `running` Task。
4. 若无 running Task 且消息满足 `@且仅@一个团队bot`，创建 Task 并进入 actor 执行。

### 7.2 bot 消息入口

1. connector 在 `allowBotMessages=true` 时接收 bot 消息。
2. 非 trusted bot 直接忽略并记 debug 日志。
3. 有 running Task 时，交由 `HandoffIntentExtractor` 判定意图：
   - `handoff`：推进 active actor
   - `complete`：终止 Task
   - `cancel`：取消 Task
   - `none`：仅记录日志，不推进状态

### 7.3 终态判定

1. `currentRound > maxRoundPerTask` -> `max_round_exceeded`。
2. pair bounce 超阈值 -> `pingpong_exceeded`。
3. 用户/actor cancel -> `cancelled`。
4. actor complete -> `completed`。

---

## 8. 防回环策略

核心策略组合：

1. **Round 上限**：每次有效 handoff +1，超过阈值立即终止。
2. **PingPong 上限**：针对 `A->B->A` 回环做 pair-level 限制。
3. **Actor Ownership**：仅 active actor 的消息可推进 Task。
4. **AllowList**：handoff 目标 route 必须命中 `allowHandoffTo`。

---

## 9. 持久化与恢复

### 9.1 数据模型（v1）

```ts
type TeamTaskStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "max_round_exceeded"
  | "pingpong_exceeded"
  | "timed_out";

type TeamTask = {
  taskId: string;
  conversationKey: string;
  status: TeamTaskStatus;
  activeRouteId: string;
  starterUserId: string;
  currentRound: number;
  pairBounceCount: Record<string, number>;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number;
  lastError?: string;
};

type TaskEventType = "start" | "handoff" | "complete" | "cancel" | "reject" | "timeout";

type TaskEvent = {
  taskId: string;
  eventType: TaskEventType;
  fromRouteId?: string;
  toRouteId?: string;
  messageId: string;
  reason?: string;
  timestampMs: number;
  traceId: string;
};
```

### 9.2 存储路径

1. `data/state/teamwork-tasks.json`
2. `data/state/teamwork-events.jsonl`

### 9.3 恢复规则

1. 进程重启时加载 task store。
2. 对 `running` task 执行恢复判定：
   - 若最近无活动且超过 `taskIntentTimeoutMs`，标记 `timed_out`。
   - 否则保留 `running` 并等待下一条有效消息推进。

---

## 10. 安全与权限

1. 默认拒绝 bot 消息触发（`allowBotMessages=false`）。
2. 仅信任 `trustedBotUserIds` 内 bot。
3. 仅 active actor 可推进 task。
4. 仅允许 `allowHandoffTo` 白名单目标。
5. 越权 handoff 返回拒绝事件并记录审计日志。

---

## 11. 可观测性

建议每次 Task 事件统一记录：

1. `taskId`
2. `traceId`
3. `conversationKey`
4. `eventType`
5. `fromRouteId`
6. `toRouteId`
7. `status`
8. `reason`
9. `durationMs`（终态时）

日志等级建议：

1. `info`：start/handoff/complete/cancel。
2. `warn`：reject/max_round_exceeded/pingpong_exceeded/timed_out。
3. `error`：状态持久化失败、runtime abort 失败、未捕获异常。

---

## 12. 错误处理与降级

1. 意图无法判定（`none`）：不推进状态，仅日志记录。
2. @目标 bot 无映射 route：写入 reject 事件并提醒 actor。
3. handoff 目标未授权：写入 reject 事件并提醒 actor。
4. 当前无 running Task 收到 bot 消息：忽略并日志记录。
5. runtime 中断失败：保留 cancelled 终态，并记录 error。

---

## 13. 实施分期

### Phase 1（MVP）

1. `TaskStore`（task + event 持久化）。
2. `TaskCoordinator`（状态推进、权限判定、回环限制）。
3. Discord connector trusted bot 接入。
4. 用户 `stop` 升级为 task cancel 语义。

### Phase 2（稳定性）

1. 更强 `HandoffIntentExtractor` 规则（多语言、歧义收敛）。
2. 重启恢复增强与超时治理。
3. CLI 诊断：`task list` / `task show`（提案）。

### Phase 3（体验增强）

1. 任务进度摘要与阶段性提示。
2. 人工介入指令（例如 approve/force-handoff）。
3. 并发能力预留（仍默认关闭）。

---

## 14. 验收标准与测试矩阵

1. 用户 `@` 单 bot 可创建 Task。
2. 同会话已有 running Task 时，第二个创建请求被拒绝或提示等待。
3. trusted bot 的有效 handoff 可推进 active actor。
4. untrusted bot 消息被忽略。
5. 非 active actor 的 bot 消息被忽略。
6. 越权 handoff 被拒绝并记录事件。
7. 超过 `maxRoundPerTask` 自动终止。
8. 超过 `maxPingPongPerPair` 自动终止。
9. 用户 `stop` 后 Task 进入 `cancelled` 且 runtime 被中断。
10. 重启后可恢复并查询历史 Task 状态。
11. 可复现“review 不通过 -> impl 修复 -> review 通过 -> complete”闭环。
12. 意图解析失败时不推进状态，仅记录日志。

---

## 15. Public API / 接口变更清单（用于后续实现）

1. `src/core/types.ts`：
   - 新增 `GatewayConfig.teamwork`
   - `RouteProfile` 新增 `a2a`
   - `InboundEnvelope` 新增 `authorIsBot`
   - `InboundEnvelope` 新增 `mentionedUserIds`
2. `src/core/routing.ts`：
   - 新增 teamwork schema 与默认值
   - 新增 route `a2a` schema 与引用校验
3. `plugins/connector-discord`：
   - 新增 `allowBotMessages`
   - 新增 `trustedBotUserIds`
   - 保留“忽略自己消息”
4. 新增核心模块（v1 提案）：
   - `TaskStore`
   - `TaskCoordinator`
   - `HandoffIntentExtractor`
5. `stop` 语义升级：
   - 从“仅 runtime abort”扩展为“cancel active task + 级联中断”

---

## 16. 默认假设（v1）

1. `teamwork.enabled=false`（显式开启才生效）。
2. `allowBotMessages=false`（显式开启且 trusted 列表非空才接收 bot 消息）。
3. `singleActiveTaskPerConversation=true`。
4. `maxRoundPerTask=12`。
5. `maxPingPongPerPair=4`。
6. Task 入口策略：用户必须 `@` 且仅 `@` 一个团队 bot。
7. 本版不支持多 Task 并发。
8. handoff 采用“`@目标bot + 自然语言`”并由 extractor 判定。

---

## 17. 开源参考与取舍

1. AutoGen：
   - 借鉴点：多 agent 轮转、终止条件可配置。
   - 取舍：不引入完整 team runtime，先做 host 内 task 状态机。
2. LangGraph / LangChain multi-agent：
   - 借鉴点：handoff + recursion limit 防无限循环。
   - 取舍：当前以 `maxRound`/`maxPingPong` 落地最小闭环。
3. OpenClaw：
   - 借鉴点：A2A 默认关闭、allowlist 显式放行、loop guard。
   - 取舍：保留“默认拒绝”策略，先做单进程可控能力。
4. CrewAI：
   - 借鉴点：角色分工与层级协作思路。
   - 取舍：不引入框架级 process DSL，以 route + policy 驱动。

参考链接：

1. https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html
2. https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/design-patterns/handoffs.html
3. https://docs.langchain.com/oss/javascript/langchain/multi-agent/handoffs
4. https://docs.langchain.com/oss/javascript/langgraph/errors/GRAPH_RECURSION_LIMIT
5. https://docs.openclaw.ai/tools
6. https://docs.openclaw.ai/gateway/configuration-reference
7. https://docs.crewai.com/en/concepts/processes
