# 教程 05：为什么 Gateway 是宿主的主链路中枢

上一篇我们给 dobby 配好了控制台、工牌和说明书。现在回到主链路本身，看看每天真正替它分发家务的总台：Gateway。

很多第一版项目都会把 Gateway 写得很薄，薄到只像一个“把消息转发给 Provider 的函数”。早期这么写当然能跑，但那更像临时让小精灵自己摸着墙找路。

一旦你开始支持去重、route / binding、mention 策略、控制命令、流式输出和 cron 入口，你就会发现：系统非常需要一个真正的主链路编排层。

## 先记住一句话：Gateway 只负责编排，不负责平台适配和模型实现

把 Gateway 想成总台，这条边界就特别好记。

Gateway 应该知道：

- 一条消息该按什么顺序被处理
- 需要调用哪些宿主内组件
- 出错后要怎么回给用户

Gateway 不应该知道：

- Discord SDK 的 message 对象长什么样
- Claude / PI / codex CLI 具体怎么起进程
- 某个 sandbox 内部怎么执行命令

所以 `dobby` 才会先把平台对象归一化成 `InboundEnvelope`，再交给 Gateway；不然总台第一天就得学会所有平台方言。

## `dobby` 里的 Gateway，实际上在编排哪些依赖

落到代码里，Gateway 自己不持有太多业务状态，但它手里会拿着几类关键依赖：

- `BindingResolver`
- `RouteResolver`
- `DedupStore`
- `RuntimeRegistry`
- `providers`
- `executors`
- `connectors`

这其实已经很能说明问题了：

Gateway 不是“做一件事的类”，而是“把一条消息送过所有必要边界的类”。

如果你现在要对照源码看，最值得先看的就是：

- `src/core/gateway.ts`
- `src/core/runtime-registry.ts`
- `src/agent/event-forwarder.ts`

## 一条真实消息，在 Gateway 里到底按什么顺序走

当前主链路的顺序，大致可以压缩成这样：

```ts
async function handleMessage(message: InboundEnvelope, handling: MessageHandlingOptions) {
  const connector = connectorsById.get(message.connectorId)
  if (!connector) return

  if (handling.useDedup && dedupStore.has(dedupKey(message))) {
    return
  }

  const resolvedRoute = resolveMessageRoute(message, handling)
  if (!resolvedRoute) return

  if (handling.origin === 'connector') {
    const command = parseControlCommand(message.text)
    if (command) {
      await handleCommand(connector, message, command, resolvedRoute.route)
      return
    }
  }

  if (
    resolvedRoute.route.profile.mentions === 'required'
    && !message.isDirectMessage
    && !message.mentionedBot
  ) {
    return
  }

  const provider = providers.get(resolvedRoute.route.profile.provider)
  const executor = executors.get(resolvedRoute.route.profile.sandbox)
  if (!provider || !executor) {
    await connector.send({ mode: 'create', text: 'Route runtime not available' })
    return
  }

  // shared-session 走 RuntimeRegistry；scheduled run 走 stateless + ephemeral
  await runWithRuntime(...)
}
```

这个顺序非常关键，因为它几乎回答了宿主最常见的几句灵魂拷问：

- 为什么重复消息不会重复执行
- 为什么没有 binding 的消息会被忽略
- 为什么控制命令不需要真的进模型
- 为什么群聊里可以要求必须 @bot 才处理
- 为什么 scheduled run 和普通消息还能复用同一套执行逻辑

## 为什么 dedup、route resolve、control command 都要留在 Gateway

很多人第一次做，会想把这些逻辑拆到别处：

- dedup 放到 Connector
- route resolve 放到配置层工具函数里顺手做掉
- control command 放到 Provider 前面随便判断一下

这样短期看很省事，长期几乎一定会出问题。

原因很简单：

- 去重要基于宿主自己的消息身份规则，而不是某个平台 SDK 的偶然字段
- route resolve 要同时看 binding、默认 route、direct message fallback，这已经是宿主语义，不只是“查配置”
- control command 的目标是影响 runtime，而 runtime 本来就是 Gateway 这一层协调的

换句话说，这三件事都不是“边角料”，它们本身就是主链路的一部分。

