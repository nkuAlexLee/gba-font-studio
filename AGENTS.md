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

# 客户端安装包一键构建（= 下面三步；失败即停不吞错；--with-test 先跑测试基线）
npm run build:desktop                        # 仓库根执行；可选 --skip-next/--skip-payload/--skip-tauri

# 客户端安装包手动分步（顺序固定，排查时用）
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
   ⚠ `--skip-next(-build)` 只省掉 next build 这一步，`.next` 仍必须复制进 payload
   （DEST 每次清空重建，跳过复制 = 安装后报 "Could not find a production build"，
   2026-09-10 产出过一版坏包）；打完包后必验 `payload/pi-web/.next/BUILD_ID` 存在。
   ⚠ 重装 payload（build-payload）前确认没有 makensis/tauri build 在跑——
   两者同时写 `D:\gbfp\payload` 会互击崩溃（双写者冲突，同 serve 锁纪律）。
2. **skill/扩展双副本**：`gbajs2/.pi` 与 `pi-web/.pi` 内容需保持同步（历史上曾漂移）；
   payload 组装以 `pi-web/.pi` 为准。
3. **用户数据与引擎分离**：翻译工程（与 ROM 绑定）在安装路径 `data/workspace/projects/`
   运行时创建，不入 payload；romctl/扩展经 `GBA_WORKSPACE_DIR` / `ctx.cwd` 解析。
   升级时 `init_workspace` 按 `.pi/.template-id` 指纹自动刷新工作区 `.pi/`（扩展/skill
   随包更新，不删除工作区自有文件）；AGENTS.md 仅在未被 agent/用户改动（哈希仍等于上次
   应用模板）时替换；roms/projects/work/sessions 永不触碰。
4. **客户端无黑框**：release 主程序 GUI 子系统；子进程 `CREATE_NO_WINDOW`/`windowsHide`；
   日志统一 `data/logs/`。
5. **romctl serve v3+**：锁文件随 romctl 本体（`tmp/serve.lock`）；不自动弹 memview；
   无人观看也持续推进模拟器；`/run`、`/key` 分片让出事件循环；`/status` 带 `v` 版本号。
6. **构建输出勿用管道吞错**：`next build` 失败曾被 `tail -1` 掩盖，导致“源码已改
   页面未变”的排查弯路。
7. **会话图片上限**：渠道对单请求图片数硬限 30（`Too many images: 31 > 30` 整请求 400）。
   gba-fontpatch 扩展三层防护：① **请求时虚拟化**（context 事件：会话文件原图保留，
   仅发送最近 `GBA_IMAGE_KEEP`（默认 4）张，其余替换为文本注记——主机制，上限从此不触发）；
   ② 虚拟化失效时按会话计数降级附图（阈值 25）并自动触发 compaction（`GBA_IMAGE_AUTOCOMPACT`，
   默认 20）；③ 恢复重会话时计数用 `sessionManager.buildContextEntries()`（进程 env 无
   PI_SESSION_FILE）。大窗口模型的自动 compaction 按 token 触发，兜不住图片数。
8. **pi-ai 预制供应商补丁**：`scripts/patch-pi-ai-ark.mjs` 把火山方舟 `ark-agent-plan` /
   `ark-coding-plan` 写为 pi-ai 内置供应商（凭据走 `ARK_AGENT_PLAN_API_KEY` /
   `ARK_CODING_PLAN_API_KEY` env 或 auth.json，不硬编码）。⚠ 需覆盖全部 pi-ai dist 副本
   （全局 npm CLI、pi-web/node_modules、payload 的 node_modules 与 `.next/node_modules/
   @earendil-works/pi-ai-<hash>/`）；pi-web 同仓库内 node_modules 与 .next 副本是硬链接
   （同 inode，改一处同步）。⚠ pi/pi-ai 升级会重置 dist → 升级后重跑该脚本（幂等）。
9. **客户端退出即杀服务树**：lib.rs 把自身进程挂入 kill-on-close 的 Job Object，
   pi-web/romctl serve 随退出整树终止；NSIS 钩子（installer-hooks.nsh）PREINSTALL 再兜底
   清理残留 node 与旧版 `_root_` 错误布局——否则残留进程锁 payload 文件，升级安装报
   "Error opening file for writing"（2026-09-10 教训）。

## 测试基线

- `gbajs2/test/`：扩展注册（18 工具）、工具执行、serve 端点
- `pi-web/test/`：工作台六面板浏览器冒烟、集成
- 客户端：装机后三端 200（pi-web :30141 / romctl :8645 / 工作台前端）+ agent 实战
  （rom_load → rom_run → rom_screenshot 不产生 gba/ 自愈拷贝）
