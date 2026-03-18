# 教程 08：Event Forwarder 为什么决定了流式体验的上限

上一篇把会话账本搭好了，这一篇来看嘴巴。

agent 内部会哗啦啦吐出一串事件，但用户能看到的只有聊天消息。你总不能让 dobby 每生成一个字，就冲到门口喊一嗓子。

所以，输出层得有人专门负责把“内部事件”翻译成“体面的对外汇报”。

## 为什么 Event Forwarder 必须是单独一层

因为它处理的是三种抽象之间的翻译。你可以把它想成“内部黑话同声传译”：

1. provider runtime 的事件模型
2. connector 的能力声明
3. 用户真正看到的聊天体验

当前 `dobby` 里的 runtime 事件大概有这些：

- `message_delta`
- `message_complete`
- `command_start`
- `tool_start`
- `tool_end`
- `status`

而 connector 只会告诉你：

- 能不能 edit
- 能不能 append
- progress 最适合 edit 还是 create
- 文本最大长度是多少

Event Forwarder 的作用，就是把这两边翻译成一套稳定用户体验。

## Forwarder 手里到底攥着哪些状态

它内部维护了一串完全为了体验存在的状态：

- `rootMessageId`
- `responseText`
- `appendEmittedText`
- `pendingFlush`
- `progressMessageId`
- `pendingProgressText`
- `activeWorkPhase`
- `longProgressTimer`

这说明了一个很现实的事实：

流式输出从来都不只是“拿到一段文本就发出去”。

你需要管理：

- 当前主消息是哪条
- 现在该 edit 还是 append
- progress 消息是不是单独一条
- tool side message 要不要展示
- 有没有必要提示“Still working locally...”

这些都是体验层状态，而不是 Provider 状态。

## `updateStrategy` 是这层最关键的输入

当前 connector 会通过能力声明告诉 Forwarder：

- `edit`
- `append`
- `final_only`

然后 Forwarder 按这个策略决定主消息怎么更新。

核心分支大概就是：

```ts
if (event.type === 'message_delta') {
  responseText += event.delta
  if (updateStrategy !== 'final_only') {
    scheduleFlush()
  }
}

if (event.type === 'message_complete') {
  responseText = event.text
  if (updateStrategy !== 'final_only') {
    void flushNow()
  }
}
```

这个设计的价值在于：

- Provider 不需要知道消息是 edit 还是 append
- Connector 只需要声明能力，不需要决定宿主的展示逻辑
- 不同平台的体验差异被收敛在一层里处理

## 为什么 `progressUpdateStrategy` 要单独存在

主消息和 progress 消息，其实不是一回事。

例如：

- 主消息适合持续 edit
- 但 progress 也许更适合独立 create 一条消息

所以当前实现里会单独推导 `progressUpdateStrategy`：

- 如果 connector 自己声明了，就按声明走
- 否则在主消息是 `edit` 时也走 `edit`，其他情况默认走 `create`

这类细节特别像“小优化”，其实很重要。因为用户对“结果消息”和“状态消息”的容忍度并不一样。

## `toolMessageMode` 体现的是宿主 UX 选择，不是模型能力

当前 Forwarder 在处理 `tool_start` / `tool_end` 时，不是简单全发，而是允许几种模式：

- `none`
- `errors`
- `all`

这背后其实是在回答一个体验问题：

“用户到底应该看到多少工具细节？”

这个问题显然不属于 Provider，也不属于 Connector。它属于宿主输出层，也就是 Event Forwarder。

## 为什么要做 debounce、long-progress timer 和 maxTextLength 处理

这三个点看起来很工程，但它们基本决定了“用户会不会觉得这只小精灵话很多、手也很抖”。

### 1. debounce

如果每来一个 delta 都立即发，聊天界面会抖得很厉害，平台限流也更容易撞上。

所以当前实现里会：

- 对主消息 flush 做节流
- 对 progress 更新做 debounce

### 2. long-progress timer

如果本地执行时间长，用户需要知道“系统没死”。

所以当前实现会根据工作阶段，自动给出类似：

- `Working locally...`
- `Still working locally...`
- `Working with tools...`
- `Still working with tools...`

### 3. maxTextLength

平台消息长度上限不是可选项。Forwarder 不处理这一层，最后总会有人在 connector 或 provider 里写一堆特判。

当前实现会先 `truncate` 或按策略 `splitForMaxLength(...)`，再决定怎么发。

这正是输出层该守住的边界。

## `finalize()` 为什么往往比 `handleEvent()` 更容易被忽略

很多人写流式输出时，只关注“中间怎么刷”，不太关注“最后怎么收口”。

但当前实现里，`finalize()` 才是真正把几种策略收干净的地方：

- `final_only`：最后一次性发完整结果
- `append`：把还没发完的尾巴补齐
- `edit`：把最终文本稳定收敛到主消息上

如果没有这个阶段，系统经常会出现这些问题：

- delta 都刷了，但最后完整结果没收齐
- progress 消息还挂在外面
- append 模式最后一段没发出去

所以真正成熟的流式输出，一定有“处理中”和“收尾中”两个阶段。

## 什么时候该改 Event Forwarder

下面这些需求，通常优先改这一层：

- 想把 Discord 从 final only 改成 edit
- 想增加 tool status side message
- 想优化长任务时的提示文案
- 想增加消息拆分策略
- 想区分主消息和 progress 消息的更新方式

如果你只是：

- 想新增 runtime 事件类型 -> Provider / types + Event Forwarder 一起看
- 想改 connector 能力声明 -> Connector
- 想改消息编排顺序 -> Gateway

## 结论

Event Forwarder 决定的，不是“消息能不能发出去”，而是“小精灵到底会不会好好汇报工作”。

这层独立出来以后，Provider 可以继续专心产出事件，Connector 也不用背宿主 UX 的复杂度。

下一篇我们去看工具房和执行环境：为什么 `dobby` 能同时支持多种 Connector / Provider / Sandbox，而宿主核心还没有被撑爆。
