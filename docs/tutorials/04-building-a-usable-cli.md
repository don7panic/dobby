# 教程 04：怎么把 CLI 做成这个项目真正的控制面

上一篇我们把庄园地图摊开看了一遍。这一篇先别急着冲进主消息链路，先解决一个很现实的问题：

你总不能靠对着家养小精灵大喊大叫来运维整套系统。

很多人做这类项目，第一反应都是先把 bot 接上模型。这当然没错；但只做这一步，项目通常只能停留在“你自己在本机上勉强跑”。
只要开始出现初始化、配置、诊断、扩展和调度这些问题，CLI 就不再是包装层，而是工牌、说明书、值班室和配电箱。

## 先把 CLI 当成控制面，不要当成命令集合

你如果把 CLI 只当成“多几个命令”，写出来的东西通常会很散。

更实用的想法是：

- Gateway 负责处理消息
- Provider 负责调 agent
- Connector 负责接平台
- CLI 负责让人能启动、配置、检查、扩展、调度和观察这个系统

翻成人话，CLI 处理的是“人怎么和宿主打交道”，不是“人怎么猜宿主今天心情好不好”。

一旦你用这个角度去看，很多命令为什么存在就很清楚了。

## 第一步：顶层命令先收住，不要一上来铺太开

当系统已经准备从单入口 demo 走向可维护宿主时，CLI 不需要花哨，但最值得先收住的是下面几类：

- `start`
- `init`
- `doctor`
- `config ...`
- `extension ...`
- `cron ...`
- `connector status`

一个够用的顶层注册方式长这样就可以：

```ts
program
  .name('dobby')
  .version(version)
  .action(async () => {
    await runStartCommand()
  })

program.command('start').action(runStartCommand)
program.command('init').action(runInitCommand)
program.command('doctor').action(runDoctorCommand)

const config = program.command('config')
config.command('show').action(runConfigShowCommand)
config.command('list').action(runConfigListCommand)

const extension = program.command('extension')
extension.command('install').action(runExtensionInstallCommand)
extension.command('list').action(runExtensionListCommand)
```

这里有两个点很值得学：

- 默认动作直接等价于 `start`，这样常驻进程的使用成本最低
- 顶层只做命令注册，真正逻辑都在 `runXxxCommand` 里

不要把业务写在命令注册回调里，不然 CLI 很快会变成一团打结的绳子，最后连你自己都懒得碰。

## 第二步：先解决“配置到底从哪来”

一个宿主型项目，CLI 最容易把人绕晕的地方就是配置路径。

如果你不先把这件事说清楚，后面所有命令都会变得不稳定。

一个很实用的优先级就是：

1. 环境变量显式指定
2. 当前仓库里的本地配置
3. 默认家目录配置

这类逻辑写成函数后，所有命令都可以共用：

```ts
function resolveConfigPath() {
  if (process.env.DOBBY_CONFIG_PATH) {
    const explicit = expandHome(process.env.DOBBY_CONFIG_PATH)
    return isAbsolute(explicit) ? resolve(explicit) : resolve(process.cwd(), explicit)
  }

  const repoConfig = findDobbyRepoConfigPath(process.cwd())
  if (repoConfig) {
    return repoConfig
  }

  return resolve(homedir(), '.dobby', 'gateway.json')
}
```

这看起来只是个小工具函数，但其实决定了整个 CLI 是否稳定。

因为只要 `start`、`init`、`doctor`、`config`、`extension`、`cron` 不共享同一套路径规则，用户很快就会乱。

## 第三步：先把 `start` 做成真正的装配命令

`start` 不应该只是 `main()` 的别名。它更像“把小精灵叫醒、穿好工服、送去值班”的整套装配动作。

它真正要做的是把宿主完整装起来：

- 读配置
- 确保数据目录存在
- 加载扩展
- 实例化 provider / connector / sandbox
- 创建 Gateway
- 启动 cron
- 挂接状态发布和优雅退出

一个典型骨架大概像这样（省略了 connector status snapshot、cron store 和优雅退出这些样板）：

