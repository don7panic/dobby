# im-agent-gateway

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
- `extension install <packageSpec> --config <path>`
- `extension uninstall <packageName> --config <path>`
- `extension list --config <path>`

## 快速开始

1. 安装宿主依赖

```bash
npm install
```

2. 构建宿主

```bash
npm run build
```

3. 准备配置

```bash
cp config/gateway.example.json config/gateway.json
cp config/models.custom.example.json config/models.custom.json
```

4. 按需安装扩展（最小可运行）

```bash
npm run start -- extension install @im-agent-gateway/provider-pi --config ./config/gateway.json
npm run start -- extension install @im-agent-gateway/connector-discord --config ./config/gateway.json
```

5. （可选）安装 Claude / sandbox 扩展

```bash
npm run start -- extension install @im-agent-gateway/provider-claude --config ./config/gateway.json
npm run start -- extension install @im-agent-gateway/sandbox-core --config ./config/gateway.json
```

6. 设置环境变量并启动

```bash
export DISCORD_BOT_TOKEN=...
npm run start -- --config ./config/gateway.json
```

## 本地插件开发（plugins 目录）

`plugins/*` 目录用于本地开发插件源码。宿主构建不会编译它们，需要插件各自构建。

1. 安装插件开发依赖

```bash
npm run plugins:install
```

2. 构建本地插件

```bash
npm run plugins:build
```

3. 把本地插件安装到扩展 store

```bash
npm run start -- extension install file:./plugins/provider-pi --config ./config/gateway.json
npm run start -- extension install file:./plugins/connector-discord --config ./config/gateway.json
```

说明：
- `@im-agent-gateway/plugin-sdk` 在插件中按 `peerDependencies`（可选）声明，开发态通过 `devDependencies` 的 `file:../plugin-sdk` 解决类型依赖。
- 运行态只加载 `<data.rootDir>/extensions/node_modules`，不会回退到宿主 `plugins/*`。

## 配置语义

- `extensions.allowList`：声明“允许并启用”的扩展包。
- `providers/connectors/sandboxes.instances`：实例化 contribution。
- `routing`：绑定 channel -> route -> provider/sandbox。

注意：
- `allowList` 与安装状态分离。即使配置了 allowList，包未安装也会启动失败。
- 扩展安装/卸载不会自动修改 `gateway.json`。

## 插件契约（作者侧）

- 必须包含 `im-agent-gateway.manifest.json`。
- `manifest.contributions[*].entry` 必须指向插件包内构建好的 JS 文件（如 `./dist/contribution.js`）。
- 插件第三方依赖必须放在插件自身 `dependencies`。
- 插件实现不得依赖宿主源码路径或宿主构建产物路径。

## 开发检查

```bash
npm run check
npm run build
```
