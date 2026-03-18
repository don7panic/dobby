# 教程 11：从最小 openclaw 演进到可持续维护的系统

前面几篇已经把 dobby 这只家养小精灵从“会接任务”一路讲到“会排班、会扩展、会按时出门”。

这一篇不再拆模块，改讲训练顺序：先学什么，后学什么，才不至于把庄园越管越乱。

## 一份实用的演进路线图

### 里程碑 A：先把单入口跑通

先只支持：

- 一个 IM 平台
- 一个 Provider
- 一个本地项目目录
- 一个执行后端

做到这一步，你的系统就已经能工作了。

验收标准：

- 用户发消息能进宿主
- 消息能进本地 agent
- 结果能回到原聊天
- 同会话两条消息不会乱序

最小骨架大概像这样：

```ts
const providers = new Map([['pi.main', provider]])
const connectors = [connector]
const executors = new Map([['host.builtin', hostExecutor]])

// 省略单 route 场景下的 routeResolver / bindingResolver / dedupStore / runtimeRegistry / logger 构造
const gateway = new Gateway({
  config,
  connectors,
  providers,
  executors,
  routeResolver,
  bindingResolver,
  dedupStore,
  runtimeRegistry,
  logger,
})

await gateway.start()
```

这一阶段不要急着做复杂 CLI，也不要急着摆出扩展市场。先把一条消息闭环打磨顺，比让小精灵学会花式翻跟头重要得多。

### 里程碑 B：让一个 bot 能服务多个项目

当你开始把不同频道绑定到不同仓库时，就该补路由层了。

建议做到：

- `bindings.items`
- `routes.items`
- `routes.default`
- mention 策略
- provider / sandbox / tools 默认值继承

验收标准：

- 两个不同频道能稳定落到两个不同 `projectRoot`
- 不改 Connector，也能切换 route 的 provider 或 tools 权限

### 里程碑 C：把会话体验做顺

到了这一步，系统已经不是“能不能跑”的问题，而是“用户用起来顺不顺”的问题。

建议补这些：

- `RuntimeRegistry`
- `/cancel`、`/new`、`/reset`
- typing / progress
- 流式更新策略
- 附件和图片输入

一个最值得早点做的能力是取消：

```ts
if (command === '/cancel') {
  await runtimeRegistry.cancel(conversationKey)
  await connector.send({
    platform: message.platform,
    accountId: message.accountId,
    chatId: message.chatId,
    threadId: message.threadId,
    mode: 'create',
    replyToMessageId: message.messageId,
    text: '已取消当前任务。',
  })
}
```

只要系统开始真的被人用，这类体验项很快就会比“再接一个新 Provider”更值钱。毕竟用户第一时间感受到的，往往不是模型名单，而是这只小精灵到底听不听话。

### 里程碑 D：让宿主保持瘦，把能力实现拆出去

当 Connector、Provider、Sandbox 的种类开始增加时，建议补扩展边界。

目标不是“做一个酷炫插件平台”，而是：

- 宿主不再感知具体实现细节
- 宿主只认 contribution 契约
- 新增一种 Provider 不需要改 Gateway 主链路

这一步的关键装配过程一般长这样：

```ts
const loadedPackages = await loader.loadAllowList(config.extensions.allowList)
registry.registerPackages(loadedPackages)

const providers = await registry.createProviderInstances(activeProvidersConfig, hostContext, config.data)
const connectors = await registry.createConnectorInstances(config.connectors, hostContext, config.data.attachmentsDir)
const sandboxes = await registry.createSandboxInstances(activeSandboxesConfig, hostContext)
```

### 里程碑 E：再把新入口接进来，而不是另起一套系统

如果你要做 cron，记住一件事：

不要另写一套执行链。

更稳妥的做法是：

```ts
await gateway.handleScheduled({
  jobId: 'daily-report',
  runId: 'daily-report:2026-03-18T09:00:00.000Z',
  connectorId: 'discord.main',
  routeId: 'daily-report',
  channelId: '1234567890',
  prompt: 'Summarize open issues',
})
```

说白了，cron 只负责“什么时候触发”，真正怎么执行，还是走同一个 Gateway。

### 里程碑 F：最后再补长期运行能力

只有当系统真的要长期跑时，再补这些：

- connector health supervisor
- status snapshot
- sandbox 隔离增强
- release automation
- CI / package publish 流程

这一层很重要，但它是后手，不是起手。

## 你可以直接照抄的周计划

如果你想把这件事排成一个短周期项目，我建议像这样切：

### 第 1 周

- 统一消息模型
- 一个 Connector
- 一个 Provider
- 一个 HostExecutor
- 一个最小 Gateway

### 第 2 周

- RuntimeRegistry
- 流式回写
- 取消和重置
- 附件输入

### 第 3 周

- binding / route 模型
- 多项目目录支持
- init / doctor / 配置诊断

### 第 4 周及以后

- 扩展系统
- cron
- sandbox 增强
- 健康监督
- 发布和 CI 自动化

这个顺序很朴素，但通常最不容易返工，也最不容易把自己未来两周都献祭给重构。

## 以后维护这套教程，按这张清单来

每次有结构性改动时，按下面顺序检查：

### 1. 先看核心契约变没变

重点看：

- 入站消息模型
- Connector 接口
- Runtime 接口
- route / binding 配置语义

如果这些变了，前两篇教程必须回头改。

### 2. 再看主链路变没变

重点看：

- Gateway 有没有新增步骤
- prompt payload 的构造方式有没有变化
- 流式事件有没有新增类型
- cancel / reset / archive 的语义有没有变化

如果这些变了，Gateway / Runtime / Event Forwarder 相关几篇要一起改。

### 3. 最后看增强层变没变

重点看：

- cron 是否还在复用同一条 Gateway 主链
- extension store 的加载边界有没有变化
- sandbox 默认策略有没有变化
- health supervisor / snapshot 语义有没有变化

如果这些变了，再更新扩展、cron 和路线图几篇。

## 每轮更新完，至少做这几个检查

文档更新不是写完就完。至少做下面这些：

```bash
git diff --check
npm run check
npm run build
npm run test:cli
```

如果这轮还动了插件，再补：

```bash
npm run plugins:check
npm run plugins:build
```

如果只是纯文档改动，至少也要把 Markdown 链接和目录结构检查一遍。

## 结论

一个 openclaw 项目最怕的不是功能少，而是还没学会端盘子，就先被拉去值夜班。

更靠谱的推进方式一直都是：

1. 先把最小主链路做对
2. 再把路由和会话边界做稳
3. 再把操作体验补齐
4. 最后才补调度、扩展、运维和发布能力

只要你按这个顺序推进，项目会慢一点，但通常会稳很多。
