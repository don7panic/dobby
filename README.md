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
- `config get|set|unset`
- `extension install <packageSpec> --config <path>`
- `extension uninstall <packageName> --config <path>`
- `extension list --config <path>`
- `doctor [--fix]`

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
dobby init --preset discord-pi
```

如果你是从源码直接运行（未全局安装 `dobby`），可用：

```bash
npm run start -- init --preset discord-pi
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
dobby extension install @dobby/provider-claude-cli --enable
dobby extension install @dobby/sandbox-core --enable
```

运行前检查（推荐）：

```bash
dobby doctor
```

默认配置文件路径为：`$HOME/.dobby/gateway.json`。如需兼容旧项目，可继续通过 `--config <path>` 指定任意路径。
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
- `@dobby/plugin-sdk` 在插件中按 `peerDependencies`（可选）声明，开发态通过 `devDependencies` 的 `file:../plugin-sdk` 解决类型依赖。
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
