# 教程 01：一个最小 openclaw 到底有哪些部分

如果你今天准备新开一个仓库，目标只有一个：

把 `dobby` 这只家养小精灵先训练到“听得懂话、找得到活、干完会回来报信”。

别急着让它值夜班、管排班表、学插件市场，再顺手背下十几个 CLI 子命令。
第一天就给小精灵发全庄园钥匙，通常不会迎来奇迹，只会迎来一地碎杯子。

第一版先把主链路立住。

## 第一步：先把目标收窄

一个最小可用的 openclaw，至少要做到下面 5 件事：

1. 接住 IM 消息
2. 知道这条消息该在哪个本地项目里执行
3. 保证同一个会话里的消息不要乱序
4. 能把 prompt 交给本地 agent
5. 能把结果再发回 IM

只要这 5 件事都跑通了，你就已经有 MVP 了。

## 第二步：先定义统一消息模型

别一开始就把 Discord SDK 或 Feishu SDK 的对象传来传去。你应该先收敛出自己的统一入站消息结构。

拿当前 `dobby` 的接口形状来说，第一版最少够用的模型可以先收成这样：

```ts
type InboundEnvelope = {
  connectorId: string
  platform: string
  accountId: string
  source: {
    type: 'channel' | 'chat'
    id: string
  }
  chatId: string
  threadId?: string
  guildId?: string
  messageId: string
  userId: string
  userName?: string
  text: string
  attachments: Array<{
    id: string
    fileName?: string
    mimeType?: string
    localPath?: string
    remoteUrl?: string
  }>
  timestampMs: number
  raw: unknown
  isDirectMessage: boolean
  mentionedBot: boolean
}
```

为什么这一步要先做？因为后面所有层都会依赖这个结构：

- Connector 负责产出它
- Gateway 负责消费它
- RuntimeRegistry 用它生成会话 key
- Provider 用它理解上下文

如果这一步不先收住，后面每接一个新平台都会把系统搞乱。

## 第三步：只保留 4 个最小对象

第一版先把下面 4 个对象做出来：

- `Connector`
- `Gateway`
- `Provider`
- `HostExecutor`

先别多。第一天就给家养小精灵发 14 种职责，它大概率会先把托盘掉地上。

拿当前 `dobby` 的接口名来说，一个最小 Connector 核心边界大概长这样：

```ts
interface ConnectorPlugin {
  start(ctx: {
    emitInbound: (message: InboundEnvelope) => Promise<void>
    emitControl: (event: {
      type: 'stop'
      connectorId: string
      platform: string
      accountId: string
      chatId: string
      threadId?: string
    }) => Promise<void>
  }): Promise<void>

  send(message: OutboundEnvelope): Promise<{ messageId?: string }>
  stop(): Promise<void>
}
```

当前代码里 Connector 还会带 `capabilities`、`sendTyping`、`getHealth` 这些增强能力，但第一版你先把 `start / send / stop` 这条主边界收清楚就够了。

一个最小 Runtime 接口可以这样定义：

```ts
interface GatewayAgentRuntime {
  prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>
  subscribe(listener: (event: GatewayAgentEvent) => void): () => void
  abort(): Promise<void>
  dispose(): void
}
```

第一版只要这两个边界够清楚，后面换平台、换 Provider、换运行环境都会轻松很多。

## 第四步：别急着做复杂路由，先做一个最小 route

如果你按当前 `gateway.json` 的模型来写，第一版完全可以先把 route / binding 相关部分收成这样：

```jsonc
{
  // 这里只截出和 route / binding 直接相关的部分
  "providers": {
    "default": "pi.main",
    "items": {
      "pi.main": {
        "type": "provider.pi"
      }
    }
  },
  "routes": {
    "default": {
      "projectRoot": "/Users/you/workspace/project-a",
      "provider": "pi.main",
      "sandbox": "host.builtin",
      "tools": "full",
      "mentions": "required"
    },
    "items": {
      "main": {}
    }
  },
  "bindings": {
    "items": {
      "discord.main.main": {
        "connector": "discord.main",
        "source": { "type": "channel", "id": "1234567890" },
        "route": "main"
      }
    }
  }
}
```

这份配置虽然简单，但已经解决了最关键的问题：

- 哪个入口消息该走哪条 route
- 这条 route 对应哪个本地项目目录
- 这条 route 用哪个 provider

`dobby` 现在已经是 `binding -> route -> provider / sandbox / tools` 这套模型了。你自己第一版可以先只配一条 route，但最好从一开始就沿着这个结构长，后面会少很多返工。

## 第五步：先把主链路写成一段你自己能读懂的代码

第一版主链路不用花哨，清清楚楚就够了：

```ts
async function handleInbound(message: InboundEnvelope) {
  const bindingKey = `${message.connectorId}:${message.source.type}:${message.source.id}`
  const routeId = bindings[bindingKey]
  if (!routeId) return

  const route = {
    routeId,
    profile: routes[routeId],
  }
  const runtime = await provider.createRuntime({
    conversationKey: [
      message.connectorId,
      message.platform,
      message.accountId,
      message.chatId,
      message.threadId ?? 'root',
    ].join(':'),
    route,
    inbound: message,
    executor: hostExecutor,
  })

  const unsubscribe = runtime.subscribe((event) => {
    void forwardEventToConnector(event, message)
  })

  try {
    await runtime.prompt(message.text)
  } finally {
    unsubscribe()
    runtime.dispose()
  }
}
```

你会发现，这时候系统其实已经能跑起来了。

## 第六步：为什么我建议你第一版就加 RuntimeRegistry

很多人第一反应会是：

“我先每条消息都新建一个 runtime，不就行了吗？”

能跑，但很快就会撞墙。用户只要连着喊两声，小精灵就可能左手端汤右手摔碗，因为你马上会遇到这些问题：

- 两个请求同时进模型，顺序乱掉
- 同一线程里的上下文没法稳定复用
- 以后想做 `/cancel`、`/new`、`/reset` 会很难补

所以我更建议你第一版就把“按会话串行执行”这件事做掉。一个最小版本甚至不用很复杂：

```ts
const queues = new Map<string, Promise<void>>()

function runInConversation(key: string, task: () => Promise<void>) {
  const tail = queues.get(key) ?? Promise.resolve()
  const next = tail.then(task, task)
  queues.set(key, next.catch(() => {}))
  return next
}
```

这不是最终形态，但足够说明：会话串行不是锦上添花，它是 IM 对话型系统的地基。

## 第七步：第一版完成以后，你应该能回答这 4 个问题

如果下面这 4 个问题你都能回答清楚，说明你的最小 openclaw 已经立住了：

1. 这条消息是怎么从 IM 进来的？
2. 它为什么会落到这个本地项目目录？
3. 同一个会话里的两条消息为什么不会打架？
4. 模型输出为什么能稳定回到原聊天？

## 结论

最小 openclaw 不是“拉个 bot 接上模型，然后祈祷它像魔法一样自己运转”。

它更像是先把家养小精灵训练成一个靠谱跑腿：

- 能听见任务
- 能找到该去的项目目录
- 不会一边扫厨房一边把客厅的活也打翻
- 能调起本地 agent
- 干完知道回原处复命

下一篇，我们就让 dobby 真正接第一张任务单：顺着一条 IM 消息，把整条链路走一遍。
