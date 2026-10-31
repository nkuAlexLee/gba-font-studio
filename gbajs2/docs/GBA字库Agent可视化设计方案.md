# GBA 字库处理与翻译 Agent 可视化设计方案

> 目标：基于 pi（agent harness）+ pi-web（Web UI）构建一个**专职 GBA 字库处理与文本翻译的领域 Agent**，
> 并把 **破解/翻译全过程 + AI 的每一步操作** 可视化出来。
> 现有资产：pi（SDK/扩展）、pi-web（会话 UI）、romctl.js（无头调试 + serve）、
> skills `gba-font-crack` / `gba-text-translate`。

---

## 一、现状盘点：三个资产各自提供什么

### 1. pi（`D:\vibecoding\gba-font-studio\pi`）
| 能力 | 对本项目的价值 |
|---|---|
| SDK `createAgentSession()`（packages/coding-agent/docs/sdk.md） | 可以编程方式内嵌 agent，自定义 tools/system prompt/资源加载 |
| 扩展机制 `pi.registerTool()` | 把 romctl / skill 脚本包装成**结构化域工具**，LLM 调用即产生可视化事件 |
| `ctx.ui.setWidget()` / `setStatus()` | 实时状态（当前阶段、帧数、进度）推到 UI widget 区 |
| `pi.appendEntry(customType, data)` | 把领域事件（阶段切换、截图、hook 命中）**持久化进 session JSONL** → 可回放 |
| 工具结果支持 image content | `rom_screenshot` 直接把模拟器画面嵌进聊天流 |
| `pi --mode rpc`（JSONL over stdin/stdout） | 若不想用 SDK 内嵌，可作为子进程被任意前端驱动 |

### 2. pi-web（`D:\vibecoding\gba-font-studio\pi-web`，Next.js）
| 能力 | 对本项目的价值 |
|---|---|
| 直接读 pi 的 session 文件 + 实时事件流（`lib/agent-event-stream.ts`、`hooks/useAgentSession.ts`） | 聊天流、工具调用渲染**零开发**复用 |
| `ExtensionWidgets.tsx` / `ExtensionStatusBar.tsx` | 扩展的 widget 自动出现在 Web UI —— 域状态可视化的最低成本通道 |
| 工具结果图片渲染（`lib/tool-result-images.ts`） | 截图/字模图直接展示 |
| FileViewer / Git diff / 终端面板 | ROM、码表、补丁脚本的文件级检查 |
| subagent 支持（`lib/subagent-*.ts`） | 后续"翻译子代理 / 校验子代理"多智能体分工 |

### 3. 域资产（gbajs2 仓库）
- `romctl.js`：无头调试引擎，`serve` 模式已有 HTTP API（截图、memread、run/key、hook 事件落盘 tmp/）。
- 两个 skill：字体破解全流程 + 文本汉化流水线（含 export/translate/insert/validate 等十余个脚本）。
- `memview.html`：浏览器端内存/画面监视（serve 同源托管）。

**结论：Agent 能力不需要从零造 —— pi 管 agent、skill 管流程知识、romctl 管模拟器；缺的只有两块：① 域工具结构化封装（扩展），② 领域可视化面板（pi-web 定制）。**

---

## 二、总体架构

