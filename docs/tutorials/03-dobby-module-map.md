# 教程 03：dobby 模块地图

前两篇已经让 dobby 会接单、会跑腿了。接下来问题变成：它要是把盘子摔了，你该去厨房找锅，还是去前台找人？

这一篇先不给你塞满细节，而是先给你一张“庄园地图”。
后面的几篇会按模块拆开讲，包括边界划分、架构取舍，以及那些最容易把人绕晕的坑。

## 先把整套系统想成 7 个模块

你可以先别盯着目录，把 `dobby` 想成下面 7 个模块：

1. 控制面：启动、初始化、配置、诊断、扩展、计划任务命令
2. Gateway：统一编排入站消息和计划任务
3. Routing：把入口映射成可执行的上下文
4. Runtime：会话串行、取消、重置、会话归档
5. Event Forwarder：把 agent 事件翻译成 IM 平台能呈现的输出
6. 扩展与执行环境：Provider、Connector、Sandbox、HostExecutor
7. Cron：定时触发、状态存储、失败退避，但不自建第二条执行链

先把这 7 个名字记住。你也可以把它们想成前台、总台、任务卡、记事本、传话员、工具房和闹钟；后面读代码时会顺很多。

## 这 7 个模块各自解决什么问题

### 1. 控制面：系统怎么被人装起来

这一层解决的是“人怎么操作宿主”，不是“消息怎么执行”。

它负责：

- 读配置并决定从哪里启动
- 初始化本地目录和 starter 配置
- 管理扩展安装 / 启用状态
- 启动 Gateway 和 Cron
- 输出诊断结果和运行状态快照

如果这里写散了，用户很快就会进入经典状态：配置找不到、扩展装不明白、进程到底活着没也只能靠猜。

详细版看：[04-building-a-usable-cli.md](./04-building-a-usable-cli.md)

### 2. Gateway：真正的主链路中枢

这一层解决的是“收到一条消息以后，宿主到底按什么顺序处理它”。

它负责把这些步骤串成一条稳定主链：

- 去重
- route resolve
- 控制命令识别
- mention 策略
- runtime 获取或创建
- prompt payload 构造
- Event Forwarder 驱动输出
- 错误回写

如果这里没有守住边界，逻辑就会开始泄漏到 Connector 或 Provider 里，后面每接一个平台、每换一个 agent 都会返工。

详细版看：[05-gateway-orchestration.md](./05-gateway-orchestration.md)

### 3. Routing：入口映射为什么不能只是“频道 ID 对项目目录”

Routing 真正解决的不是“配文件”，而是“执行上下文从哪来”。

它至少要回答：

- 这条消息属于哪条 route
- route 用哪个 provider
- route 用哪个 sandbox / executor
- tools 权限是什么
- mention 策略是什么

如果这里没拆清楚，配置一多，入口映射、执行策略、平台差异就会全混在一起。

详细版看：[06-routing-and-config-model.md](./06-routing-and-config-model.md)

### 4. Runtime：对话型系统的状态地基

只要系统支持“同一个聊天里连续多轮交互”，这一层就跑不掉。

它负责：

- 同会话串行
- runtime 复用
- `/cancel`、`stop` 这种取消语义
- `/new`、`/reset` 这种新会话语义
- 新会话切换时的 session archival 约束

如果少了这一层，第一版也许还能跑，但只要用户连续发两条消息，顺序、取消、重置都会一起变乱。

详细版看：[07-runtime-lifecycle.md](./07-runtime-lifecycle.md)

### 5. Event Forwarder：为什么流式体验不能随手写在 Provider 里

agent 内部会产生 delta、tool 事件、status，但 IM 平台并不直接理解这些抽象。

Event Forwarder 负责：

- 按 connector `updateStrategy` 做 `edit` / `append` / `final_only`
- 处理 progress 消息
- 处理 tool side message
- 文本截断和拆分
- 在 finalize 时把消息状态收干净

