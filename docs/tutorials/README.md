# Tutorials

这组文档不是 API 参考，也不是一本正经的功能清单。

你可以把它当成一套“把 `dobby` 调教成靠谱家养小精灵”的开发笔记：
先教它接任务，再教它别串台；先让它会跑腿，再让它学会按时回报，别一上来就把整座庄园的杂活全丢给它。

这里借用一下《哈利·波特》里家养小精灵的意象，不过目标很朴素：
让 `dobby` 这套宿主系统替你处理“IM 收任务 -> 本地 agent 干活 -> 结果送回去”这一长串琐碎家务。
不是要求你把 `dobby` 一比一照抄出来；`dobby` 只是我们手边这只已经学会端盘子的样本。

## 先看哪几篇

1. [01-minimal-openclaw.md](./01-minimal-openclaw.md)
   - 先别给小精灵塞满一屋子魔法道具，先收住：一个最小 openclaw 到底要哪些模块。
2. [02-im-to-local-agent.md](./02-im-to-local-agent.md)
   - 让 dobby 真正接第一张任务单：顺着一条真实消息，把主链路走通。
3. [03-dobby-module-map.md](./03-dobby-module-map.md)
   - 先画一张庄园地图：哪类问题该改哪层，别修厨房却跑去拆屋顶。
4. [04-building-a-usable-cli.md](./04-building-a-usable-cli.md)
   - 给小精灵配前台和工牌：为什么 CLI 不是包装层，而是控制面。
5. [05-gateway-orchestration.md](./05-gateway-orchestration.md)
   - 去看总台怎么派活：Gateway 怎么把去重、路由、会话和回包收成一条稳定主链。
6. [06-routing-and-config-model.md](./06-routing-and-config-model.md)
   - 去看任务卡怎么写：为什么 route / binding 定义的是执行上下文，而不只是映射。
7. [07-runtime-lifecycle.md](./07-runtime-lifecycle.md)
   - 去看小精灵的记事本：会话串行、取消、reset 和 archival 为什么必须单独成层。
8. [08-event-forwarder-and-streaming.md](./08-event-forwarder-and-streaming.md)
   - 去看它怎么回话：流式更新、tool 状态、progress 和消息拆分为什么要交给 Event Forwarder。
9. [09-extension-system-and-execution.md](./09-extension-system-and-execution.md)
   - 去看工具房怎么搭：宿主怎么只认契约，不把多种 Provider / Connector / Sandbox 全塞进核心。
10. [10-cron-and-scheduled-execution.md](./10-cron-and-scheduled-execution.md)
    - 去看闹钟怎么挂：cron 为什么是新的触发入口，而不是第二条执行链。
11. [11-roadmap-and-checklist.md](./11-roadmap-and-checklist.md)
    - 最后把训练计划收尾：如果你要自己做，或者以后要继续更新教程，就看这篇路线图和检查清单。

## 这套教程想解决什么问题

- 怎么做一个最基本、能跑起来的 openclaw
- 用户怎么通过 IM 平台和自己本地的 agent 通信
- 为什么要把 Connector、Gateway、Provider、Executor、Routing 拆开
- 为什么第一版不要急着做 cron、插件市场、复杂 CLI
- 当项目变大以后，哪些层应该先补，哪些层应该后补
- 当你已经拿到一套代码时，应该按什么顺序读、按什么边界改

## 这套教程故意不做的事

为了让这套东西更像“带徒弟训练小精灵”，而不是把白皮书糊你脸上，这里有几个刻意取舍：

- 不贴大段源代码，只放关键片段
- 不把教程写成功能说明书，而是优先讲“为什么这么拆”和“这层为什么该放在这里”
- 不堆 commit hash，时间线只保留对开发顺序真正有帮助的信息
- 只在需要对照实现时，少量提到关键源码入口

## 更新约定

以后更新这组教程时，按这个顺序检查：

1. 核心消息模型变没变
2. Gateway 主链路变没变
3. 路由模型变没变
4. 会话语义和流式输出策略变没变
5. cron / extension / sandbox 这种增强层的语义变没变

如果前 3 项变了，至少要回头改前 3 篇，以及对应的 Gateway / Routing 深潜篇。
如果后 2 项变了，再同步更新 Runtime、Event Forwarder、扩展系统、cron 和路线图几篇。
