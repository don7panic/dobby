# 教程 06：Routing 为什么是在定义执行上下文，而不是在配频道 ID

上一篇我们看了总台怎么派活。现在轮到任务卡本身。

如果你对 routing 的理解还停在“哪个频道对应哪个目录”，那就像只给家养小精灵一张门牌号，却没告诉它带什么工具、听谁吩咐、需不需要被点名才能开工。

`dobby` 现在的 routing 模型，就是为了把这些信息一次写清楚。

## Route 真正承载的是什么

在当前实现里，一条 route 至少会决定这些事：

- `projectRoot`
- `provider`
- `sandbox`
- `tools`
- `mentions`
- 可选的 `systemPromptFile`

这已经明显不是“一个频道 ID 对一个目录”那么简单了。

你可以把它理解成：

- `binding` 负责回答“消息从哪进来”
- `route` 负责回答“进来以后按什么策略执行”

这两件事拆开，是 `dobby` 当前 routing 设计里最值钱的地方之一。

## 为什么要拆成 `bindings.items -> routes.items`

当前配置模型之所以收敛成这个形状，是因为它解决了三个非常具体的问题：

1. 一个 route 可能被多个入口复用
2. 入口变化不应该强迫执行策略一起变化
3. Connector 私有配置不应该偷偷承载 route 映射

说白了，routing 的核心不是“配置长得优不优雅”，而是“变化能不能被关在自己那一侧”。

一个典型配置现在长这样：

```jsonc
{
  "routes": {
    "default": {
      "projectRoot": "/Users/you/workspace/project-a",
      "provider": "pi.main",
      "sandbox": "host.builtin",
      "tools": "full",
      "mentions": "required"
    },
    "items": {
      "projectA": {},
      "projectB": {
        "projectRoot": "/Users/you/workspace/project-b"
      }
    }
  },
  "bindings": {
    "default": {
      "route": "projectA"
    },
    "items": {
      "discord.main.projectA": {
        "connector": "discord.main",
        "source": { "type": "channel", "id": "123" },
        "route": "projectA"
      }
    }
  }
}
```

注意这里的几个点：

- `routes.default` 不是“默认 route”，而是 route 级默认字段集合
- `bindings.default` 才是 direct message 回落到哪条 route
- route item 可以很薄，只覆盖和默认值不同的部分

这几个名字如果没先想清楚，后面配置一复杂就很容易进入“我明明写的是默认值，怎么它跑去默认 route 了”的迷惑现场。

## 当前 `loadGatewayConfig(...)` 实际做了几层工作

在 `dobby` 里，routing 不是简单 `JSON.parse` 一下就结束了，而是会走一轮完整的“解析 -> 归一化 -> 校验”。

主干逻辑大概像这样：

```ts
const parsed = gatewayConfigSchema.parse(JSON.parse(raw))
validateConnectorConfigKeys(parsed.connectors)

const routeDefaults = {
  provider: parsed.routes.default.provider ?? parsed.providers.default,
  sandbox: parsed.routes.default.sandbox ?? parsed.sandboxes.default ?? 'host.builtin',
  tools: parsed.routes.default.tools ?? 'full',
  mentions: parsed.routes.default.mentions ?? 'required',
}

const normalizedRoutes = normalizeRoutes(parsed.routes, configBaseDir, routeDefaults)
validateReferences(parsed, normalizedRoutes)
```

这段流程的价值在于：

- schema 先把形状收住
- normalize 再把默认值补齐、路径转成绝对路径
- validate 最后检查引用关系和冲突

这样 Gateway 运行时就不需要一边处理消息一边猜“这个配置是不是还没补全”。

## 为什么 Routing 层会拒绝某些 connector 私有字段

当前实现里，routing 明确禁止一些历史式 connector 配置字段，比如：

- `botChannelMap`
- `chatRouteMap`
- `botTokenEnv`

这背后的判断特别重要：

