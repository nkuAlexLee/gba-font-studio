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

# 纯净 Pi Web 桌面端（无 GBA 引擎；app-pure/ 独立 Tauri 应用，payload→D:\gbfp-pure）
node scripts/build-desktop.mjs --pure        # 产物 app-pure/src-tauri/target/release/bundle/nsis/Pi Web_*-setup.exe

# 客户端安装包一键构建（= 下面三步；失败即停不吞错；--with-test 先跑测试基线）
npm run build:desktop                        # 仓库根执行；可选 --skip-next/--skip-payload/--skip-tauri

# 客户端图标重生成（圆角矩形红白球；写 app/src-tauri/icons/icon.ico + pi-web/public/icons/gba/*，--preview 只出预览）
node scripts/make-gba-icons.mjs

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
   日志统一 `data/logs/`（bootstrap 诊断落 `data/logs/bootstrap.log` —— GUI 子系统无 stderr，
   `eprintln` 不可见；错误窗文案与加载页提示均指向该目录）。
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
   ⚠ 另一条独立硬限是**字节**而非张数：上游网关对单请求体 ~64 MiB 直接
   `413 {"code":"EntryTooBig"}`（实测 65.7MiB 必败、≤63.3MiB 全过），张数防护挡不住
   几张 4K 原图。通用守门扩展 `image-budget.ts`（三处同源：`pi-web/.pi/extensions/`、
   `gbajs2/.pi/extensions/`、全局 `data/agent/extensions/`，后者面向不在仓库里的工作区
   会话）在 context 事件里按字节预算压缩/省略旧图；pi 自身只在
   `dist/utils/image-resize-core.js` 限单张（2000px / 4.5MB base64），不限总量。
   ⚠ 全局扩展的配置已从 env 迁到 **pi 的 settings.json**（`extensionSettings.<扩展名>` 段，
   即 `data/agent/settings.json` 或工作区 `<cwd>/.pi/settings.json`；项目级字段级覆盖全局）：
   `image-budget`（预算 48MiB、保留最新 6 张、张数上限 30、sharp 压缩 1280px/256KB）、
   `game-clip`、`auto-compact`（使用率达 `percent`（默认 15%）自动 compact，越过硬顶
   `hardPercent`（默认 25）则在轮内立即压；硬顶压缩会 abort 当前 run，
   压缩完成后扩展自动 `pi.sendUserMessage()` 补一条续跑消息（`resume` 默认 true，
   `resumePrompt` 空=内置文案）；`turn_end` 时若助手消息已无工具调用（本轮即将自然结束）
   则不做硬顶、留给 `agent_settled` 的温和线。取值优先级 **env（显式设置时覆盖）> JSON > 内置默认**；
   三个扩展各自 `import` 同一套 `jsonSettings()/nOf/bOf/tOf/sOf/pathOf` helper
   （不外置共享模块——`extensions/*.ts` 会被自动发现当扩展加载）。这些键名不在 pi 的
   settings schema 里，但 `SettingsManager.persistScopedSettings()` 写盘时会重读当前文件、
   只覆盖本次 modifiedFields → 自定义键不会被 pi 自己的写入抹掉（`migrateSettings()` 亦原样穿过）。
   ⚠ 勿用顶层 `extensions` / `packages` / `skills` 键（已被 pi 占用）。
   ⚠ **`compaction.reserveTokens` 同时是「摘要输出预算」的来源**（pi 自身配置，不属于扩展）：
   `maxTokens = min(0.8 × reserveTokens, model.maxTokens)`（`xp3/dist/core/compaction/compaction.js:489`；
   turn-prefix 摘要用 0.5×，`:651`）。默认 16384 → 摘要只能写约 13107 tokens，长会话/大窗口下
   pi 会直接报 `Summarization failed: generation hit the token cap and the summary is incomplete`
   （`getSummarizationFailure`，`compaction.js:429-437`：`stopReason === "length"` 时**部分摘要一律不落盘**，
   不是重试能解决的）。本机已在 `data/agent/settings.json` 设 `compaction.reserveTokens=131072`
   （预算 ≈104857 tokens，即 `DeepSeek-V4.1-Flash` 的 maxTokens 上限）。副作用是 pi 自身的触发线
   `contextTokens > contextWindow - reserveTokens` 同步提前（1M 窗口→87.5%，262144 窗口→50%），
   对本扩展无害（15% 线永远更早）。⚠ 该值是绝对值：必须明显小于所用模型的最小 contextWindow
   （本机最小 262144 → 131072 安全）；若以后引入 32K/128K 窗口模型，会出现「触发线为负/过低 → 每轮都压缩」，
   必须同步调小。`auto-compact.ts` 的 `piCompactionSettings()` 会读回该值，并在压缩失败命中该文案时
   给出可操作提示（`summarizationCapHint()`）。⚠ 姊妹坑见第 12 条。
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
10. **纯净 Pi Web 变体（app-pure/，--pure）**：与 GBA 产品完全分离，可并行共存。pi-web 构建
   带 `NEXT_PUBLIC_GBA_STUDIO=0`（UI 剔除 GBA 入口）+ `NEXT_DIST_DIR=.next-pure`（不覆盖
   产品 `.next`）；运行时 lib.rs 置 `GBA_STUDIO=0` 让 instrumentation 跳过 romctl；payload 无
   gba/、.pi/、roms/、gba-studio，workspace-template 为通用 AGENTS.md。⚠ payload 组装会把
   `.next/node_modules/<pkg>-<16hash>` shim 改名为 xp1…xp7 并全局改写引用（NSIS MAX_PATH：
   深层文件经 junction 读到 261 字符，makensis 不支持长路径；改动前先读 2c 步骤注释）。
   ⚠ 不要改回 resources map 形式——tauri 会把文件压平到 target/<basename> 互相覆盖（已踩坑）。
   ⚠ Noto Sans Mono 已自托管（public/fonts/ + globals.css @font-face），构建不再联 Google Fonts。
   启动性能：就绪探测用**分类判定**——连接被拒（还没监听）只是冷启动慢继续等满窗口
   （20s，覆盖实测 ~10s 冷启动），连得上但 HTTP 无响应才是杀软拦回环特征（连续 3 次
   ~6s 提前判定），拦截/超时才回退系统 node 并落盘 data/node-fallback.json（7 天内
   免惩罚直启；AV 放行后自动清标）；⚠ 勿改回固定短窗一票否决（8s 窗曾把 Ready in
   9.6s 的正常冷启动误杀成 loopback-blocked）。主窗口初始页为捆绑加载页（tauri.conf
   url=index.html），启动即 show + 页面内 no-cors 轮询 30141 自愈跳转 —— 严禁改回
   “等就绪才 show 窗口”（感知启动慢的主因）。⚠ Rust 侧探测失败**不杀服务、不弹错误窗**
   （2026-10-01 实机：杀软拦新装主程序自身的回环连接，而 msedgewebview2 不受拦 → 加载页
   能通；旧逻辑把好端端的服务杀掉还弹错）：捆绑 node 分支才杀树+落标，系统 node 分支只记
   bootstrap.log 交由加载页自愈。
   图标：installer-hooks.nsh POSTINSTALL 用 ie4uinit/SHChangeNotify 刷图标缓存；
   icon.ico 必须是 DIB 条目且目录项连续（RC.EXE 不吃 PNG 条目；生成器 scripts/make-pi-icons.mjs）。
