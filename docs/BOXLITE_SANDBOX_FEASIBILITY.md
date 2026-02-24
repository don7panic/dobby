# BoxLite 作为 Sandbox 的可行性评估（dobby）

更新时间：2026-02-17  
适用版本：`dobby` 当前 `main`、`@boxlite-ai/boxlite@0.2.11`

## 1. 评估目标

评估 `BoxLite` 是否可作为本项目当前 `sandbox` 后端（替代/补充 `host` 与 `docker`），并给出可执行的落地建议与风险边界。

本项目当前相关代码入口：

- `src/sandbox/executor.ts`：定义统一 `Executor` 接口，当前仅实现 `host`/`docker`，`boxlite` 分支抛错。
- `src/core/types.ts`：`SandboxConfig` 已包含 `backend: "boxlite"`。
- `src/core/routing.ts`：配置 schema 已支持 `sandbox.backend = "boxlite"` 和 `boxlite.workspaceRoot`。
- `src/agent/session-factory.ts`：工具调用统一走 `executor.exec(command, cwd, { timeoutSeconds, signal, env })`。

## 2. 结论摘要

### 2.1 总结论

`BoxLite` 作为本项目 sandbox **可行**，建议先走“本地嵌入式 BoxLite”路线，不建议当前阶段优先接入云端 REST/BoxRun 形态。

### 2.2 量化判断

- 本地嵌入式 BoxLite 可行度：`高（7.5/10）`
- 云端 REST/BoxRun API 可行度：`中（4.5/10）`

### 2.3 关键判断依据

- 架构对齐：本项目已预留 `boxlite` 配置分支，改造点集中在 `Executor` 实现层。
- 本机实测：在 macOS ARM64 环境中可成功执行 BoxLite 命令。
- 风险可控：主要风险集中在 Node 绑定中断语义与安装稳定性，可通过工程策略绕开。

## 3. 能力对齐分析

### 3.1 本项目 `Executor` 需要的能力

统一接口需求（来自 `src/sandbox/executor.ts`）：

- 输入：`command`, `cwd`, `timeoutSeconds`, `signal`, `env`
- 输出：`stdout`, `stderr`, `code`, `killed`

运行语义要求（由 `src/agent/session-factory.ts` 触发）：

- 可在指定工作目录执行 shell 命令
- 支持超时与中断
- 支持环境变量注入
- 输出可回传给上层工具调用

### 3.2 BoxLite 可提供的能力

从 BoxLite Node SDK/源码可确认：

- 支持创建隔离 box（micro-VM + OCI image）
- 支持执行命令、获取 stdout/stderr、返回退出码
- 支持 box 级 `workingDir`、`env`、`volumes`、资源限制
- 支持 execution 级 `kill()`（但见风险项）
- 支持 box 级 `stop()`（可用于强制回收）

结论：功能面可以覆盖 `Executor` 主需求。

## 4. 本机 PoC 实测结果（关键证据）

测试环境：

- OS：macOS 26.3, ARM64
- Docker：`28.5.2`（daemon 可访问）
- Node：`v22.16.0`

### 4.1 基础执行可用

在临时目录安装并执行：

- `SimpleBox(image=alpine:latest)` 执行 `echo boxlite-ok` 成功
- 返回：`exitCode=0`, `stdout=boxlite-ok`

### 4.2 性能观察

同一 box 内连续两条命令：

- 第一条：约 `172ms`
- 第二条：约 `1ms`

说明：复用同一 box 时，命令执行开销很低；启动成本主要在 box 首次创建阶段。

### 4.3 中断语义风险（重要）

在 Node 绑定实测中，出现以下行为：

- `execution.wait()` 进行中调用 `execution.kill()`，多次出现 `Failed to send signal`，长命令未按预期被 kill。
- 改用 `box.stop()` 可以中断正在执行的长命令（测试中约 1.4s 退出，`exitCode=-1`）。

结论：当前版本下应优先采用“box 级停止/重建”实现超时与 abort，不能假设 `execution.kill()` 始终可用。

### 4.4 安装稳定性风险

发现 npm optional dependency 场景下，`@boxlite-ai/boxlite` 可能找不到平台原生包（例如 `@boxlite-ai/boxlite-darwin-arm64`），会导致 `Cannot find native binding`。

