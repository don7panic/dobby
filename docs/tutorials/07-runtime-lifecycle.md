# 教程 07：Runtime 为什么是对话型宿主的状态地基

上一篇我们把任务卡写清楚了。接下来要解决的是记性问题。

如果 dobby 刚听完“去修 A”，你又喊“等等先停手”，再过两秒补一句“算了重新来一轮”，系统到底怎么不混？

Runtime 就是专门管这本账的。

## 先记住 Runtime 层到底在负责什么

在 `dobby` 里，这一层主要负责：

- 用 conversation key 把消息分桶
- 保证同一桶里严格串行
- 复用同一会话的 provider runtime
- 处理取消、重置、关闭
- 让 Gateway 可以区分 `shared-session` 和 `ephemeral`

这几件事如果不放在一层里统一做，取消和 reset 很快就会变成那种“演示时能用、真连着发三条消息就露馅”的实现。

## Conversation key 为什么不能拍脑袋定

当前 Gateway 里会把 conversation key 定义成：

- `connectorId`
- `platform`
- `accountId`
- `chatId`
- `threadId ?? 'root'`

拼起来的一串 key。

这套身份设计背后的考虑很朴素：

- `connectorId` 区分不同 connector 实例
- `accountId` 区分同一平台下不同 bot / 账号
- `chatId` 区分聊天容器
- `threadId` 把线程内多轮会话再细分开

所以这个 key 不是“看起来够唯一就行”，而是在表达宿主真正认为的会话边界。

如果这一步定义不准，后面所有串行、取消、reset 都会跟着跑偏。

## `RuntimeRegistry` 的核心设计：不是队列，而是“带版本号的会话槽位”

当前实现里，`RuntimeRegistry` 的 entry 大概长这样：

```ts
interface RuntimeEntry {
  runtime: ConversationRuntime | undefined
  tail: Promise<void>
  epoch: number
  scheduledTasks: number
}
```

这里最值得讲的不是 `tail`，而是 `epoch`。

因为很多人第一版都会写出一个最小串行队列，但很快就会卡在这里：

- 取消当前任务时，后面已经排队的任务怎么办
- reset 以后，之前排队的旧任务要不要继续跑
- createRuntime 过程中如果会话已经被 reset 了，刚建出来的 runtime 怎么处理

`epoch` 本质上就是一个“这一桶会话现在还是不是同一代”的标记。

核心运行逻辑大概像这样：

```ts
const scheduledEpoch = entry.epoch
const run = entry.tail.then(async () => {
  if (scheduledEpoch !== entry.epoch) return

  let runtime = entry.runtime
  if (!runtime) {
    const created = await createFn()
    if (scheduledEpoch !== entry.epoch) {
      await closeRuntime(key, created, 'Discarding runtime created for stale queued task')
      return
    }
    entry.runtime = created
    runtime = created
  }

  await task(runtime)
})
```

这就是为什么我说它不是“普通队列”，而是“带版本号的会话槽位”。

## `cancel` 和 `reset` 看起来像兄弟，其实不是一回事

当前实现里，这两个操作的语义是分开的：

- `cancel`：取消当前和排队中的任务，但不强制开始新会话
- `reset`：终止当前会话、清空 runtime、准备下一次真正新建会话

翻成人话：

- `cancel` 更像“先停手，别再端着锅往前冲”
- `reset` 更像“这页作废，重开一本账”

代码上，这两者都会先把 `epoch += 1`，但后续动作不同：

- `cancel` 主要做 abort
- `reset` 会在 tail 后面 close runtime，并把 `entry.runtime = undefined`

这个区别非常重要。因为用户说“停一下”和“开个新会话”，宿主语义并不是同一件事。

## 为什么 `ConversationRuntime` 不是裸 provider runtime

`RuntimeRegistry` 里保存的不是直接的 `GatewayAgentRuntime`，而是 `ConversationRuntime`。

这么做的原因是，Registry 真正关心的不只是“有个 runtime 对象”，而是这一整个会话槽位的上下文：

- 它属于哪条 route
- provider / sandbox 是谁
- 怎么关闭
- runtime 本体在哪

这让 Registry 可以专心管理会话生命周期，而不用知道 provider 内部具体怎么实现 runtime。

## 控制命令为什么最终也落到 Runtime 层

当前控制命令解析非常克制：

- `stop` / `/stop` / `/cancel` -> `cancel`
- `/new` / `/reset` -> `new_session`

但真正重要的不是解析器有多复杂，而是这些命令最终都指向 Runtime 层：

- `cancel` -> `runtimeRegistry.cancel(conversationKey)`
- `new_session` -> `runtimeRegistry.reset(conversationKey)` + provider archival

这说明了一个很关键的边界：

控制命令改变的是“会话状态”，不是“平台消息格式”。所以它们本来就不该留在 Connector，也不该藏在 Provider 里。

## Provider archival 为什么跟 reset 绑在一起

当前 Gateway 处理 `/new` / `/reset` 时，会先确认当前 provider 存在并实现了 `archiveSession(...)`，然后 reset 当前 runtime，最后再调用 `archiveSession(...)`。

换句话说，当前实现不是“有能力就归档、没能力就跳过”，而是把 session archival 当成新会话命令的一部分；如果 provider 不支持，这条命令会直接报错。

这个设计很合理，因为它表达的是：

- 宿主先决定“这个会话结束了”
- provider 再决定“怎么把这段会话历史归档”

如果把这两件事顺序颠倒，很容易出现宿主以为已经开始新会话，但 provider 还没真正清干净旧上下文。

## `shared-session` 和 `ephemeral` 是 Runtime 视角下的两种运行模式

当前普通 connector 消息会带着：

- `stateless: false`
- `sessionPolicy: 'shared-session'`

而 scheduled run 会带着：

- `stateless: true`
- `sessionPolicy: 'ephemeral'`

这两组参数加起来，其实就是在告诉 Runtime 层：

- 普通对话：要复用上下文
- 定时任务：这次跑完就算，不要把会话状态留给下次

这让 Runtime 语义和入口类型解耦了。Cron 不是因为“特殊”，而是因为它天然适合 ephemeral session。

## 什么时候该改 Runtime，而不是改 Gateway 或 Provider

这些问题通常优先看 Runtime：

- 同会话消息串行失效
- `/cancel` 没停掉排队任务
- `/reset` 后旧会话还在被复用
- shutdown 时会话没被正确 close
- 多轮对话上下文复用策略有变

而这些问题通常不该从 Runtime 改：

- 哪条消息该进哪条 route -> Routing
- 群聊需不需要 @bot -> Gateway
- delta 怎么展示成 IM 消息 -> Event Forwarder

## 结论

Runtime 层真正守住的是“同一摊活到底算不算同一轮”的语义一致性。

这层一旦立不住，系统就很难在多轮交互里表现得像个稳定宿主；它只会像一串偶尔能跑通的单次请求，外加一只明显记性不太好的小精灵。

下一篇我们继续看输出侧：为什么 Event Forwarder 最终会成为流式体验、tool 状态和消息拆分的真正承载层。
