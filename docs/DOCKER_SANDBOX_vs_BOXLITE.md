# Docker Sandboxes vs BoxLite 选型方案（面向 `im-agent-gateway`）

## 简要结论
1. 结论：在你当前架构下，主选 `BoxLite`，保留现有 `docker` 后端作为回退；`Docker Sandboxes` 仅作为“开发机交互调试工具”可选。
2. 原因：你的核心执行面是程序化 `Executor.exec(command, cwd, timeout, signal, env)`，而不是交互式 agent CLI。`BoxLite` 与此接口天然更贴合。
3. 你的目标是“本地 agent 更谨慎访问文件系统 + 可自由试错”，`BoxLite` 更容易做强边界（只挂载 route/projectRoot）和可恢复试错（每会话/每路由生命周期控制）。

## 横向对比（与当前架构相关）
| 维度                       | Docker Sandboxes                                                   | BoxLite                                             |
| -------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| 产品定位                   | 面向 AI agent 工作流（Docker Desktop 体验优先）                    | 面向可嵌入式 sandbox runtime（SDK/程序化优先）      |
| 接入方式                   | 以 `docker sandbox ...` CLI/工作流为主                             | Node/Python/Rust SDK 直接嵌入业务代码               |
| 运行模式                   | 本地模式 + 云模式（但本地模式对 Codex/Claude，云模式支持矩阵不同） | 本地优先；另有 BoxRun（local/hybrid/serverless）    |
| 隔离模型                   | 每个 sandbox 私有 Docker daemon；但文档明确仍继承用户系统权限边界  | micro-VM 硬件级隔离，库嵌入，无常驻 daemon          |
| 文件系统策略               | workspace 同步/映射友好，适合交互开发                              | volume/workingDir 精细控制，适合 route 级边界治理   |
| 网络治理                   | 有网络策略机制                                                     | 可通过 security/network 选项约束（按 SDK/平台能力） |
| 稳定性表态                 | 官方标注 Beta、非生产就绪                                          | 仍属快速演进项目，但更偏 SDK 生产集成路径           |
| 与你当前 `Executor` 贴合度 | 中（需要 CLI 编排层转译）                                          | 高（可直接实现 `BoxliteExecutor`）                  |

## 针对当前架构的最终选型
1. 主选：`BoxLite` 作为新 sandbox backend。
2. 保留：`docker` backend 继续存在，作为回退与兼容路径。
3. 不选主路径：`Docker Sandboxes` 不进入 `Executor` 主执行链路，仅用于开发者本机交互调试（可选）。

推断说明：该结论基于你当前接口与调用链  
`/Users/oasis/workspace/im-agent-gateway/src/sandbox/executor.ts:5`、`/Users/oasis/workspace/im-agent-gateway/src/sandbox/executor.ts:18`、`/Users/oasis/workspace/im-agent-gateway/src/agent/session-factory.ts:168`、`/Users/oasis/workspace/im-agent-gateway/src/core/types.ts:109`。

## 决策后实施规格（decision-complete）

## 1) 公共接口/类型变更
1. 保持 `Executor` 接口不变：`exec(command, cwd, options)` 与 `close()`。
2. 扩展 `SandboxConfig.boxlite`（当前仅 `workspaceRoot`）为可运营字段集合：`image`、`cpus`、`memoryMib`、`containerWorkspaceRoot`、`reuseMode`、`autoRemove`、`securityProfile`。
3. 默认值：
`image=alpine:latest`，`containerWorkspaceRoot=/workspace`，`reuseMode=conversation`，`securityProfile=maximum`。

## 2) 执行语义
1. 每个 conversation key 绑定一个 box（默认），避免跨会话“stop 连坐”。
2. 仅挂载该 route 的 `projectRoot` 到 box 内 `/workspace`。
3. 命令执行统一 `sh -lc "cd <guest-cwd> && <command>"`，保持与现有 DockerExecutor 行为一致。
4. timeout/abort 策略：
超时或 `AbortSignal` 触发时，不依赖 `execution.kill()`；直接 `box.stop()`，返回 `killed=true`，并重建该 conversation box。

## 3) 失败模式处理
1. 启动时原生 binding 缺失：fail fast，错误信息必须带安装修复建议。
2. box stop 失败：记录 error，强制丢弃 runtime 引用，下一次 exec 全新建 box。
3. cwd 越界：继续沿用现有 `assertWithinRoot` 逻辑，直接拒绝执行。

## 4) 测试与验收场景
1. 路由隔离：A/B 两个 route 不可跨目录读写。
2. 中断能力：长命令在 stop 后 3 秒内结束并回报 `killed=true`。
3. 超时恢复：超时后下一条命令可在新 box 成功执行。
4. 并发安全：同 conversation 串行，不出现队列错乱。
5. 依赖健壮性：缺失 native 包时启动即报错，不在运行中才崩溃。

## 5) rollout 方案
1. `sandbox.backend=boxlite` 先在单 route 灰度，其他 route 保持 `docker`。
2. 收集 7 天指标：超时率、中断成功率、命令失败率、平均执行延迟。
3. 达标后扩大到全部 route；未达标自动回退 `docker`。

## 假设与默认
1. 你的主要场景是“本地 agent 的程序化执行安全”，不是“Docker Desktop 交互体验优先”。
2. 本机具备 virtualization 与 Docker 基础环境。
3. 当前优先级是“文件系统边界可控 + 可试错恢复”，高于“零改造接入”。

## 主要依据（sources）
1. [Docker Sandboxes Overview](https://docs.docker.com/ai/sandboxes/)
2. [Docker Sandboxes Architecture](https://docs.docker.com/ai/sandboxes/architecture/)
3. [Docker Sandboxes Supported Agents](https://docs.docker.com/ai/sandboxes/supported-agents/)
4. [Docker Sandboxes Get Started](https://docs.docker.com/ai/sandboxes/get-started/)
5. [Docker Sandboxes Workflows](https://docs.docker.com/ai/sandboxes/workflows/)
6. [Docker Sandboxes Network Policies](https://docs.docker.com/ai/sandboxes/network-policies/)
7. [Docker Sandboxes Advanced](https://docs.docker.com/ai/sandboxes/advanced/)
8. [BoxLite Introduction](https://docs.boxlite.ai/introduction)
9. [BoxLite BoxRun](https://docs.boxlite.ai/concepts/boxrun)
10. `/Users/oasis/workspace/im-agent-gateway/docs/BOXLITE_SANDBOX_FEASIBILITY.md:19`
11. `/Users/oasis/workspace/im-agent-gateway/src/sandbox/executor.ts:5`
12. `/Users/oasis/workspace/im-agent-gateway/src/agent/session-factory.ts:168`
