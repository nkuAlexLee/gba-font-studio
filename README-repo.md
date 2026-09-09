# GBA Font Studio（pi-gba-fontpatch）仓库结构

| 目录 | 内容 |
|---|---|
| `gbajs2/` | gbajs2 模拟器引擎源、romctl 无头调试工具、两个 pi skill（gba-font-crack / gba-text-translate）原始副本、领域扩展、memview、docs（含全部设计文档与案例） |
| `pi-web/` | 工作台前端/服务端（Next.js）+ `gba/` 自包含引擎 + `.pi/skills`、`.pi/extensions` 规范源 + UI 测试 |
| `app/` | Tauri 桌面客户端（`src-tauri/` Rust bootstrap、`build-payload.mjs` 打包脚本、`vendor/`） |
| `fonts/` | 字库/码表源文件 |

**不入仓**（见 `.gitignore`）：构建产物（`node_modules`/`.next`/`src-tauri/target`/payload 实体 `D:\gbfp`）、用户数据（`data/`、翻译工程 `report/out`）、版权 ROM（仅 `pker.gba` 示例 ROM 入库）。

**构建链路**：`pi-web: npx next build` → `app: node build-payload.mjs`（组装 payload 到 `D:\gbfp`，junction 挂回 `app/src-tauri/payload`）→ `npx tauri build --bundles nsis`。
详见 `app/README.md` 与 `gbajs2/docs/GBA字库Agent可视化设计方案.md`。