```ts
async function runStartCommand() {
  const configPath = resolveConfigPath()
  const config = await loadGatewayConfig(configPath)
  const logger = createLogger()

  await ensureDataDirs(config.data.rootDir)

  const loader = new ExtensionLoader(logger, {
    extensionsDir: extensionStoreDir(config),
  })
  const loadedPackages = await loader.loadAllowList(config.extensions.allowList)

  const registry = new ExtensionRegistry()
  registry.registerPackages(loadedPackages)

  const hostContext = { logger, configBaseDir: dirname(configPath) }
  const activeProvidersConfig = selectProviderInstances(config)
  const activeSandboxesConfig = selectSandboxInstances(config)
  const providers = await registry.createProviderInstances(activeProvidersConfig, hostContext, config.data)
  const connectors = await registry.createConnectorInstances(config.connectors, hostContext, config.data.attachmentsDir)
  const sandboxes = await registry.createSandboxInstances(activeSandboxesConfig, hostContext)

  const executors = new Map<string, Executor>()
  executors.set('host.builtin', new HostExecutor(logger))
  for (const [sandboxId, sandbox] of sandboxes) {
    executors.set(sandboxId, sandbox.executor)
  }

  // 省略 routeResolver / bindingResolver / dedupStore / runtimeRegistry / cronConfig / cronStore 的构造
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
  const cron = new CronService({ config: cronConfig, store: cronStore, gateway, logger })

  await gateway.start()
  await cron.start()
}
```

写 `start` 的时候，最重要的原则不是“把所有事情都塞进去”，而是“让所有装配步骤都只在一个地方发生”。

这样你后面排查问题时，入口会非常清楚。

## 第四步：`init` 不要做成全自动配置器，要做成靠谱的起步器

很多项目的 `init` 最大的问题是太贪心，想一次帮用户做完所有配置，最后搞得自己也很脆。

`dobby` 现在这个方向里，`init` 最值得参考的是它很克制：

- 只让用户选高层 starter
- 自动安装必需扩展
- 生成一份可运行的模板配置
- 把真实值留成占位符，等用户自己改

一个很像样的流程其实是：

```ts
const input = await collectInitInput()
const selected = createInitSelectionConfig(input.providerChoiceIds, input.connectorChoiceIds, {
  routeProviderChoiceId: input.routeProviderChoiceId,
  defaultProjectRoot: process.cwd(),
})

const nextConfig = ensureGatewayConfigShape({})
const rootDir = resolveDataRootDir(configPath, nextConfig)
const manager = new ExtensionStoreManager(createLogger(), `${rootDir}/extensions`)
// 把 selected 里的 provider / connector / route / binding 模板写进 nextConfig
const extensionInstallSpecs = await resolveExtensionInstallSpecs(selected.extensionPackages)
await manager.installMany(extensionInstallSpecs)
const validatedConfig = await applyAndValidateContributionSchemas(configPath, nextConfig)
await writeConfigWithValidation(configPath, validatedConfig)

console.log('Next steps:')
console.log('1. Edit gateway.json and replace placeholders')
console.log('2. Run dobby doctor')
console.log('3. Run dobby start')
```

这类 `init` 的重点不在“替用户决定一切”，而在“帮用户跨过最容易卡住的第一步”。

## 第五步：`doctor` 是这个项目最值钱的命令之一

如果你的项目配置稍微复杂一点，`doctor` 往往会比你想象中更重要。

因为用户真正遇到的，通常不是程序 bug，而是这些问题：

- 扩展没装
- contribution id 配错了
- token 还是占位符
- project root 路径不对
- 默认 provider / route / binding 不成立

所以 `doctor` 最好做成一轮保守检查，而不是一句“配置无效”。

一个很典型的检查骨架是：

```ts
const issues = []

try {
  await loadGatewayConfig(configPath)
} catch (error) {
  issues.push(`config validation failed: ${error.message}`)
}

for (const packageName of enabledPackages) {
  if (!installedPackages.has(packageName)) {
    issues.push(`extension '${packageName}' is enabled but not installed`)
  }
}

for (const hit of findPlaceholderValues(rawConfig)) {
  issues.push(`${hit.path} still uses placeholder '${hit.value}'`)
}
```

好的 `doctor` 有一个标准：

看完输出以后，用户知道下一步自己该改什么。

不是只知道“哪里错了”，而是知道“现在该去改哪一项”。

## 第六步：`config` 命令解决的是可见性，不是编辑器替代品

