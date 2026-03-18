# 教程 09：为什么扩展系统和执行环境能让宿主保持瘦

上一篇我们管住了 dobby 怎么回话。现在来看另一件会越长越痛的事：别让它每学一个新本事，你都得剖开宿主核心做一次手术。

扩展系统和执行环境，更像是给家养小精灵准备工具房、鞋柜和不同工种，而不是每来一把新扫帚就重修整栋房子。

## 先把扩展系统拆成 3 个动作来看

落到代码里，扩展系统可以拆成 3 个阶段：

1. 安装：把包装进本地 extension store
2. 加载：只从 allowList + extension store 里解析可加载包
3. 注册 / 实例化：把 contribution 变成 provider / connector / sandbox 实例

这三个阶段各管一摊事，所以专门拆成了不同模块：

- `ExtensionStoreManager`
- `ExtensionLoader`
- `ExtensionRegistry`

这套拆法非常值得保留，因为“包怎么装进来”和“运行时怎么被允许加载”真的不是一回事。

## 为什么要有独立的 extension store

当前扩展安装目录固定在：

- `<data.rootDir>/extensions`

这意味着宿主不会去：

- 自己的依赖树里乱找包
- `plugins/*` 源码目录里 fallback
- 其他随便某个 node_modules 里碰运气

这样做的好处很直接，像把工具都收进同一个柜子里：

- 安装边界清楚
- 卸载和列举边界也清楚
- 运行时到底从哪加载扩展，不用猜

从长期维护角度看，这比“哪里能 resolve 到就先用哪里”稳太多了。

## `ExtensionStoreManager` 解决的是“包怎么进 store”

这一层现在走的是非常实用的方案：

- 用一个私有 `package.json` 当 extension store
- 用 `npm install --prefix <extensionsDir> --save-exact ...` 管理依赖
- 安装后再读取 manifest，确认真正装进来的包是谁

这套选择的优点是：

- 直接复用 npm 生态
- 本地路径、file spec、普通 npm spec 都能统一处理
- 不需要自己再造一个包管理器

对宿主类项目来说，这种“尽量借用成熟生态能力”的技术选型通常非常划算。

## `ExtensionLoader` 解决的是“哪些包真的能被运行时加载”

这一层做的事比看起来严格很多：

- 只加载 `allowList` 里启用的包
- 只从 extension store 里 resolve 包
- 读取 `dobby.manifest.json`
- 检查 contribution entry 必须是 `.js/.mjs/.cjs`
- 检查 entry 必须在包根目录内
- 检查模块导出的 `kind` 必须和 manifest 一致

主体流程大概像这样：

```ts
const packageJsonPath = extensionRequire.resolve(`${packageName}/package.json`)
const manifest = await readExtensionManifest(join(packageRoot, 'dobby.manifest.json'))

for (const contributionManifest of manifest.contributions) {
  const entryPath = resolve(packageRoot, contributionManifest.entry)
  assertWithinRoot(entryPath, packageRoot)
  const loadedModule = await import(pathToFileURL(entryPath).href)
  const contributionModule = pickContributionModule(loadedModule)
  // 校验 kind、entry、导出形状
}
```

这层看上去“限制很多”，其实是在保护宿主。宁可进门先查工牌，也别让来路不明的扫帚直接飞进客厅：

它宁可早点失败，也不愿意把一个不明确的包偷偷带进运行时。

## `ExtensionRegistry` 解决的是“贡献项怎么变成实例”

Loader 拿回来的是一批 contribution module；Registry 负责再做两件事：

- 把 contribution id 注册到 provider / connector / sandbox 分类表里
- 保存 `configSchema` catalog，供 CLI 和配置校验链路使用

然后再按实例配置去 create：

```ts
const providers = await registry.createProviderInstances(activeProvidersConfig, hostContext, config.data)
const connectors = await registry.createConnectorInstances(config.connectors, hostContext, config.data.attachmentsDir)
const sandboxes = await registry.createSandboxInstances(activeSandboxesConfig, hostContext)
```

这背后的架构含义是：

- package 只声明“我贡献了什么能力”
- 实例配置再决定“宿主实际启用了哪些实例”

这样一来，宿主就能做到：

- 同一种 contribution 可以实例化多次
- route 只引用实例 ID，不直接依赖包名
- CLI 能看到 schema，并按 schema 辅助配置

## Connector 为什么还要再包一层 `SupervisedConnector`

这是扩展系统里一个很实用的工程取舍。

当前 Registry 在创建 connector 实例后，不是直接把它交给 Gateway，而是再包成 `SupervisedConnector`。

这么做的目的不是“让类层级更复杂”，而是把运行期健康治理收口：

- 启动超时
- reconnect / degraded 状态监控
- 自动重启
- restart backoff
- 为上层状态快照提供稳定健康读数

这说明 `dobby` 对 connector 的定位不是“一个函数库”，而是“一个长期运行中的外部连接组件”。

这种组件如果不单独做 supervision，生产环境里会非常难用。

## Provider、Connector、Sandbox 为什么是三种 contribution

这三类 contribution 之所以分开，不是因为喜欢分类，而是因为宿主对它们的期待根本不同：

- Provider：创建 runtime，负责 agent 会话与事件
- Connector：接平台、发消息、声明平台能力
- Sandbox：提供 executor，决定命令在哪执行

如果把这三类抽象糊成一种“plugin”，宿主最终还是会在内部再重新区分一遍。

所以当前这套 contribution kind，其实是在把差异正大光明地放到类型系统和 manifest 里。

## 执行环境为什么是 `executor`，不是“让 Gateway 直接调用 docker”

当前 Gateway 最终只拿一个 `Executor` 接口，不直接关心：

- 这是宿主机执行
- 还是 boxlite
- 还是 docker

这就让 route 级 sandbox 选择变得很自然：

- `host.builtin` 永远存在
- 其他 sandbox 通过扩展贡献 executor
- Gateway 只按 route 的 `sandbox` 去找 executor map

这样做最大的好处是，执行环境变化不会污染主链路。

宿主要做的是“挑哪个 executor”，不是“学习每个 sandbox 的内部协议”。

## 什么时候该改扩展系统，而不是改核心层

通常这些需求应该优先落在扩展系统：

- 新增一个 provider 包
- 新增一个 connector 包
- 新增一个 sandbox 包
- 改 manifest 约束、entry 校验、安全边界
- 改扩展安装 / 卸载 / allowList 语义

而这些需求一般不该先动扩展系统：

- 主链路顺序变化 -> Gateway
- route 继承规则变化 -> Routing
- 会话 reset 语义变化 -> Runtime

## 结论

扩展系统和执行环境这层真正守住的，是“宿主核心只认契约，不认具体扫帚品牌”。

只要这层边界还稳，`dobby` 就可以继续长：多一种 Provider、多一个 Connector、多一个 Sandbox，都不应该逼你重写主链路。

下一篇我们看最后一个运行期增强层：Cron。重点不是它怎么定时，而是它为什么没有偷偷长成第二套执行系统。
