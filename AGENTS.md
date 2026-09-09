# AGENTS.md — GBA Font Studio 仓库根（pi agent 导航）

本仓库是 GBA 宝可梦改版 ROM 中文字库/汉化工具集 monorepo。**历史方案文档**（早期
"Hook 自动破解"设计稿）已移至 `docs/历史-GBA字体自动破解技术方案.md`；现行方案以
`gbajs2/.pi/skills/` 两个 SKILL.md 与 `gbajs2/docs/` 案例实录为准。

## 目录地图（agent 应优先阅读的入口）

| 路径 | 作用 | 细节入口 |
|---|---|---|
| `gbajs2/` | 模拟器引擎 + `romctl.js` 无头调试（serve :8645）+ skill 原始副本 + 领域扩展 + memview + docs | `gbajs2/AGENTS.md` |
| `pi-web/` | 工作台（Next.js 六面板）+ `gba/` 自包含引擎 + `.pi/skills`、`.pi/extensions` 规范源 + 测试 | `pi-web/AGENTS.md` |
| `app/` | Tauri 桌面客户端（面向新用户分发） | `app/README.md` |
| `gbajs2/.pi/skills/gba-font-crack/` | 字库注入/渲染引擎破解配方（SKILL.md + cases 实录） | 其 SKILL.md |
| `gbajs2/.pi/skills/gba-text-translate/` | 文本汉化流水线（导出/机翻/门禁/回填） | 其 SKILL.md |
| `fonts/` | 码表/字库源文件 | — |

## 常用命令（Windows + Git Bash）

```bash
# 无头调试（引擎在 gbajs2，工作区=仓库根）
cd gbajs2 && node romctl.js serve            # :8645；/status /load /run /key /shot /memread /disasm /snap …

# 工作台
cd pi-web && npx next dev                    # 开发态；生产: npx next build && npx next start

# 客户端安装包（顺序固定）
cd pi-web && npx next build                  # Turbopack；--webpack 会 OOM
cd app && node build-payload.mjs             # payload → D:\gbfp（junction 挂回 src-tauri/payload）
npx tauri build --bundles nsis               # NSIS 安装包

# 测试
cd gbajs2 && node test/extension-test.mjs && node test/tool-exec-test.mjs && node test/studio-test.mjs
cd pi-web  && node test/gba-workbench-test.mjs && node test/piweb-integration-test.mjs
```

## 关键约定（踩坑总结，改动前必读）

1. **构建链路三步顺序固定**：`next build` → `build-payload.mjs` → `tauri build`。
   payload 实体落短路径 `D:\gbfp`（junction 挂回 `app/src-tauri/payload`，NSIS 源路径
   >260 字符会失败）；`tauri.conf.json` 的 resources 必须是相对路径 `payload/**/*`。
   重打包前清掉 `app/src-tauri/target/release/payload|_root_` 旧 staging。
2. **skill/扩展双副本**：`gbajs2/.pi` 与 `pi-web/.pi` 内容需保持同步（历史上曾漂移）；
   payload 组装以 `pi-web/.pi` 为准。
3. **用户数据与引擎分离**：翻译工程（与 ROM 绑定）在安装路径 `data/workspace/projects/`
   运行时创建，不入 payload；romctl/扩展经 `GBA_WORKSPACE_DIR` / `ctx.cwd` 解析。
4. **客户端无黑框**：release 主程序 GUI 子系统；子进程 `CREATE_NO_WINDOW`/`windowsHide`；
   日志统一 `data/logs/`。
5. **romctl serve v3+**：锁文件随 romctl 本体（`tmp/serve.lock`）；不自动弹 memview；
   无人观看也持续推进模拟器；`/run`、`/key` 分片让出事件循环；`/status` 带 `v` 版本号。
6. **构建输出勿用管道吞错**：`next build` 失败曾被 `tail -1` 掩盖，导致"源码已改
   页面未变"的排查弯路。

## 测试基线

- `gbajs2/test/`：扩展注册（18 工具）、工具执行、serve 端点
- `pi-web/test/`：工作台六面板浏览器冒烟、集成
- 客户端：装机后三端 200（pi-web :30141 / romctl :8645 / 工作台前端）+ agent 实战
  （rom_load → rom_run → rom_screenshot 不产生 gba/ 自愈拷贝）