```
┌─────────────────────────── 浏览器（GBA Font Studio）───────────────────────────┐
│  聊天流(复用pi-web)   模拟器画面   流水线看板   码表/字库浏览器   翻译审校表      │
│         ▲                  ▲            ▲            ▲               ▲         │
│         │ session事件      │ REST/SSE   │ JSON       │ 静态文件+API   │ API     │
└─────────┼──────────────────┼────────────┼────────────┼───────────────┼─────────┘
          │                  │            │            │               │
┌─────────┴──────────┐  ┌────┴────────────┴────────────┴───────────────┴───────┐
│ pi-web server      │  │ romctl serve (:8645)                                 │
│ (fork → studio)    │  │  实时模拟器状态：帧、截图PNG、memread、hook事件SSE       │
│ 会话管理/事件转发/   │  └────────▲─────────────────────────────────────────────┘
│ 新增域面板API       │           │ CLI 子进程（serve 独占写者，CLI 只读降级）
└─────────▲──────────┘           │
          │ SDK / 子进程          │
┌─────────┴─────────────────────────────────────────────────────────────────────┐
│ pi agent（领域 Agent）                                                          │
│  ├─ AGENTS.md（领域系统提示：路线、术语、安全边界）                                │
│  ├─ skills: gba-font-crack + gba-text-translate（流程知识，自动加载）             │
│  ├─ 扩展 gba-fontpatch（自研，核心新增物）                                        │
│  │    ├─ rom_* 工具 → 包装 romctl.js                                            │
│  │    ├─ font_* / text_* 工具 → 包装 skill scripts                              │
│  │    ├─ pipeline_* 工具 → 读写 work/pipeline.json                              │
│  │    ├─ ctx.ui.setWidget → 实时阶段/进度                                       │
│  │    └─ pi.appendEntry("gba.event") → 阶段事件持久化（回放用）                   │
│  └─ bash（兜底自由操作）                                                         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**两条事件通道，职责分明：**
1. **持久通道（session 内）**：工具调用/结果、`appendEntry` 自定义事件 → 存进 session JSONL，pi-web 天然渲染，事后可回放"AI 干了什么"。
2. **实时通道（运行时）**：浏览器**直连 romctl serve**（SSE/轮询），画面、hook 命中、内存 diff 低延迟刷新，不占 session 体积。

Agent 与 romctl serve 的关系：serve 是**独占写者**（已有单写者锁）。Agent 通过工具启动/保活 serve，自己用 CLI 只读降级或直接打 serve 的 HTTP；浏览器只读。

---

## 三、Agent 设计

### 3.1 身份与配置

项目根（建议新建 `pi-gba-fontpatch/` 或复用 gbajs2 仓库根）放置：

```
AGENTS.md                  # 全局（已有）
agent/
  AGENTS.md                # 领域 agent 提示：角色、流程决策树、术语、禁止事项
  settings.json            # 默认模型（GLM-5.3-Flash via OpenCode）、thinking 级别
extensions/
  gba-fontpatch.ts         # 核心扩展（见 3.2）
