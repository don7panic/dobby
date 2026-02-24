# Newsletter 项目总览（Brain 视角）

## 1. 背景与目标

你当前的定位是：`im-agent` 作为个人全局 Brain-Agent，代表用户在本机执行日常任务与跨项目协作。

Newsletter 项目的目标不是把 newsletter 实现塞进本仓库，而是建立一套清晰的跨 Agent 协作模式：

1. Brain-Agent 负责意图理解、策略编排与任务触发。
2. Newsletter-Agent 作为外部独立 Agent 负责领域执行。
3. 两者通过结构化契约协作，形成可追踪、可重放、可演进的工作流。

## 2. 范围与非目标

### 2.1 本文档范围

1. 给出 Newsletter 项目的业务目标与架构边界。
2. 明确 Brain-Agent 与 Newsletter-Agent 的职责划分。
3. 说明当前仓库保留哪些内容、外部仓库承接哪些内容。

### 2.2 非目标

1. 不在本仓库内实现 Newsletter-Agent 的业务代码。
2. 不在本仓库内实现采集、去重、渲染、发布等 newsletter 领域流程。
3. 不在本文档展开到代码级设计与函数级实现。

## 3. Brain-Agent 与 Newsletter-Agent 定位

### 3.1 Brain-Agent（Control Plane）

Brain-Agent 是用户的个人全局助手，负责：

1. 接收用户自然语言指令（例如“每天 10:00 发送 newsletter”）。
2. 维护策略层配置（计划、时区、触发条件、模式）。
3. 在调度触发时发起对 Domain Agent 的调用。
4. 汇总结果并回传给用户。

### 3.2 Newsletter-Agent（Domain Plane，外部部署）

Newsletter-Agent 是独立部署的外部领域 Agent，负责：

1. 执行 newsletter 领域流程。
2. 返回结构化状态与结果（job status / result / warnings / errors）。
3. 处理领域内可靠性策略（重试、降级、发布失败回执）。

## 4. 控制面 / 领域面摘要

推荐采用双平面架构：

1. `Control Plane`：面向“用户目标与任务编排”。
2. `Domain Plane`：面向“newsletter 业务执行”。
3. `Scheduler`：独立组件负责定时触发执行，避免把计时可靠性耦合进 Brain 推理主流程。

## 5. 高层调用链

```text
用户指令 -> Brain-Agent 解析与存储计划 -> Scheduler 定时触发
-> Brain-Agent 下发 create_job -> Newsletter-Agent 执行
-> Newsletter-Agent 回传 job_status/result -> Brain-Agent 汇总反馈给用户
```

## 6. 关键约束（概念层）

1. Discord 单条消息长度有限，发布侧必须支持拆分/降级。
2. 同一业务 run 需要幂等（避免重复发布与重复提交）。
3. 长任务必须可取消、可重试、可观测。
4. 领域执行失败时需返回结构化 warnings/errors，便于 Brain 做用户可读反馈。

## 7. 与当前仓库的关系

当前仓库（`im-agent-gateway`）只保留以下内容：

1. Brain 侧架构说明与协作契约。
2. 调用外部 Newsletter-Agent 的集成边界定义。
3. 与 Control Plane 相关的文档与约定。

当前仓库不承接以下内容：

1. Newsletter-Agent 的业务流程实现。
2. Newsletter-Agent 的部署与运行时维护。
3. 领域执行链路中的模块开发任务。

## 8. 文档导航

1. Control/Domain 架构拆解：`/Users/oasis/workspace/newsletter-agent/docs/NEWSLETTER_CONTROL_DOMAIN_ARCHITECTURE.md`
2. 外部仓库任务交接：`/Users/oasis/workspace/newsletter-agent/docs/NEWSLETTER_EXTERNAL_REPO_HANDOFF.md`

## 9. 文档级契约（摘要）

为支持跨 Agent 协作，保留以下文档级接口语义：

1. Brain -> Newsletter：`create_job`（创建异步任务）。
2. Brain -> Newsletter：`job_status`（查询任务状态）。
3. Brain -> Newsletter：`cancel_job`（取消正在执行的任务）。
4. Newsletter -> Brain：`result`（返回结构化结果、告警与错误摘要）。

详细字段定义与状态机见：
`/Users/oasis/workspace/newsletter-agent/docs/NEWSLETTER_CONTROL_DOMAIN_ARCHITECTURE.md`