- 入口绑定应该统一写在 `bindings.items`
- 认证信息和入口映射不是一回事
- 不能让 routing 语义再悄悄回流到 connector 私有 config 里

这看起来像“限制多了”，其实是在保边界。你宁可现在多拦一下，也别让入口映射半夜偷偷钻回 connector 私有配置里。

## 默认值继承，为什么要在加载期就算完

`dobby` 当前会在加载配置时把 route 默认值算清楚，而不是把“等运行时再回落”留给 Gateway 去做。

这带来两个直接好处：

- Gateway 处理消息时拿到的是已经完整的 `RouteProfile`
- CLI / doctor / config show 也都能看到统一语义，而不是每个命令自己再算一遍默认值

当前默认值语义里最关键的几条是：

- `routes.default.provider` 缺失时回落到 `providers.default`
- `routes.default.sandbox` 缺失时回落到 `sandboxes.default ?? host.builtin`
- `tools` 默认是 `full`
- `mentions` 默认是 `required`

换成大白话，route 的完整执行上下文在“配置加载完成”那一刻就已经确定了。

## BindingResolver 为什么是个运行时对象

很多人看到 resolver，会觉得它只是个“查 map 的包装”。

但 `BindingResolver` 现在保留成独立对象，其实是因为它还承载了一些运行时语义：

- 把 `bindings.items` 预编译成 `connectorId + source.type + source.id` 的 key
- direct message 时回落到 `bindings.default`
- source 为空或不完整时，在 DM 场景也能优雅 fallback

核心行为大概是：

```ts
resolve(connectorId, source, { isDirectMessage }) {
  return bindingsBySource.get(`${connectorId}:${source.type}:${source.id}`)
    ?? (isDirectMessage ? defaultBinding : null)
}
```

这类对象看上去很薄，但它让 Gateway 不需要反复自己拼 key、自己判断 DM fallback。

## Discord 线程为什么还是按父频道 binding

这是一个很好的 routing 语义例子。

当前 Discord connector 会把：

- `chatId` 设成真实线程 ID
- `threadId` 也保留线程 ID
- `source.id` 则在有父频道时写成父频道 ID

这样做的好处是：

- 绑定规则仍然按“这个线程属于哪个父频道”来匹配
- 但 conversation key 仍然按真实线程隔离

这样一来，Routing 和 Runtime 各自拿的都是自己真正关心的身份。

这是把“入口归属”和“会话边界”拆开的一个非常典型的例子。

## 路径归一化为什么也放在 Routing

当前 `loadGatewayConfig(...)` 会在这里把这些路径都转成绝对路径：

- `data.rootDir`
- `projectRoot`
- `systemPromptFile`

这样做不是为了“看起来整洁”，而是为了避免后面每一层都各自猜路径，最后猜出三套答案。

对宿主类项目来说，这种归一化越早做越好。因为一旦 `start`、`doctor`、`config`、Gateway 运行时各自对路径有不同理解，问题会非常难查。

## 什么时候该改 Routing，而不是改别层

下面这些需求，通常都应该优先改 Routing：

- 想新增一种 binding source 语义
- 想增加 route 的默认值继承规则
- 想让 direct message 走默认 route
- 想禁止某类历史配置写法
- 想增加 route 级执行策略字段

反过来，如果你只是想：

- 改平台 SDK 到 `InboundEnvelope` 的映射 -> 改 Connector
- 改消息编排顺序 -> 改 Gateway
- 改会话取消 / reset -> 改 Runtime

这样边界才不会乱。

## 结论

Routing 干的不是“记门牌”，而是把这次差事的执行上下文写成一张完整任务卡。

任务卡写稳了，Gateway 才能专心编排，Provider 才能专心跑 agent，Connector 也不用偷偷背着入口映射到处跑。

下一篇我们继续往下钻 Runtime：为什么一个 IM-first 的宿主系统，最终一定会长出会话串行、取消和 reset 这层。