.pi/skills/…               # 两个现有 skill 原样保留
work/                      # 运行产物：pipeline.json、截图、导出文本、批处理
```

领域提示要点（写进 agent/AGENTS.md）：
- 角色定位：GBA 改版 ROM 中文字库工程师，两个 skill 是唯一权威流程；
- 基座判定先行（双字节/ESC/槽位 → 能力上限不同）；
- 每个里程碑必须产出证据（截图/探针输出）并调 `pipeline_stage` 记录；
- 安全边界：不写 baserom、写操作前必须 validate、回填前必须有备份。

### 3.2 核心扩展 `gba-fontpatch.ts`（工具清单）

把"agent 用 bash 拼 CLI 命令"升级为"agent 调结构化工具"，输出 JSON + 图片，天然可渲染：

```ts
// 伪代码骨架（参照 packages/coding-agent/examples/extensions/tools.ts）
pi.registerTool({
  name: "rom_screenshot",
  label: "模拟器截图",
  description: "对当前模拟器状态截图并返回图片（PNG）。可先跑 N 帧。",
  parameters: Type.Object({
    frames: Type.Optional(Type.Number({ description: "截图前先运行的帧数" })),
    key: Type.Optional(Type.String({ description: "截图前按住的按键，如 START" })),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    const png = await romctl.screenshot(params);          // 调 serve HTTP 或 CLI
    await pi.appendEntry("gba.event", { kind: "screenshot", frames: params.frames });
    return {
      content: [
        { type: "text", text: `截图完成（第 ${meta.frames} 帧）` },
        { type: "image", data: pngBase64, mimeType: "image/png" },  // pi-web 直接渲染
      ],
      details: { frames: meta.frames },
    };
  },
});
```

工具分四组（全部是对现有脚本的封装，不写新逆向逻辑）：

| 组 | 工具 | 封装来源 | 输出亮点 |
|---|---|---|---|
| 模拟器 | `rom_load` `rom_run` `rom_key` `rom_screenshot` `rom_memread` `rom_memwrite` `rom_disasm` `rom_snap` `rom_diff` | romctl.js CLI/serve | diff 结果结构化列出变化地址；截图带图 |
| 字库 | `font_probe_base`（基座判定）`font_hook`（挂渲染 hook）`font_glyph_render`（渲染指定码字模为图）`charmap_query` `font_stats` | skill gba-font-crack 流程 + scripts | 字模以图片返回 → AI 自己"看"字，人也能看 |
| 文本 | `strings_export` `strings_plan`（字节预算/repoint 计算）`strings_translate_batch`（onUpdate 流式进度）`strings_insert` `strings_validate` | skill gba-text-translate scripts | 批处理进度经 tool_execution_update 实时上屏 |
| 流程 | `pipeline_stage`（阶段切换+证据）`pipeline_status` `pipeline_report` | 新增，只读写 work/pipeline.json | 驱动可视化看板 |

`strings_translate_batch` 用 `onUpdate` 回调发 `tool_execution_update`：`{done, total, current, cost}` → pi-web 聊天流里能看到翻译进度条。

### 3.3 多智能体（二期可选）

用 pi 的 subagent 机制（本 session 已内置 pi-subagents）：
- **主管**（领域 agent）：规划、调用 pipeline 工具、汇报道度；
- **翻译子代理**：纯翻译，按批 structured output；
- **校验子代理**：禁则排版检查、控制码完整性、乱码检测。
pi-web 已有 subagent 运行时渲染，子代理活动天然可见。

---

## 四、可视化设计（五个面板）

### P0 聊天流（复用，零开发）
工具调用卡片、截图/字模图片、翻译进度、widget 状态条——pi-web 全部现成。这是"AI 操作可视化"的主体。

### P1 模拟器画面面板
- 浏览器直连 `romctl serve`：轮询截图端点（~2fps 足够）或嵌 memview iframe（serve 已同源托管）。
- Agent 每次 `rom_screenshot` / `rom_key` 调用后，面板同步跳到最新帧（通过 `gba.event` 或 session 事件触发）。
- 附带操作条：暂停/单帧/按键注入（**只读默认，写操作需人工开关**），让人能"接管"验证 AI 的结论。

### P2 流水线看板（核心新增）
阶段定义为静态配置 + `pipeline.json` 运行态：

```json
{
  "rom": "testfiles/xxx.gba",
  "base": "dualbyte-esc",
  "stages": [
    { "id": "engine",   "name": "定位渲染引擎", "status": "done",
      "evidence": ["disasm 0x08006876", "probe-dualbyte OK"], "session": "entryId..." },
    { "id": "font",     "name": "字库整库插入",  "status": "running", "progress": 0.6 },
    { "id": "charmap",  "name": "码表构建" },
    { "id": "export",   "name": "文本导出" },
    { "id": "translate","name": "翻译",   "progress": 0.0, "batches": [12, 30] },
    { "id": "layout",   "name": "排版与校验" },
    { "id": "insert",   "name": "回填 ROM" },
    { "id": "verify",   "name": "截图验证" }
  ]
}
```

- 每个阶段节点显示：状态、进度、证据链接（截图缩略图、diff 数字）。
- **关键联动**：`pipeline_stage` 工具记录的 session entryId 使看板节点可点击 → 滚动到聊天流中对应位置，即"这个阶段 AI 到底做了什么"逐条可查。这是"过程可视化"的骨干。
- 阶段事件同时 `appendEntry` 持久化，换会话/重启后看板可完整重建。

### P3 码表/字库浏览器
- 左：wholewords.txt 表格（码 ↔ 字 ↔ 来源/缺字标记），支持搜索过滤；
- 右：点击某码 → Canvas 渲染 16×16 字模（复用 skill 的 1bpp/2bpp 解码逻辑，编译为浏览器可用的 JS 模块），叠加网格与实际像素放大视图；
- 顶部统计：总字数、缺字数、与字库 .bin 槽位占用图（色块矩阵，一眼看出空洞）。

### P4 翻译审校表（human-in-the-loop，汉化质量的闸门）
- 表格：ID | 原文 | 译文 | 字节预算(原/译) | 是否超长 | 控制码校验 | 状态（待审/通过/打回）；
- 超长行标红并显示 repoint 方案（新地址、影响指针数）；
- 批量通过/单行编辑 → `strings_insert` 只导入"已通过"行；
- 数据源即 skill 脚本的 JSON 中间产物，前后端零私有协议。

### P5 文件/反汇编（复用 + 小增强）
- pi-web FileViewer 看 ROM hex、补丁 .asm、导出文本；
- `rom_disasm` 结果在聊天流中已是格式化文本；可选把 `disasm-offline.js` 做成带符号标注的只读页面。

---

## 五、前端落地方案：三种路线对比与选型

| 路线 | 做法 | 工作量 | 优劣 |
|---|---|---|---|
| A. 原版 pi-web + 扩展 | 不 fork，只靠工具图片/`ExtensionWidgets` 文本 widget 展示 | 最小（P0 即所得） | 领域面板缺失，widget 只能文本 |
| **B. fork pi-web → GBA Font Studio（推荐）** | fork 仓库，新增 `components/domain/*` 五个面板，复用其 session 事件层 | 中（面板均为纯展示组件，数据源独立） | 一次到位；上游迭代快需定期 rebase → **把改动收敛在新增目录 + 少量挂载点** |
| C. 自建前端 + pi SDK | `createAgentSession` 起 Node 服务，自写全部 UI | 最大 | 重复造 session/事件/文件轮子，不建议 |

**选 B，但按 A→B 渐进**：Phase 1 先不 fork（拿到 80% 的"AI 操作可视化"），Phase 3 再 fork 加看板。

fork 时遵守的纪律（降低维护成本）：
1. 新增面板全部放 `components/domain/`、API 放 `app/api/domain/*`，**不改既有组件行为**；
2. 挂载点只允许在 `AppShell.tsx` 增加一个 Tab（"GBA 工作台"）；
3. 域状态不进 pi-web 的 store，各面板自持（romctl SSE / pipeline.json 轮询）；
4. 上游升级 = rebase + 回归五个面板。

---

## 六、romctl serve 增强（唯一动到的既有域代码）

1. `/api/events`（SSE）：推 hook 命中、内存 diff、帧计数——memview 已轮询的接口升级为推送；
2. `/api/screenshot.png?frames=N&key=X`：直接返回 PNG（现 bmp 可加编码或前端转码）；
3. 状态摘要 `/api/status`：rom 名、帧数、hook 列表、serve 锁信息；
4. 保持现有单写者锁语义：agent 工具检测到 serve 在跑时走 HTTP，否则 spawn serve 子进程。

这些改动小且向后兼容（新增端点），romctl CLI 用法不变。

---

## 七、实施计划

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **P1 Agent 打包** | `extensions/gba-fontpatch.ts`（rom_* + pipeline_* 先行）、agent/AGENTS.md、work/ 目录约定 | 用原版 pi-web 跑通"加载 ROM→截图→定位引擎→记录阶段"全流程 | 1–2 天 |
| **P2 实时画面** | romctl serve SSE/截图端点；memview 或简易画面页 | 浏览器实时看画面 + agent 操作同步 | 2–3 天 |
| **P3 领域面板** | fork pi-web；流水线看板 + 码表/字库浏览器 | 阶段点击回溯聊天流、字模可视化 | 3–5 天 |
| **P4 审校闭环** | 翻译审校表 + 通过后 insert + 截图验证面板；translate 工具进度流 | 人在环完成一批真实文本汉化 | 3–5 天 |
| **P5 多智能体与回放** | 翻译/校验子代理分工；会话回放视图、导出 HTML 报告 | 全流程演示报告 | 2–3 天 |

验收基准（用现有 case）：对 Quetzal（双字节基座）和 EliteRedux（ESC 基座）各走完一遍"字库→翻译→回填→截图验证"，全程在 Studio 内完成且看板可完整回放。

---

## 八、风险与决策点

| 风险 | 对策 |
|---|---|
| pi-web 上游迭代快（0.85.x），fork 漂移 | 改动收敛在新增目录（第五节纪律）；域面板不碰内部 store |
| romctl serve 与 CLI 写者冲突 | 沿用现有锁；扩展工具统一封装"serve 优先、CLI 降级" |
| 截图/字模图片撑大 session 文件 | 图片走 tool result（pi 已支持，有上限控制）；高频帧数据只走实时通道不落 session |
| 翻译 token 成本 | 子代理批处理 + glossary（skill 已有 build-glossary）；审校表支持人工改后跳过重翻 |
| Windows 环境（node-pty、路径） | pi-web 已在 Windows 跑通；域面板只用 HTTP/文件 API，无 pty 依赖 |
| 模型能力：Flash 级模型做逆向判断不稳 | 逆向决策阶段（engine/font）允许切强模型（pi 会话内随时换模型）；翻译阶段用 Flash 控成本 |

---

## 九、与本项目现有约定的衔接

- 仓库定位 `pi-gba-fontpatch` 不变：扩展与面板属于"工具链"的一部分，SKILL.md 仍是流程权威，扩展只是把 skill 配方工具化（在扩展工具的 description 里直接引用 SKILL.md 章节号，避免两处漂移）；
- `romctl.js` 的"每条命令一次性进程 + JSON 状态"与 serve"内存最新"双模式保留，扩展封装后 agent 感知不到差异；
- 截图像素校验（NEW GAME 校验等 skill 既有配方）作为 `verify` 阶段的标准证据格式：截图 + 差异像素数，进看板与报告。

---

## 十、实施落地状态（as-built，2026-09-08）

设计方案已全部实施并通过四层测试。以下为实际落地形态与设计的差异说明。

### 已交付

| 阶段 | 交付物 | 状态 |
|------|--------|------|
| P1 Agent 打包 | `.pi/extensions/gba-fontpatch.ts`（18 个结构化工具：rom_*×11、pipeline_*×3、font_*×2、text_*×2）+ AGENTS.md 领域守则 + `work/pipeline.json` seed/schema | ✅ |
| P2 实时通道 | romctl serve 原有 WebSocket 推帧/音频之上：新增 `/shot.png`（无依赖 PNG 编码）、WS hook 事件 2s 推送、`/pipeline` `/work` `/workfile` `/tmpfile` `/sessions` `/pisession` `/review`(GET/POST) `/insert` | ✅ |
| P3 领域面板 | `studio/`（index.html + style.css + app.js）+ 共享解码器 `js/glyph-format.js`：模拟器画面 / 流水线看板（阶段点击→回放联动）/ 会话回放（AI 操作逐条可查）/ 码表字模（点阵+游戏网格+槽位占用图）/ 翻译审校 | ✅ |
| P4 审校闭环 | 审校表人工"通过"→ POST /review 回写 CSV → `/insert` 或扩展 `text_insert` 调 insert-strings.js 回填；validate 门禁 | ✅ |
| P5 报告/回放 | 会话回放面板（300+ 会话、逐条时间线、过滤）+ 看板"⬇ 导出 HTML 报告" + 扩展 `pipeline_report`（Markdown） | ✅ |

### 与设计文档的偏差（及理由）

1. **可视化层未 fork pi-web，改为 serve 同源托管的独立工作台**。理由：romctl serve 已自带手写 WebSocket 实时通道（设计时未知），同源托管零依赖、可在无 Node 22+/Next 构建链的环境直接跑；且 pi-web 的既有能力（聊天流、文件查看）与本工作台通过**同一数据源**（session JSONL、pipeline.json、tmp 截图）互通，人可以同时开 pi-web 与 Studio。原 fork 纪律（改动收敛、面板不碰内部 store）在独立页面形态下天然满足。
2. **SSE `/api/events` 未单独实现**：WebSocket 已覆盖实时推送（帧/音频/hook 事件），避免双通道冗余。
3. **多智能体分工**（P5）复用环境中已装的 pi-subagents 扩展（翻译/校验子代理），未在本仓库新增编排代码；`pipeline_report` 与 Studio 报告导出承担汇总职责。

### 测试证据（全部通过）

```bash
node test/extension-test.mjs       # pi SDK 加载扩展：18 工具注册、无加载错误
node test/tool-exec-test.mjs       # 工具级 execute：pipeline 落盘/读回/报告、码表逐字查码、
                                   # 字模 PNG 签名、无 serve 降级、text_validate 真跑
node test/studio-test.mjs          # serve 集成：/load /run /shot.png(PNG/IHDR/IDAT 校验)、
                                   # /pipeline /tmpfile /sessions /pisession、/review 读写回环、
                                   # 路径穿越拒绝、/workfile
node test/studio-browser-test.mjs  # playwright chromium：五面板真实渲染
                                   # （画面非全黑、8 阶段卡、507 会话回放、字模墨迹、34681 审校行、零 JS 错误）
```

界面截图：`docs/studio-画面面板.png`、`docs/studio-流水线面板.png`、`docs/studio-码表面板.png`、`docs/studio-审校面板.png`。

### 使用方式

```bash
node romctl.js serve                                # :8645（锁 + 心跳，单写者）
# 浏览器: http://127.0.0.1:8645/studio/index.html
# pi agent 在本仓库打开即自动加载扩展（项目需受信任）；
# 流程: agent 调 rom_*/font_*/text_* 工具干活，pipeline_stage 记录里程碑，
#       人在 Studio 看画面/看板/回放，翻译在审校面板人工把关后回填。
```

### 补充交付：嵌入 pi-web（2026-09-08 第二期）

按用户要求以 pi-web 为蓝本做了直接集成：pi-web fork（`../pi-web/`）新增
`components/StudioPanel.tsx` 并挂入 `AppShell.tsx` 右侧面板体系（"GBA 工作台" 伪
tab + 侧边栏 GBA 按钮）。同屏效果：左侧 agent 聊天/会话，右侧游戏画面/流水线/
审校（iframe 内嵌 serve 同源托管的 Studio，serve 状态轮询显示于面板头）。
已用 playwright 实测（`docs/piweb-集成截图.png`），TypeScript `tsc --noEmit` 零错误。
运行（单命令，romctl serve 已合入 pi-web 启动钩子 instrumentation.ts，随服务自动
拉起/回收，已在运行则不重复启动）：pi-web 目录 `npx next dev -p 30141`，
浏览器 http://127.0.0.1:30141 点侧边栏「GBA」。

### 补充交付 2：主题对齐 + 工作台加载 ROM + agent ROM 身份感知（2026-09-08）

- **样式对齐**：studio/style.css 全部改用 pi-web 同名 CSS 变量（--bg/--bg-panel/--border/--text/--accent 等），
  StudioPanel 在 iframe 加载与主题切换时把宿主计算样式 postMessage 注入（`gba-theme`）→
  亮/暗主题自动跟随；独立打开时保持暗色默认。
- **工作台加载 ROM**：serve 新增 `/browse`（盘符/目录/ROM 浏览），Studio 顶栏与面板头均有
  「📂 打开 ROM」对话框（面板头经 postMessage `gba-open-rom` 触发 iframe 内弹窗），
  选定 .gba → /load 加载并刷新状态。
- **agent ROM 身份感知**：`rom_status` 输出结构化摘要（当前 ROM 路径/帧数/hook/serve 端口），
  自动检测与 pipeline.json 记录 ROM 的不一致并提示，附后续工具建议（截图/hook 预设/快照等），
  agent 调一次即知道"现在是什么 ROM、下一步怎么调"。
- 验证：`test/piweb-integration-test.mjs` 端到端（单命令启动→面板→主题一致→对话框逐级导航→实际加载 ROM→状态行更新）全 PASS。

### 补充交付 3：整体迁移至 pi-web（自包含，不再跨仓库共享文件）（2026-09-08）

应用户要求，全部成果迁入 pi-web 仓库，消除跨目录文件共用：

- **`pi-web/gba/`**（~200MB 自包含运行时）：romctl.js + js/ 模拟器核心 + resources/BIOS +
  memview + assets/（码表/字库/charmap）+ scripts/（翻译流水线脚本）+ translation-er/
  （project.json 路径已重写）+ roms/（pker 测试卡、红龙字库版；其余 ROM 由工作台
  「📂 打开 ROM」对话框任意路径加载）+ work/（流水线产物）。
- **`pi-web/public/gba-studio/`**：工作台前端由 pi-web 同源托管（不再由 serve 托管 iframe 页），
  通过 `?api=http://127.0.0.1:8645` 指向数据后端（serve 端全量 CORS）；证据链接/WS/静态资产
  全部参数化。
- **`pi-web/.pi/extensions/gba-fontpatch.ts`**：路径指向 gba/ 子目录；**`pi-web/.pi/skills/`**：
  两个 skill 副本（顶部附 pi-web 路径注记）。
- **去重**：pi-web 面板头只保留连接管理（● 已连接 :8645 / 端口 / 重连），ROM 状态、「📂 打开 ROM」、
  memview/work 链接唯一存在于工作台顶栏；romctl 托管拉起时 `ROMCTL_NO_OPEN=1` 不弹 memview。
- **画面居中**：`.screen-wrap` 改纵排 + 居中（画布居中在上、控制区在下），测试断言
  `align-items: center` PASS。
- gbajs2 仓库保留为历史工作区（自己的扩展/技能/测试仍可用，但工作台已迁走；
  `AGENTS.md` 已注明）。测试归属：pi-web/test/{gba-workbench-test, piweb-integration-test}.mjs；
  gbajs2/test/{extension-test, tool-exec-test, studio-test}.mjs 继续覆盖本仓库遗留栈。

### 补充交付 4：Tauri 桌面客户端（供新用户分发）（2026-09-08）

按 `tauri-dev`（Tauri 框架源码参照）产出桌面客户端，工程位于 `../app/`：

- **打包形态**：NSIS 安装包（currentUser，免管理员）≈180MB，内含 payload（~894MB 展开）：
  pi-web 生产构建（next start + 精简 node_modules + public）、gba/ 自包含引擎、
  workspace-template（**AGENTS.md + .pi/skills(gba-font-crack/gba-text-translate) + .pi/extensions(gba-fontpatch)** + roms/pker）。
- **首启行为**（Rust bootstrap）：安装路径下创建 `data/workspace`（工作区）与 `data/agent`
  （PI_CODING_AGENT_DIR），**写入初始欢迎会话**（pi session v3 JSONL，绑定工作区 cwd）；
  拉起 pi-web(:30141) 与 romctl serve(:8645，ROMCTL_NO_OPEN=1)；webview 就绪后导航显示。
- **运行时数据与引擎分离**：翻译工程（projects/，与 ROM 绑定、动态创建）与流水线产物（work/）
  属工作区用户数据，不进 payload；romctl serve 经 `GBA_WORKSPACE_DIR` 解析，
  扩展工具经 agent `ctx.cwd`（= workspace）解析。
- **AV 自愈**：腾讯电脑管家等会拦截新复制 exe 的回环连接（LISTEN 但 accept 被滤）——
  bootstrap 探测 25s 无响应即杀进程树回退系统 node（PATH）；二者皆败弹指引窗口。
- **构建陷阱备忘**：next build 用 Turbopack（webpack 模式 OOM）；payload 落短路径 D:\gbfp
  （junction 挂回，NSIS 源路径 >260 会失败）；`.next/dev`、`dist-types/*.d.ts/*.map` 必须剔除
  （但 `.next/node_modules` 整删会丢 Turbopack 外部模块 shim，只能瘦身）；NSIS 静默安装在本机被
  AV 卡死（环境限制），GUI 安装与等价布局直跑均已验证。
- 验证：`data/workspace`（skills/extensions/roms/projects/work）+ 初始会话 + 双服务 200 +
  pi-web 会话 API 恰好列出欢迎会话，全部在"安装后布局"（D:\tmp-install-test\gba-studio）实测通过。

### 补充交付 5：客户端 agent 实战验证 + 引擎路径回退链（2026-09-08）

- 客户端扩展增加**引擎目录回退链**：工作区 gba/ 副本 → 遗留仓库根 →
  `%PI_CODING_AGENT_DIR%/../../payload/gba`（客户端安装布局）→ 开发兄弟目录；
  码表/字库/脚本路径 `firstExisting` 双布局回退。修复了首启时引擎路径解析失败
  导致 agent 自愈拷贝 200MB 引擎到工作区的问题。
- **安装后 agent 实战验证**（注入真实凭证后 headless 驱动）：rom_load → rom_run 200 帧
  （603→803）→ rom_screenshot（模型准确描述画面）→ 无自愈拷贝，回退链直命中 payload/gba。
- 安装包已含修复版扩展重新打包。
