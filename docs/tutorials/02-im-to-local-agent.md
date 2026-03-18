# 教程 02：如何让用户通过 IM 和本地 Agent 通信

上一篇我们只是把骨架列出来。这一篇不聊抽象，直接让 dobby 接第一单差事。

你可以想象这样一个场景：

- 用户在 Discord 频道里 @bot 发一句话
- 这句话要映射到你本地的某个项目目录
- 你的 agent 在这个目录里执行
- 输出要一边生成，一边回到同一个聊天线程里

如果这条链路跑顺了，dobby 才算真的学会了“接活 -> 干活 -> 回话”。

## 第 1 步：先把平台消息翻译成你自己的消息对象

不要让 Gateway 直接啃平台 SDK 对象。先在 Connector 里把平台黑话翻译成人话，别让小精灵和 SDK 一起犯迷糊。

一个很实用的写法是这样：

```ts
function toInboundEnvelope(
  event: DiscordEvent,
  botUserId: string,
  sourceId: string,
): InboundEnvelope {
  return {
    connectorId: 'discord.main',
    platform: 'discord',
    accountId: botUserId,
    source: {
      type: 'channel',
      id: sourceId,
    },
    chatId: event.channelId,
    threadId: event.isThread ? event.channelId : undefined,
    messageId: event.id,
    userId: event.author.id,
    userName: event.author.username,
    text: stripBotMention(event.content, botUserId),
    attachments: mapAttachments(event.attachments),
    timestampMs: event.createdTimestamp,
    raw: event,
    isDirectMessage: event.guildId == null,
    mentionedBot: event.mentionsBot,
    ...(event.guildId ? { guildId: event.guildId } : {}),
  }
}
```

如果是 Discord 线程消息，`chatId` 还是当前线程 ID，但 `source.id` 最好保留父频道 ID。这样 route lookup 才能和 `bindings.items` 对齐。

这里最关键的不是字段多不多，而是：

- 后面所有层都只认 `InboundEnvelope`
- 平台差异停在 Connector 里

这样你以后就算换成 Feishu、Telegram，也不用重写 Gateway。

## 第 2 步：先用 binding 把消息映射到一个本地项目

你不能收到消息就直接进模型，因为系统得先知道：

“这条消息到底应该在哪个目录里跑？”

按当前 `dobby` 的配置模型，一个最小版本可以像这样：

```jsonc
{
  // 这里只截出 route / binding 相关部分
  "routes": {
    "default": {
      "projectRoot": "/Users/you/workspace/project-a",
      "provider": "pi.main",
      "sandbox": "host.builtin",
      "tools": "full",
      "mentions": "required"
    },
    "items": {
      "project-a": {}
    }
  },
  "bindings": {
    "items": {
      "discord.main.project-a": {
        "connector": "discord.main",
        "source": { "type": "channel", "id": "1234567890" },
        "route": "project-a"
      }
    }
  }
}
```

然后在 Gateway 里做一层 resolve：

```ts
function resolveRoute(message: InboundEnvelope) {
  const bindingKey = `${message.connectorId}:${message.source.type}:${message.source.id}`
  const routeId = bindings[bindingKey]
  if (!routeId) return null
  return {
    routeId,
    profile: routes[routeId],
  }
}
```

第一版你完全可以把这层写死。等 route 真的多起来以后，再把它升级成更完整的配置模型。

## 第 3 步：同一个会话必须串行

这一步是很多第一版最容易省掉，但后面又最容易返工的地方。

你需要一条规则，定义“什么叫同一个会话”。一个够用的做法是：

```ts
function getConversationKey(message: InboundEnvelope) {
  return [
    message.connectorId,
    message.platform,
    message.accountId,
    message.chatId,
    message.threadId ?? 'root',
  ].join(':')
}
```

然后所有进入同一个 key 的消息，都走同一个串行队列：

```ts
const conversationKey = getConversationKey(message)

await runtimeRegistry.run(
  conversationKey,
  () => createConversationRuntime(conversationKey, route, message, executor),
  async ({ runtime }) => {
    await runtime.prompt(message.text)
  },
)
```