很多人会想把 `config` 做成一个超完整的交互式配置器。其实没必要一开始就走这么远。

更实际的做法是先解决 3 件事：

- 看全量配置
- 看某一段配置
- 看某一类扩展 schema

一个最小版本只要有这些就已经很能用了：

```ts
config.command('show')
config.command('list')

const schema = config.command('schema')
schema.command('list')
schema.command('show <contributionId>')
```

这套命令的价值不是“替代手改 JSON”，而是：

- 让用户知道当前到底配了什么
- 让用户知道某个 contribution 期待什么字段
- 让 CLI 和配置模型之间保持同步

说白了，`config` 先解决“看得见”，再考虑“改得爽”。

## 第七步：`extension` 命令要把“安装”和“启用”分开

这一点非常关键。

很多宿主项目会把“包已经存在”和“系统现在允许加载它”混成一件事，后面就很难解释。

更清晰的做法是分两步：

- 安装到 extension store
- 决定是否写进 allowList / 模板实例

所以一个更靠谱的命令语义是：

```bash
dobby extension install @scope/provider-x
dobby extension install @scope/provider-x --enable
dobby extension list
```

实现上也应该分开：

```ts
const installed = await manager.install(spec)

if (enable) {
  upsertAllowListPackage(config, installed.packageName, true)
  const templates = buildContributionTemplates(installed.manifest.contributions)
  applyContributionTemplates(config, templates)
}
```

这样做最大的好处是：

当用户问“为什么这个包已经装了但系统没在用”，你有清楚的答案。

## 第八步：`cron` 命令不要直接执行任务，它只负责管理调度状态

这是很多人第一次做 CLI 时会写歪的地方。

更稳的做法是：

- `cron add`、`cron update`、`cron pause`、`cron resume`、`cron remove` 改的是 store 里的 job
- 真正的执行由常驻的 gateway 进程去消费

所以一个命令侧的“手动运行”本质上也只是排队，而不是自己直接把任务跑掉：

```ts
await store.updateJob(jobId, (current) => ({
  ...current,
  state: {
    ...current.state,
    manualRunRequestedAtMs: Date.now(),
  },
}))
```

然后 CLI 再明确告诉用户：

- 我已经排队了
- 你得保证 `dobby start` 正在跑
- 这不会改掉原来的 schedule

这类语义特别重要。因为一旦 CLI 和常驻调度器各跑各的，你后面状态一定会乱。

## 第九步：`connector status` 这种命令，最好只读快照，不要直连运行时

当系统开始有“运行中状态”以后，CLI 又会面临一个选择：

是去直连长进程，还是读一个稳定的状态快照？

对于这种本地宿主项目，读快照通常会更稳。

思路一般是：

- gateway 周期性把 connector 健康状态写到 state 目录
- CLI 只负责读这份快照并展示

例如：

```ts
const snapshot = await readConnectorStatusSnapshot(statusPath)
const items = connectorId
  ? snapshot.items.filter((item) => item.connectorId === connectorId)
  : snapshot.items

renderTable(items)
```

这样做的好处很实在：

- CLI 不需要自己维持连接
- 运行中的 gateway 不会被状态查询命令干扰
- 你还能顺手做 stale 检测，告诉用户“快照过期了，进程可能没在跑”

## 第十步：好的 CLI 不是命令多，而是每条命令都知道自己的边界

最后给你一个很好用的判断法。以后每加一条命令，先问自己：

这条命令到底在做哪一类事？

- 装配运行时：`start`
- 生成起步配置：`init`
- 做保守诊断：`doctor`
- 暴露配置可见性：`config ...`
- 管理扩展生命周期：`extension ...`
- 管理调度状态：`cron ...`
- 读取运行快照：`connector status`

如果一条命令同时想干三件事，那它大概率已经写歪了。

## 结论

对于这种 IM <-> local agent 宿主项目来说，CLI 更像给 dobby 配的前台和工牌：

- 人类得有地方启动它
- 得有地方给它初始化配置
- 得有地方查它现在配成什么样
- 得有地方装新工具、管 cron、看运行状态

前台立住了，宿主才不会看起来像一堆只能靠口口相传维护的脚本。

下一篇我们回到主链路本身，去看真正负责“任务怎么过总台”的 Gateway。
