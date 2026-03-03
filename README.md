# dobby

Discord-first 本地 Agent Gateway（扩展系统 v3）。

核心目标：
- 宿主只负责 gateway 核心与扩展加载。
- 插件按需安装到独立扩展目录（类似 VSCode extension）。
- `allowList` 只声明启用，不负责安装。

## 架构

- `src/core`：gateway 主流程、路由、去重、runtime registry。
- `src/extension`：扩展 store 管理、manifest 解析、扩展加载与注册。
- `src/sandbox`：执行器抽象与内置 host executor。
- `plugins/*`：插件包源码示例（发布后以外部 npm 包安装）。

说明：`plugins/*` 目录是源码参考，不是宿主运行时回退入口。插件包需要自行构建出 `dist/*.js` 后再发布/安装。

## 扩展安装模型（V3）

- 扩展安装目录固定为：`<data.rootDir>/extensions`。
- 扩展安装后位于：`<data.rootDir>/extensions/node_modules/*`。
- 启动时 loader 只从该目录解析扩展包。
- 若 `extensions.allowList` 中包未安装，启动会 fail-fast，并提示安装命令。

## CLI

网关二进制现在支持：

- `start`（默认）
- `init`
- `configure`
- `config show|list|edit`
- `config schema list|show`
- `bot list|set`
- `channel list|set|unset`
- `route list|set|remove`
- `extension install <packageSpec>`
- `extension uninstall <packageName>`
- `extension list`
- `doctor [--fix]`

## NPM Scope 变更（硬切）

- 扩展包 scope 已统一为 `@dobby.ai/*`。
- 旧 scope `@dobby/*` 不再保证可用。
- 现有配置需手动替换 `extensions.allowList[*].package` 中的包名。

## Config 命令变更（硬切）

- 路径式命令已移除：`config get|set|unset`
- 新命令：
  - `config show [section] [--json]`
  - `config list [section] [--json]`
  - `config edit`
  - `config schema list [--json]`
  - `config schema show <contributionId> [--json]`
  - `config edit` / `configure` 在 provider/connector 实例配置时会优先读取扩展 `configSchema` 动态提问（默认只问关键字段，advanced 选项按需展开；无 schema 时会先提示原因，再决定是否走 JSON 输入）
- 映射关系：
  - `config get ...` -> `config show` 或 `config list`
  - `config set ...` -> `config edit`
  - `config unset ...` -> 使用专用删除命令（如 `channel unset`、`route remove`、`extension uninstall`）

## 快速开始

1. 安装宿主依赖

```bash
npm install
```

2. 构建宿主

```bash
npm run build
```

3. 初始化配置（最小可运行）

```bash
dobby init
```

说明：`init` 现在会在交互中分开选择 provider 与 connector。
说明：`init` 在安装扩展后，会优先按扩展暴露的 `configSchema` 动态询问 provider/connector 的配置字段（当前 Discord connector 仍保留专用引导配置流程）。
说明：当选择多个 provider 时，`init` 会额外让你显式选择默认 route 绑定的 provider，且 `providers.defaultProviderId` 会跟随该选择。
说明：若选择 `provider.pi`，且 `models.custom.json` 不存在，`init` 会自动生成（仅缺失时生成，不覆盖已有文件）。
说明：`init` 现在是一次性命令；若配置已存在会直接失败，请改用 `dobby config edit` 或 `dobby configure`。

如果你是从源码直接运行（未全局安装 `dobby`），可用：

```bash
npm run start -- init
```

4. 启动

```bash
dobby start
```

源码运行方式：

```bash
npm run start --
```

5. （可选）安装并启用额外扩展

```bash
dobby extension install @dobby.ai/provider-claude-cli --enable
dobby extension install @dobby.ai/sandbox-core --enable
```

运行前检查（推荐）：

```bash
dobby doctor
```

配置路径优先级：
1. `DOBBY_CONFIG_PATH`（若设置）
2. 在 `dobby` 仓库内运行时自动使用 `./config/gateway.json`
3. 默认 `~/.dobby/gateway.json`

示例：

```bash
DOBBY_CONFIG_PATH=/tmp/gateway.dev.json npm run start -- config show providers --json
```
多 bot 场景建议为每个 Discord connector 实例配置独立的 `botName`、`botToken` 与 `botChannelMap`。

## 本地插件开发（plugins 目录）

`plugins/*` 目录用于本地开发插件源码。宿主构建不会编译它们，需要插件各自构建。
这些本地流程统一由 `scripts/local-extensions.mjs` 驱动。

1. 安装插件开发依赖

```bash
npm run plugins:install
```

说明：该命令只会安装 `plugins/*` 目录下各插件包的开发依赖，不会安装到运行时扩展目录。

2. 构建本地插件

```bash
npm run plugins:build
```

3. 把本地插件安装到扩展 store

```bash
npm run extensions:install:local
```

或一步完成开发依赖安装 + 构建 + 安装到扩展 store：

```bash
npm run plugins:setup:local
```

说明：
- `@dobby.ai/plugin-sdk` 在插件中按 `peerDependencies`（可选）声明，开发态通过 `devDependencies` 的 `file:../plugin-sdk` 解决类型依赖。
- 运行态只加载 `<data.rootDir>/extensions/node_modules`，不会回退到宿主 `plugins/*`。
- 默认配置 `$HOME/.dobby/gateway.json` 的 `data.rootDir` 为 `./data`，因此默认扩展安装目录是 `$HOME/.dobby/data/extensions`。

## 配置语义

- `extensions.allowList`：声明“允许并启用”的扩展包。
- `providers/connectors/sandboxes.instances`：实例化 contribution。
- `connectors.instances.<id>.config.botChannelMap`：绑定 channel -> route。
- `routing`：定义 route -> provider/sandbox。

注意：
- `allowList` 与安装状态分离。即使配置了 allowList，包未安装也会启动失败。
- 扩展安装/卸载不会自动修改 `gateway.json`。
- 默认 sandbox 是 `host.builtin`，可通过 `routing.routes.*.sandboxId` 覆盖到 docker/boxlite 实例。

## A2A Core（Draft）

`dobby` 提供轻量 A2A 基础能力（`delegate/status/cancel`），用于 route 之间的受控协作。  
默认关闭，显式 allowlist 放行；定位为“最小可定制内核”，不是平台型工作流系统。  
详见：`docs/A2A_CORE_DESIGN.md`

## 插件契约（作者侧）

- 必须包含 `dobby.manifest.json`。
- `manifest.contributions[*].entry` 必须指向插件包内构建好的 JS 文件（如 `./dist/contribution.js`）。
- 插件第三方依赖必须放在插件自身 `dependencies`。
- 插件实现不得依赖宿主源码路径或宿主构建产物路径。

## 开发检查

```bash
npm run check
npm run build
```

## 进一步文档

- 运行与排障手册：`<repo-root>/docs/RUNBOOK.md`
- 扩展系统设计：`<repo-root>/docs/EXTENSION_SYSTEM_ARCHITECTURE.md`
