# 扩展系统架构（V3）

## 1. 目标

V3 将扩展系统对齐 VSCode extension 使用体验：

- 扩展按需下载与安装。
- 扩展在独立目录管理，不污染宿主依赖树。
- 启用与安装分离：配置声明启用，扩展目录提供安装事实。
- 宿主不再提供任何 `plugins/*` 或 `dist/plugins/*` 回退加载。

## 2. 核心模型

### 2.1 安装目录

- 扩展 store 固定在 `<data.rootDir>/extensions`。
- 目录结构：
  - `<data.rootDir>/extensions/package.json`
  - `<data.rootDir>/extensions/package-lock.json`
  - `<data.rootDir>/extensions/node_modules/*`

### 2.2 配置语义

- `extensions.allowList`：声明哪些包允许加载。
- `providers/connectors/sandboxes.items`：绑定 `type + inline config`。
- `routes`：定义可复用的执行 profile。
- `bindings`：把 connector source 绑定到 route。

新增不变量：
- allowList 中每个启用包必须能从扩展 store 解析；否则启动 fail-fast。

### 2.3 Manifest 约束

- 扩展包必须包含 `dobby.manifest.json`。
- `contributions[*].entry` 必须是插件包内构建好的 JS 入口（`.js/.mjs/.cjs`）。
- entry 必须位于插件包根目录内部（禁止越界路径）。
- 仓库里的 `plugins/*` 仅作源码参考，宿主不会回退加载这些源码路径。

## 3. 宿主职责边界

宿主仅负责：

- 读取配置
- 从扩展 store 解析 allowList 包
- 解析 manifest 并动态 import entry
- 注册 contribution 并实例化 provider/connector/sandbox
- 运行 gateway 主流程

宿主不负责：

- 插件源码热加载
- 插件开发态 fallback
- 自动改写用户配置

## 4. CLI 设计

在 `src/main.ts` 提供子命令：

- `extension install <packageSpec>`
  - 执行：`npm install --prefix <extensionsDir> --save-exact <packageSpec>`
  - 输出：已安装包、contributions、可粘贴配置模板（allowList + instances）
- `extension uninstall <packageName>`
  - 执行：`npm uninstall --prefix <extensionsDir> <packageName>`
- `extension list`
  - 列出扩展 store 中已安装包及其 contributions

`start` 命令（默认）维持网关启动逻辑。

## 5. 加载流程

1. 读取 `gateway.json` 并归一化 `data.rootDir`。
2. 计算 `extensionsDir = <data.rootDir>/extensions`。
3. 使用 `createRequire(<extensionsDir>/package.json)` 解析 allowList 包。
4. 读取并校验 manifest。
5. 动态加载 contribution entry。
6. 进行 contribution kind 一致性校验。
7. 注册并实例化所需实例。

## 6. 错误策略

### 6.1 缺包

当 allowList 包无法解析时，直接启动失败，并输出明确命令：

`dobby extension install <package>`

### 6.2 非法 manifest / entry

以下情况直接启动失败：

- manifest 不存在或结构非法
- entry 非 JS 文件
- entry 指向包外路径
- entry 文件不存在
- contribution kind 与模块导出不一致

## 7. 插件包契约（发布侧）

- 第三方依赖放在插件自身 `dependencies`。
- `@dobby.ai/plugin-sdk` 作为插件契约依赖（`peerDependencies`，且不应标记为 optional）。
- `@dobby.ai/plugin-sdk` 的 peer range 需要与当前已发布 sdk 版本保持兼容，避免 `dobby init` / `extension install` 后运行时缺包。
- connector capability 需显式声明 `updateStrategy`（`edit | final_only | append`），由网关统一决定出站发送策略（update / final-only / append）。
- 开发态可通过 `devDependencies` 使用 `file:../plugin-sdk`，保证本地类型可用；运行态不依赖宿主回退。
- 插件运行时不得依赖宿主源码路径或宿主 dist 路径。

## 8. Breaking 变更总结

- 宿主 `package.json` 不再使用 `file:plugins/*` 依赖。
- 宿主编译边界收敛到 `src/**/*.ts`。
- 插件入口不再 `try src / catch dist`。
- manifest entry 改为包内 dist JS。
- 插件 npm scope 统一为 `@dobby.ai/*`（旧 `@dobby/*` 配置需手动迁移）。

## 9. 验收基线

1. allowList 缺包时，启动 fail-fast，报错含 install 命令。
2. 安装扩展后启动成功，日志可见已加载包和 contributions。
3. 根 `node_modules` 中存在同名包时，loader 不回退解析（只认扩展 store）。
4. `extension install` 输出模板可直接用于 `gateway.json`。
5. `npm run check` 与 `npm run build` 通过。