结论：集成时需要明确安装/校验策略，避免运行时才暴露问题。

## 5. 主要风险与影响评估

| 风险项 | 级别 | 影响 | 缓解建议 |
|---|---:|---|---|
| `execution.kill()` 在 wait 期间不稳定 | 高 | `stop/abort` 不可靠，可能产生僵尸执行 | 使用 `box.stop()` + 按策略重建 box；避免并发共享 box |
| 原生包 optional dependency 安装不稳定 | 中 | 启动时报 native binding 缺失 | 启动前做依赖自检；CI/部署显式校验平台包 |
| 文档/API 形态存在演进（本地 SDK vs Cloud API） | 中 | 误选技术路径导致返工 | 当前阶段锁定本地 Node SDK 接口，Cloud API 作为后续 |
| box 级 stop 可能“连坐” | 中 | 若共享 box，会影响同 box 其他任务 | 采用每会话/每route隔离策略，或严格串行 |

## 6. 建议落地方案（当前项目）

### 6.1 推荐路线

优先实现 `BoxliteExecutor`（本地模式），保留 `DockerExecutor` 作为回退后端。

### 6.2 设计建议

- 执行模型：
  - 建议“每会话一个 box”或“每 route 一个 box + 严格串行”。
  - 不建议多会话高并发共享单 box（会放大 stop 连坐影响）。
- cwd 语义：
  - 保持与 `DockerExecutor` 一致，使用 `sh -lc "cd ... && <command>"` 语义对齐现有行为。
  - 或将 `workingDir` 固定为 `/workspace` 并通过 volume 映射 route `projectRoot`。
- 超时/中断：
  - 先实现“外层 timeout -> box.stop() -> 标记 killed -> 按需重建 box”。
  - 将 `execution.kill()` 作为可选优化，不作为正确性前提。
- 安全边界：
  - 保留现有 `projectRoot` 路径校验策略（不放宽）。
  - 映射目录最小化，必要时只挂载 route 对应工作目录。

### 6.3 分阶段实施

1. `P0`：新增 `src/sandbox/boxlite-executor.ts`，接入 `createExecutor` 分支。
2. `P1`：补充配置校验与启动前自检（原生 binding、镜像可用、workspace 映射）。
3. `P2`：实现 timeout/abort 的 box-stop 路径，保证语义闭环。
4. `P3`：压测与回归（串行执行、stop 指令、错误回写、重启恢复）。

## 7. 作为决策依据的“准入门槛”

将以下项全部满足后，才建议把 `boxlite` 作为默认 sandbox：

1. `npm run check` 与 `npm run build` 均通过。
2. 真实 Discord 链路下，`@bot` 消息可稳定得到响应。
3. `stop` 指令可在可接受时延内中断执行（建议 < 3s）。
4. 超时任务不会残留活跃执行（无僵尸进程累积）。
5. 关键错误可观测（日志中可区分运行错误、超时中断、环境故障）。

## 8. 参考来源

官方/源码（primary sources）：

- BoxLite 主仓库 README  
  https://github.com/boxlite-ai/boxlite/blob/main/README.md
- Node SDK 包定义  
  https://github.com/boxlite-ai/boxlite/blob/main/sdks/node/package.json
- Node `SimpleBox` 实现  
  https://github.com/boxlite-ai/boxlite/blob/main/sdks/node/lib/simplebox.ts
- Node 执行控制实现（`wait/kill`）  
  https://github.com/boxlite-ai/boxlite/blob/main/sdks/node/src/exec.rs
- Node API Reference  
  https://github.com/boxlite-ai/boxlite/blob/main/docs/reference/nodejs/README.md
- AI Agent Integration Guide  
  https://github.com/boxlite-ai/boxlite/blob/main/docs/guides/ai-agent-integration.md
- Cloud Sandbox OpenAPI  
  https://github.com/boxlite-ai/boxlite/blob/main/openapi/rest-sandbox-open-api.yaml
- Reference Server 说明  
  https://github.com/boxlite-ai/boxlite/blob/main/openapi/reference-server/README.md

本仓库对接点：

- `src/sandbox/executor.ts`
- `src/core/types.ts`
- `src/core/routing.ts`
- `src/agent/session-factory.ts`
- `src/sandbox/docker-executor.ts`
