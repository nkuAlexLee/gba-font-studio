# GBA Font Studio（pi-gba-fontpatch）

GBA 宝可梦改版 ROM 中文字库破解与汉化工具集：**模拟器引擎 + 无头调试工具 + AI Agent 技能/扩展 + Web 工作台 + Tauri 桌面客户端** 全链路 monorepo。

- 渲染引擎与字库注入方案：见 `gbajs2/.pi/skills/gba-font-crack/SKILL.md`
- 文本汉化流水线：见 `gbajs2/.pi/skills/gba-text-translate/SKILL.md`
- 桌面客户端使用与构建：见 `app/README.md`
- 全量设计文档（as-built）：见 `gbajs2/docs/GBA字库Agent可视化设计方案.md`

## 仓库结构

| 目录 | 内容 |
|---|---|
| `gbajs2/` | gbajs2 模拟器引擎源、`romctl.js` 无头调试工具（HTTP serve：帧推进/截图/内存/反汇编/hook）、两个 pi skill（`gba-font-crack` 字库破解 / `gba-text-translate` 文本汉化）原始副本、领域扩展 `gba-fontpatch`（18 个结构化工具）、memview 可视化、`docs/`（设计文档 + 案例实录） |
| `pi-web/` | 工作台前端/服务端（Next.js：模拟器画面/流水线/会话回放/码表/审校/内存反汇编 六面板）+ `gba/` 自包含引擎 + `.pi/skills`、`.pi/extensions` 规范源 + UI 测试 |
| `app/` | Tauri 桌面客户端：Rust bootstrap（首启建工作区/欢迎会话/拉起双服务/AV 自愈）、`build-payload.mjs` 打包脚本、捆绑 Git Bash |
| `fonts/` | 字库/码表源文件 |

**不入仓**（`.gitignore`）：`node_modules`/`.next`/`src-tauri/target` 等构建产物、payload 实体（`D:\gbfp`，由脚本再生）、版权 ROM（仅示例 `pker.gba` 入库）、用户数据（`data/`、翻译工程 `report/out`）。

## 快速开始（开发态）

```bash
# 1) 工作台
cd pi-web && npm install && npx next dev     # 或 npx next build + start

# 2) 无头调试引擎（独立可用）
cd gbajs2 && node romctl.js serve            # 默认 :8645；ROM 放 gbajs2/roms/
#    工作台页面: pi-web 同源 /gba-studio/index.html?api=http://127.0.0.1:8645

# 3) 桌面客户端安装包
cd app && npm install
cd ../pi-web && npx next build               # Turbopack（--webpack 会 OOM）
cd ../app && node build-payload.mjs          # 组装 payload → D:\gbfp（junction 挂回 src-tauri/payload）
npx tauri build --bundles nsis               # 产物: src-tauri/target/release/bundle/nsis/*-setup.exe
```

## 构建 GBA Font Studio 桌面客户端

### 前置依赖
- **Node.js ≥ 20**（pi-web 构建 + payload 内捆绑 runtime 用同版本）
- **Rust stable-msvc**（`rustup`，需 MSVC 工具链 + WebView2，Win10/11 默认自带）
- **Git for Windows**（提供 bash；`build-payload.mjs` 捆绑其 `usr/bin` 进安装包，
  可用 `GBA_GITBASH_SRC` 指向其他 Git 安装）
- NSIS 由 tauri-cli 首次构建自动下载

### 构建步骤（顺序固定，三步缺一不可）
```bash
# 1) 工作台生产构建（Turbopack；勿加 --webpack，会 OOM）
cd pi-web && npm install && npx next build

# 2) 组装 payload（约 900MB → D:\gbfp\payload，junction 挂回 app/src-tauri/payload）
cd ../app && npm install
node build-payload.mjs              # 完整构建
# 增量: node build-payload.mjs --skip-next-build --skip-node-modules

# 3) 打 NSIS 安装包
npx tauri build --bundles nsis
# 产物: app/src-tauri/target/release/bundle/nsis/GBA Font Studio_*-setup.exe（~200MB）
```

### 环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| `GBA_PAYLOAD_DIR` | `D:\gbfp` | payload 实体目录（必须短路径，NSIS 限制 >260 字符源路径） |
| `GBA_GITBASH_SRC` | `D:\Program Files\Git` | 捆绑 Git Bash 来源 |
| `GBA_SERVE_PORT` / `GBA_WORKSPACE_DIR` 等 | — | 见 `app/README.md` |

### 首次安装行为（新用户视角）
安装后首启自动：创建 `data/workspace`（含两个 skill 全套 + 扩展 + 示例 ROM `pker.gba`）
与 `data/agent`（含欢迎会话、捆绑 bash 的 shellPath）→ 拉起 pi-web(:30141) 与
romctl serve(:8645) → 打开工作台窗口。全程无需配置 Node/Python/WSL。

### 故障排查
- 构建被打断后再打包：先删 `app/src-tauri/target/release/payload`、`_root_` 旧 staging
- 安全软件拦截首启回环连接：客户端会自动杀树回退系统 node；仍失败请把安装目录加信任
- NSIS **静默**安装（/S）可能被安全软件挂起：GUI 双击安装正常

## 测试

```bash
cd gbajs2 && node test/extension-test.mjs && node test/tool-exec-test.mjs && node test/studio-test.mjs
cd pi-web && node test/gba-workbench-test.mjs && node test/piweb-integration-test.mjs
```

## 关键约定

- **构建链路三步**（顺序固定）：`next build` → `build-payload.mjs` → `tauri build`；payload 实体落短路径 `D:\gbfp`（junction 挂回 `app/src-tauri/payload`），resources 必须用相对路径 `payload/**/*`。
- **skill/扩展双副本纪律**：`gbajs2/.pi` 与 `pi-web/.pi` 两份副本改动需同步；`build-payload.mjs` 以 `pi-web/.pi` 为准组装 payload。
- **用户数据与引擎分离**：翻译工程（与 ROM 绑定）在安装路径 `data/workspace/projects/` 动态创建，不入 payload。