这里的 `createConversationRuntime(...)` 内部其实就是 `provider.createRuntime({ conversationKey, route, inbound: message, executor })` 再包一层 `ConversationRuntime`，这样 RuntimeRegistry 才能在同一个 key 上复用、取消和 reset。

这样做的价值非常直接：

- 同一线程里不会并发乱序
- 后面做取消和重置会简单很多
- 同一个会话的上下文也更稳定

## 第 4 步：别只传文本，附件也要进 prompt

如果用户从 IM 发来图片、日志、压缩包路径，系统不能只把 `message.text` 扔进模型。

一个很好用的策略是：

- 图片转成 `images`
- 非图片附件把路径或 URL 塞进一个结构化片段里

例如：

```ts
async function buildPromptPayload(message: InboundEnvelope) {
  const images = []
  const attachments = []
  const baseText = message.text.trim()

  for (const file of message.attachments) {
    if (file.mimeType?.startsWith('image/') && file.localPath) {
      images.push(await toImageInput(file.localPath, file.mimeType))
    } else if (file.localPath || file.remoteUrl) {
      attachments.push(file.localPath ?? file.remoteUrl)
    }
  }

  const textParts = [baseText.length > 0 ? baseText : '(empty message)']

  if (attachments.length > 0) {
    textParts.push(`<attachments>\n${attachments.join('\n')}\n</attachments>`)
  }

  return { text: textParts.join('\n\n'), images }
}
```

这段逻辑最好早点补好。因为一旦用户真的把 IM 当工作入口，附件就不是彩蛋，而是每天都会塞到你门口的快递。

## 第 5 步：让 Provider 只管 agent，不管 IM

Provider 的边界一定要守住。

它应该只关心：

- prompt 是什么
- 当前项目目录是什么
- 工具权限是什么
- 执行后端是什么

而不应该关心：

- 这是 Discord 还是 Feishu
- 回复是 edit 还是 append
- 线程消息要不要 reply

在当前实现里，这些信息会打包成 `route + inbound + executor` 传给 Provider。一个很干净的调用边界大概是这样：

```ts
const runtime = await provider.createRuntime({
  conversationKey,
  route,
  inbound: message,
  executor,
})

await runtime.prompt(payload.text, payload.images.length > 0 ? {
  images: payload.images,
} : undefined)
```

如果你把 Provider 边界收在这里，后面换模型、换 CLI、换 SDK 的代价会小很多。

## 第 6 步：把流式事件翻译成用户看得懂的回包

agent 内部通常会产生很多事件：

- 文本增量
- 最终结果
- tool start / tool end
- status

但 IM 平台一般只有这几种能力：

- 发一条消息
- 编辑一条消息
- 有的平台支持追加，有的平台不支持

所以中间最好有一层 event forwarder。第一版你不用做得很复杂，先做一个最小版本就够：

```ts
runtime.subscribe((event) => {
  if (event.type === 'message_delta') {
    buffer += event.delta
    scheduleEdit(buffer)
  }

  if (event.type === 'message_complete') {
    finalizeMessage(event.text)
  }
})
```

等你第二版再加这些增强：

- `edit` / `append` / `final_only` 三种 update strategy
- tool 状态消息
- 长时间运行时的进度提示
- 文本长度超限后的拆分

## 先把第一版做成这样就够了

如果你今天就要开始写代码，我建议你的第一版范围就收在这里：

1. 一个 Connector
2. 一个死配置 route
3. 一个 RuntimeRegistry
4. 一个 Provider
5. 一个 HostExecutor
6. 一个只支持文本流式更新的 Event Forwarder

不要贪多。

只要这条链路顺了，后面要补 cron、扩展系统、sandbox、健康检查，都是加法。

## 结论

想让用户通过 IM 和本地 agent 通信，说穿了就是先把这条跑腿链训顺：

- Connector 把平台消息接进来
- Routing 把消息送到正确的项目目录
- RuntimeRegistry 保证同会话串行
- Provider 把 prompt 交给本地 agent
- Event Forwarder 把事件稳定发回 IM

下一篇我们先暂停接单，退后一步画张庄园地图：现在整个 `dobby` 已经分成了哪些层，每层各管哪摊事。
