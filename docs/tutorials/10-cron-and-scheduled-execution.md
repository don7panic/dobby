# 教程 10：为什么 Cron 是新入口，而不是第二条执行链

上一篇把工具房搭好了，这一篇给 dobby 挂个闹钟。

但先说在前面：闹钟负责叫它起床，不负责再克隆一只新小精灵出来单独干活。

很多宿主系统做到后面，都会冒出一个诱惑：“既然要支持定时任务，不如直接再写一套 cron 专用执行逻辑。”
这条路短期很顺，长期往往是给未来的自己挖坑。

## 先看 cron 这一层到底负责什么

它现在主要负责：

- 解析和加载 cron 配置
- 维护 job store
- 维护 run log
- 定时 tick 并挑出 due job
- 控制并发和失败退避
- 把每次 run 重新送回 Gateway

注意最后一点：

cron 只负责“什么时候触发”，不负责“怎么执行主链”。

这就是这层架构最关键的判断。

## 配置加载顺序，为什么要先讲

对计划任务来说，配置路径如果不稳定，整个系统就会显得很玄学。

当前 cron 配置路径的优先级是：

1. `--cron-config`
2. `DOBBY_CRON_CONFIG_PATH`
3. 与 gateway 配置同目录下的 `cron.json`
4. fallback 到 `<data.rootDir>/state/cron.config.json`

并且如果目标文件不存在，系统会自动创建默认配置。

这套策略很务实，因为它同时满足了两类场景：

- 开发 / 本地仓库场景：配置和 gateway 放在一起
- 长期运行场景：没有仓库配置也能落到 state 目录里自举起来

## Job 模型为什么不是“只有一个 cron 表达式”

当前 job schedule 支持 3 种形态：

- `at`
- `every`
- `cron`

delivery 也单独拆成结构：

- `connectorId`
- `routeId`
- `channelId`
- `threadId?`

这套设计的意思其实很直白：

- schedule 决定“什么时候跑”
- delivery 决定“跑完发到哪里”
- prompt 决定“这次跑什么”

只要这三件事没混在一起，CLI 的 add / update / pause / resume 语义就会清楚很多。

## `CronService` 为什么选 polling，而不是更花哨的调度模型

在 `dobby` 里，CronService 采用的是很保守的 polling 方案。它不花哨，但像厨房里那个老闹钟一样稳：

- `start()` 先 load store，再 recoverOnStartup
- 按 `pollIntervalMs` 定时 request tick
- 每次 tick 都重新从磁盘 load store
- 选出 due job 后按 `maxConcurrentRuns` 控制并发

这套方案不炫，但非常适合当前宿主的运行模型。因为：

- CLI 可能在另一个进程里修改 cron store
- 常驻 gateway 需要及时看到这些修改
- 本地宿主项目比起“极致调度精度”，更在乎语义稳定和可诊断

所以当前实现宁可每次 tick 都重新 load，也不赌跨进程状态同步不会出问题。

## 启动恢复、补跑、失败退避，才是 cron 最容易翻车的地方

cron 真正难的地方通常不在“会不会响铃”，而在这些边角：

- 进程重启时，之前 running 的 job 怎么办
- 错过的任务要不要补跑
- 连续失败后下一次什么时候再试

当前实现里：

- `recoverOnStartup()` 会清理 stale running 状态
- `runMissedOnStartup` 控制是否把错过的任务补成 `now`
- 非 `at` 任务在失败后会按 `computeBackoffDelayMs(...)` 退避重试

这些语义如果不先想清楚，cron 很容易变成“平时看着正常，重启和异常后全乱”。

## `cron run` 为什么只是排队，而不是自己直接执行

这是当前实现里一个非常好的选择。

CLI 的 `dobby cron run <jobId>` 并不会直接把 job 跑起来，而是把：

- `manualRunRequestedAtMs`

写进 store。之后由长驻 scheduler 在下一轮 tick 里读到它，再真正入队。

这样做的好处非常实在，像把所有闹钟记录都记在同一本值班簿上：

- CLI 和长进程不会各跑各的
- 所有 run 都还能统一进 run log
- 并发限制、失败退避、状态更新都只在一处生效

这也是“调度状态管理”和“任务执行主链”分离的典型体现。

## 真正执行时，cron 是怎么复用 Gateway 的

当前 `executeJobRun(...)` 里最关键的一段其实非常短：

```ts
await gateway.handleScheduled({
  jobId: job.id,
  runId: run.runId,
  prompt: job.prompt,
  connectorId: job.delivery.connectorId,
  routeId: job.delivery.routeId,
  channelId: job.delivery.channelId,
  threadId: job.delivery.threadId,
  timeoutMs: config.jobTimeoutMs,
})
```

然后 Gateway 内部会把它翻成 synthetic inbound，再按下面这些语义跑：

- `routeIdOverride`
- `conversationKeyOverride: 'cron:<runId>'`
- `stateless: true`
- `sessionPolicy: 'ephemeral'`
- `includeReplyTo: false`

这意味着：

- scheduled run 也走同一套 route / provider / executor / Event Forwarder 链路
- 但它不会复用聊天对话上下文
- 也不会把结果当成用户消息 reply 回去

这就是“同一条主链，不同入口语义”的正确打开方式。

## Store 和 run log 为什么要分开

当前 cron 状态存储分成两份：

- job store：保存 job 定义和当前状态
- run log：按行追加每次运行记录

这种拆法特别适合诊断，因为它把两个不同问题拆开了：

- “现在它应该什么时候跑、是不是启用状态” -> 看 job store
- “它过去到底跑没跑、失败了没有” -> 看 run log

如果你把这两类信息挤在一个结构里，后面要么读性能差，要么历史记录很快变得难处理。

## 什么时候该改 cron 层，什么时候不该改

这些问题通常优先改 cron：

- schedule 类型和计算逻辑
- 补跑 / 失败退避策略
- job 状态字段
- run log 记录方式
- `cron run` / `pause` / `resume` 的语义

而这些问题一般不该先改 cron：

- scheduled run 进主链后的消息处理顺序 -> Gateway
- route 上下文怎么解析 -> Routing
- 输出消息怎么编辑 / 拆分 -> Event Forwarder

## 结论

`dobby` 的 cron 层最聪明的地方，不是它“支持定时任务”，而是它把 cron 严格收成了一个新的触发入口，而不是第二套宿主执行系统。

这样后面所有增强都还是加法，而不是双份维护。

下一篇我们回到整套教程的收尾：把这些模块细节重新放回时间线里，看看一个 openclaw 项目更稳妥的演进顺序到底是什么。
