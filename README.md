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

## 测试

```bash
cd gbajs2 && node test/extension-test.mjs && node test/tool-exec-test.mjs && node test/studio-test.mjs
cd pi-web && node test/gba-workbench-test.mjs && node test/piweb-integration-test.mjs
```

## 关键约定

- **构建链路三步**（顺序固定）：`next build` → `build-payload.mjs` → `tauri build`；payload 实体落短路径 `D:\gbfp`（junction 挂回 `app/src-tauri/payload`），resources 必须用相对路径 `payload/**/*`。
- **skill/扩展双副本纪律**：`gbajs2/.pi` 与 `pi-web/.pi` 两份副本改动需同步；`build-payload.mjs` 以 `pi-web/.pi` 为准组装 payload。
- **用户数据与引擎分离**：翻译工程（与 ROM 绑定）在安装路径 `data/workspace/projects/` 动态创建，不入 payload。