11. **HTML 文件预览靠服务端内联，不是 `<base>` + 原始资源接口**：FileViewer 的预览 iframe 是
   沙箱 srcdoc（无 `allow-same-origin`）→ 文档是不透明源，页面自己发起的相对 css/js/img 请求
   属跨源 no-cors，被 Chromium ORB 拦掉（`net::ERR_BLOCKED_BY_ORB`：样式表下载了却不生效）。
   正确做法：`/api/files-html-preview` 服务端把本地 css/js 内联、图片字体转 `data:` URI
   （`lib/html-preview.ts`）。⚠ 不要把文件 API 加上 CORS 头来“修”这个（含 `null` —— 沙箱页
   就发 `null`，等于任意网页可读本地文件），也不要给 iframe 加 `allow-same-origin`。
12. **压缩请求自身超窗 → `side_request_payload_too_large` 413 死循环**（billion-context 0.1.179，
   2026-10-04 实机）：pi 的压缩（summarization）请求把**整段历史**序列化成 `2 msgs` 纯文本，代理
   `isSideRequest()`（无 tools + `max_tokens ≤ 200`，或 `x-bili-plugin-agent: title`）把它判成
   **侧请求**，而侧请求按 #388 设计**绕过压缩** → `sideRequestGuard` 见 `estimate ≥ window × 1.15`
   即 `writeHead(413)` 不转发 → pi 重试 4 次全灭、auto-compact 退避 5 分钟后重来，历史继续变大，
   **死循环**（每轮还白跑 30–38s preflight；现场 estimate 1,849,705 → 2,185,901 tokens）。
   复发处置：先把成果落盘后**新开会话**承接，必要时 `extensionSettings.auto-compact.off=true` 止血；
   ⚠ 调小 `compaction.reserveTokens` 无用（摘要预算与输入体量无关）。根治点在产品侧（代理放行摘要
   提示的压缩，或让压缩请求不落在「无 tools + 小预算」象限）。完整证据/行号/取证命令见
   `docs/案例-压缩请求超窗-413死循环.md`。

## 测试基线

- `gbajs2/test/`：扩展注册（18 工具）、工具执行、serve 端点
- `pi-web/test/`：工作台六面板浏览器冒烟、集成、HTML 预览内联（`html-preview-test.mjs`，
  自带隔离 distDir/端口，可与开发态 dev server 并存）
- `pi-web` 单测：`npm test`（= `node --experimental-strip-types --test app|components|hooks|lib|public/**/*.test.mjs`，
  含 HTML 预览内联逻辑与安全边界 `lib/html-preview.test.mjs`）。
  ⚠ 已知历史失败（与本仓库业务无关，Windows 专属）：`lib/worktree.test.mjs` 在 `TEMP` 含 8.3
  短路径（如 `C:\Users\NKUALE~1\...`）时失败——`git rev-parse --show-toplevel` 返回长路径，
  而 `resolveProject()` 比较的长短形式不一致 → `isTopLevel` 误判 false。
- 客户端：装机后三端 200（pi-web :30141 / romctl :8645 / 工作台前端）+ agent 实战
  （rom_load → rom_run → rom_screenshot 不产生 gba/ 自愈拷贝）