## `handleScheduled(...)` 这个设计，特别值得学

`dobby` 里有一个很好的点：计划任务没有偷偷再造一条执行链，而是先合成一条 `InboundEnvelope`，再重新走 `handleMessage(...)`。

也就是：

```ts
await gateway.handleScheduled({
  jobId,
  runId,
  connectorId,
  routeId,
  channelId,
  prompt,
})
```

然后 Gateway 内部会把它翻成 synthetic inbound，再带着这些选项继续往下走：

- `routeIdOverride`
- `conversationKeyOverride: 'cron:<runId>'`
- `stateless: true`
- `sessionPolicy: 'ephemeral'`

这几个字段加起来，其实就是在表达一句话：

“这是一个新的入口，但不是一条新的宿主主链。”

这比“复制一份 cron 专用执行逻辑”稳得多。

## 真正把用户体验做顺的，是 `processMessage(...)`

进入 provider 之前，Gateway 还会做一轮真正决定体验的装配：

- 建立 typing keep-alive
- 创建 `EventForwarder`
- 构造 prompt payload
- 订阅 runtime 事件
- 在失败时决定是更新已有消息还是追加错误消息

主体结构大概像这样：

```ts
const typingController = createTypingKeepAliveController(connector, message, logger)
const forwarder = new EventForwarder(connector, message, null, logger)

await typingController.prime()
const unsubscribe = runtime.subscribe(forwarder.handleEvent)
const payload = await buildPromptPayload(message)
await promptWithOptionalTimeout(runtime, payload, timeoutMs)
await forwarder.finalize()
```

这里最值得学的架构点，不是函数有多长，而是职责分得很稳：

- Gateway 决定何时创建这些组件
- Event Forwarder 决定怎么发消息
- runtime 决定怎么产出事件
- connector 决定怎么和平台通信

这就是“编排层”的正确重量：它要足够重，才能把流程收住；但又不能重到开始吞别层职责。

## Prompt payload 为什么也放在 Gateway

当前实现里，图片附件会在 Gateway 里被读成本地文件，再转成 `ImageContent`；非图片附件则会被注入到 `<attachments>...</attachments>` 片段里。

这一步放在 Gateway，而不是 Provider，有两个很现实的好处：

- Provider 不需要知道 Discord / Feishu 的附件下载语义
- 所有 provider 都能共享同一套 prompt payload 规范

换句话说，Gateway 负责把“平台上的输入”变成“agent 能理解的宿主输入”，这正是它该干的事。

## 错误策略，为什么也应该由 Gateway 收口

在 `dobby` 里，主流程失败时不会只打日志，而是尽量把 `Error: ...` 回给 connector。

这背后的想法很实用：

- 对用户来说，最重要的是聊天里能看到失败
- 对开发者来说，日志仍然保留完整上下文
- 对 connector 来说，它只负责发送，不负责决定错误语义

另外，Gateway 还会根据 connector 的 `updateStrategy` 判断：

- 如果已经有可编辑的主消息，就更新它
- 否则新发一条错误消息

这也是编排层该做的判断，而不是 Provider 该做的判断。

## 什么时候该改 Gateway，什么时候不该改

一个很好用的判断法是：

- 需求改变了“主链路顺序”或“跨模块装配关系” -> 改 Gateway
- 需求只是新增平台字段映射 -> 改 Connector
- 需求只是新增 route 规则或默认值 -> 改 Routing
- 需求只是改变会话复用 / 取消 / reset 语义 -> 改 Runtime
- 需求只是改变展示策略 -> 改 Event Forwarder

如果一个需求只影响单个平台 SDK 或单个 provider 实现，却需要你动 Gateway，那通常说明边界有点漏了。

## 结论

Gateway 的价值，不在于“把消息塞给模型”，而在于替小精灵把所有进门手续办明白：谁能进、该去哪里、要不要排队、出了错怎么回。

这一层立住了，系统才不会随着入口、平台、provider 增多而越长越散。

下一篇我们把目光收窄到任务卡本身：为什么 Routing 解决的不是“配置文件怎么写”，而是“执行上下文到底怎么定义”。