如果这一层没有单独站住，输出体验很快就会变成“哪个 Provider 恰好怎么回事件，就怎么展示”。

详细版看：[08-event-forwarder-and-streaming.md](./08-event-forwarder-and-streaming.md)

### 6. 扩展与执行环境：宿主为什么能保持瘦

当 Provider、Connector、Sandbox 开始变多时，宿主如果还把所有实现塞在自己体内，很快就会失控。

这一层的目标是：

- 宿主只认 contribution 契约
- 具体实现通过扩展包接入
- route 只引用实例 ID，不关心包从哪来
- sandbox 只暴露 executor 能力，不把实现细节漏给 Gateway

如果你想新增一种 agent、接新 IM 平台、把执行环境换成 boxlite / docker，最终都要落回这一层。

详细版看：[09-extension-system-and-execution.md](./09-extension-system-and-execution.md)

### 7. Cron：新增入口，但不新增主链

`cron` 最值得学的点不是“它会定时”，而是“它没有自建第二条执行链”。

它真正负责的是：

- 保存 job 定义和运行状态
- 在 tick 中挑出 due job
- 控制并发、补跑和失败退避
- 把 scheduled run 重新送进 Gateway

说白了，cron 只是新的触发方式，不是新的执行架构。

详细版看：[10-cron-and-scheduled-execution.md](./10-cron-and-scheduled-execution.md)

## 为什么要按这套方式拆

这套拆法背后其实有几个很朴素的判断：

- 平台差异停在 Connector，不要流进 Gateway
- 执行上下文交给 Routing，不要让 Connector 私有配置偷偷承载 route
- 会话状态交给 Runtime，不要让 Provider 和 Gateway 互相猜当前会话是谁
- 输出体验交给 Event Forwarder，不要让 Provider 直接知道 Discord / Feishu 的消息更新策略
- 新能力通过扩展接入，不要让宿主为了多支持一个 provider 就改核心主链
- 新入口尽量复用 Gateway，不要为了 cron 再复制一套“看起来差不多”的执行流程

你会发现，这几条其实都在做同一件事：让变化被关在自己的层里。

## 这组模块深潜，应该怎么读

如果你是第一次读这套代码，我建议按下面顺序：

1. 先看 [04-building-a-usable-cli.md](./04-building-a-usable-cli.md)
   - 先明白系统是怎么被装起来的。
2. 再看 [05-gateway-orchestration.md](./05-gateway-orchestration.md)
   - 先把主链路中枢看懂。
3. 再看 [06-routing-and-config-model.md](./06-routing-and-config-model.md)
   - 把“消息为什么会跑到这个上下文里”看懂。
4. 然后看 [07-runtime-lifecycle.md](./07-runtime-lifecycle.md) 和 [08-event-forwarder-and-streaming.md](./08-event-forwarder-and-streaming.md)
   - 这两篇决定真正的对话体验。
5. 最后看 [09-extension-system-and-execution.md](./09-extension-system-and-execution.md) 和 [10-cron-and-scheduled-execution.md](./10-cron-and-scheduled-execution.md)
   - 这两篇讲的是系统怎么持续长大，而不是只在第一版能跑。

如果你只是想排某一类问题，也可以直接跳：

- 启动、配置、扩展安装有问题：看 04
- 消息没进主链、回包逻辑不对：看 05
- 跑错项目目录、默认值继承不对：看 06
- `/cancel`、`/reset`、上下文串行有问题：看 07
- 流式输出、tool 状态、消息拆分有问题：看 08
- 新增 provider / connector / sandbox：看 09
- cron 不触发、手动运行不生效、状态乱：看 10

## 结论

模块地图的价值，不是让你背目录；而是让你在碰到问题时，先判断该去修厨房、前台、工具房，还是总台。

从下一篇开始，我们按这张地图逐间看房：先从控制面讲起，看看为什么 `dobby` 的 CLI 不是包装层，而是宿主的一部分。
