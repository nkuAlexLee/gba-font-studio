# pi-gba-fontpatch（基于 gbajs2）

## 项目定位

本项目是基于 gbajs2 模拟器构建的 **GBA 宝可梦改版 ROM 中文字库破解与补丁工具集**，仓库名 `pi-gba-fontpatch`：<https://github.com/nkuAlexLee/pi-gba-fontpatch>

## AI Agent 驱动开发

本项目的 ROM 逆向分析与补丁制作主要由 **[pi](https://pi.dev/) 编码智能体** 调用本仓库内置的 skill（`.pi/skills/gba-font-crack/`）自动完成，涵盖定位渲染引擎、控制流分析、探针实证、字模槽位注入、字符串修改与截图像素校验等全流程。

**推荐配置**：

- 套餐：[OpenCode Go 套餐](https://opencode.ai)
- 模型：GLM-5.3-Flash

在 pi agent 中打开本仓库，agent 会自动加载 `gba-font-crack` skill 并按 SKILL.md 中的配方调用 `romctl.js` 等工具完成分析任务。

### 领域工具扩展与可视化（首选工作方式）

本仓库内置 pi 扩展 `.pi/extensions/gba-fontpatch.ts`（项目可信后自动加载），把常用操作包装为结构化工具，**优先用这些工具而不是手拼 bash 命令**：

| 工具组 | 工具 | 用途 |
|--------|------|------|
| 模拟器 | `rom_status` `rom_load` `rom_run` `rom_key` `rom_screenshot` `rom_memread` `rom_memwrite` `rom_disasm` `rom_hookadd` `rom_hookevents` `rom_snap` | 无头调试全流程；截图以图片返回，可直接看画面 |
| 流水线 | `pipeline_stage` `pipeline_status` `pipeline_report` | 记录阶段进度与证据，驱动 Studio 看板 |
| 字库 | `font_charmap_query` `font_glyph_render` | 码表查询；字模渲染为图片（验证字形映射） |
| 翻译 | `text_validate` `text_insert` | 翻译工程校验与回填（底层调 gba-text-translate skill 脚本） |

**流水线纪律**（阶段 id 固定）：`engine`(定位渲染引擎) → `font`(字库整库插入) → `charmap`(码表构建) → `export`(文本导出) → `translate`(翻译) → `layout`(排版与校验) → `insert`(回填 ROM) → `verify`(截图验证)。每进入/完成一个阶段必须调 `pipeline_stage` 带上证据（截图文件、探针输出摘要）；全部完成后调 `pipeline_report` 生成报告。

**人机协同可视化**：运行 `node romctl.js serve` 后打开 `http://127.0.0.1:8645/studio/index.html` —— 五个面板实时呈现：模拟器画面（WebSocket 推帧）、流水线看板、会话回放（AI 每一步操作）、码表/字模浏览器、翻译审校表。工具调用与会话事件会自动出现在回放面板。

**安全边界**：写操作（memwrite/rompatch/insert）前必须先 `rom_snap save`；回填前必须 `text_validate` 通过；不修改 `roms/*backup*` 与 baserom。

## 自研工具链（优先阅读）

- **`romctl.js`** — 无头调试引擎（首选入口）：加载 ROM、跑帧、按键、截图、内存读写/快照对比、反汇编、文本函数 hook；serve 模式兼提供 Studio 数据端点（/pipeline /sessions /review /insert 等）。用法：`node romctl.js` 看帮助，配方见 `.pi/skills/gba-font-crack/SKILL.md`
- **`.pi/extensions/gba-fontpatch.ts`** — 领域工具扩展：rom_*/pipeline_*/font_*/text_* 四组 18 个结构化工具（详见 AGENTS.md「领域工具扩展与可视化」）
- **GBA Font Studio 工作台已迁移至 pi-web**（`../pi-web/public/gba-studio/` + `../pi-web/gba/` 自包含引擎），本仓库不再包含；截图见 `docs/studio-*.png` 与 `docs/piweb-集成截图.png`
- **`js/glyph-format.js`** — 11x11 字模解码单源双端（浏览器 + Node，测试与 Studio 共用）
- **`memview.html`** — 浏览器可视化内存监视页（游戏画面 + 内存变化 + 反汇编）
- **`js/thumb-disassembler.js`** — Thumb/ARM 反汇编器
- **`docs/memview开发经验与调试记录.md`** — 架构决策与踩坑记录（Worker 黑屏、序列化链路断裂、hook 设计等）
- **`../app/`** — Tauri 桌面客户端（详见下方「桌面客户端」章节）
- **`test/`** — 无头测试：`headless-test.js`（模拟器冒烟，需传 ROM 参数）、`extension-test.mjs`（扩展注册）、`tool-exec-test.mjs`（工具执行）、`studio-test.mjs`（serve 端点集成）；工作台 UI 测试已迁 `../pi-web/test/`（gba-workbench-test / piweb-integration-test）

开发注意事项：
1. 新 HTML 页面的脚本引入清单以 `index.html` 为基准，但**不要加载 `js/video/proxy.js`**（Worker 渲染静默黑屏）
2. `gba.freeze()` 序列化链路是坏的（依赖浏览器 Blob），需要状态持久化时参考 `romctl.js` 的 JSON 快照实现
3. hook 点选函数入口（r0-r3 即参数），当前指令地址 = `cpu.step()` 入口处 `gprs[15] - instructionWidth`

## 桌面客户端（Tauri，供新用户分发）

面向新用户的客户端已建成并验证：NSIS 安装包自带 pi-web 工作台、GBA 引擎、
**两个 skill（gba-font-crack / gba-text-translate 的 SKILL.md 全套）与领域扩展（gba-fontpatch）**，
首启自动在安装路径创建工作区与欢迎会话。

### 位置
| 内容 | 路径 |
|---|---|
| 客户端工程（Rust + 打包脚本） | `../app/`（`src-tauri/`、`build-payload.mjs`、`README.md`） |
| payload 实体（须短路径） | `D:\gbfp\payload`（junction：`app/src-tauri/payload` → `D:\gbfp\payload`；NSIS 源路径 >260 字符会失败） |
| 安装包产物 | `app/src-tauri/target/release/bundle/nsis/GBA Font Studio_1.0.0_x64-setup.exe`（~180MB） |
| pi-web 源（前端/服务端） | `../pi-web/`（`public/gba-studio/` 工作台前端、`gba/` 引擎开发源） |

### 构建
```bash
cd ../pi-web && npx next build        # Turbopack（--webpack 会 OOM）
cd ../app && npm install && node build-payload.mjs && npx tauri build --bundles nsis
```
⚠️ `tauri.conf.json` 的 `resources` 必须是**相对路径** `payload/**/*`（经 junction 解析）。
绝对路径（如 `D:/gbfp/**/*`）会被 Tauri 安装成 `<install>/_root_/gbfp/...` 嵌套布局，
bootstrap 探测不到 payload（2026-09-08 实装翻车教训；重打包前先删
`target/release/payload`、`target/release/_root_` 旧 staging，避免脏文件混入）。
增量：`node build-payload.mjs --skip-node-modules [--skip-next-build]`。

### 安装后布局（currentUser，默认 %LOCALAPPDATA%\Programs\GBA Font Studio）
```
<安装目录>/
├─ gba-font-studio.exe
├─ payload/                     引擎与运行时（升级整体替换，勿放个人数据）
│   ├─ pi-web/  gba/  runtime/node.exe
│   └─ workspace-template/  agent-template/
└─ data/                        ★ 首启创建（用户数据，升级不覆盖）
    ├─ workspace/   ← agent 工作区：AGENTS.md、.pi/{skills,extensions}、roms/、
    │                 projects/（翻译工程，与 ROM 绑定、动态创建）、work/（流水线产物）
    ├─ agent/       ← PI_CODING_AGENT_DIR：sessions/（含初始欢迎会话）、凭证/设置
    └─ logs/        pi-web.log、romctl 日志
```

### 关键机制（改客户端前必读）
1. **无黑框启动**：release 主程序 `windows_subsystem="windows"`（debug 保留控制台）；node 子进程
   `CREATE_NO_WINDOW`（Rust）/ `windowsHide: true`（JS 各 spawn 点）；输出走 `data/logs/`。
2. **服务编排**：Rust 只拉起 `next start`；instrumentation（`pi-web/lib/gba-serve.ts`）
   经环境变量自动拉起 romctl serve（`GBA_STUDIO_DIR`→gba 引擎、`GBA_WORKSPACE_DIR`→
   用户工作区、`GBA_SERVE_PORT`）。serve v3 行为：**锁/状态文件固定在 romctl 本体旁
   `tmp/`**（任何 cwd 启动都一致，杜绝"锁文件位置不一致"）；**不自动弹 memview**
   （`ROMCTL_OPEN=1` 才弹）；**无人观看也继续 stepping**（游戏不冻结，只跳过画面/音频
   推送；`ROMCTL_AUTOPAUSE=1` 恢复闲置暂停）；`/status` 带 `v` 版本号（v3.1）；`/projects`
   动态发现翻译工程；**`/run`、`/key` 长帧执行分片让出事件循环**（每 12 帧
   setImmediate，agent rom_run 3600 帧期间探活不再超时）；StudioPanel 探活
   超时显示「● 繁忙（agent 执行中）」而非掉线（连续 3 次失败才判未连接）。pi-web 经 `next.config.ts` rewrite 把 `/gba-api/*` 代理到 serve，
   工作台页面缺 `?api=` 参数时自动走此代理。工作台 UI：tabs 并入顶栏、会话回放入口
   暂隐藏（section 保留）、字库槽位图为纯文字信息。
2. **引擎路径回退链**（扩展 `resolveEngineDir`）：工作区 gba/ 副本 → 遗留仓库根（gbajs2）→
   `%PI_CODING_AGENT_DIR%/../../payload/gba`（客户端安装布局）→ 开发兄弟目录；
   码表/字库/脚本用 `firstExisting` 双布局回退。**改路径层级时务必同步两份扩展
   （gbajs2 与 pi-web 的 .pi/extensions）并重跑两套测试。**
4. **运行时数据与引擎分离**：翻译工程与 ROM 绑定、运行时动态创建，存于工作区
   `projects/`，**不进 payload**；romctl serve / 扩展工具经 `GBA_WORKSPACE_DIR` /
   `ctx.cwd` 解析。**工程名不硬编码**（translation-er 只是历史示例）：新增 `/projects`
   端点动态发现；`/review` 未指定时单工程自动选用、多工程要求 `?project=`；
   text_validate/text_insert 的 `project` 参数可选（省略时自动发现，0/1/多分支处理）。
5. **AV 自愈**：腾讯电脑管家等会拦截"新复制 exe"的回环连接（LISTEN 但 accept 被滤）。
   bootstrap 就绪探测用分类判定：连接被拒=还没监听（冷启动慢）继续等满窗口；连得上但
   HTTP 无响应（连续 3 次）=拦回环特征，~6s 即杀进程树回退系统 node（PATH），并把决策
   落盘 data/node-fallback.json（7 天内免惩罚直启）。**回退后的系统 node 探测失败不再杀
   服务、不再弹错误窗**：主窗口初始页是捆绑加载页（no-cors 轮询 30141），msedgewebview2
   不受杀软回环拦截，通了自动跳转；失败仅记 data/logs/bootstrap.log（2026-10-01 实机：
   sysnode 日志 Ready in 141ms，却被误判成未就绪）。
   用户侧建议把安装目录加入安全软件信任区。

### 验证方式（装机后）
- 三端 200：pi-web(:30141)、romctl(:8645 /status)、工作台前端（pi-web /gba-studio/）
- `data/workspace/.pi/{skills,extensions}` 内容齐全；`data/agent/sessions/` 含欢迎会话；
  pi-web 会话 API 恰好列出该会话
- agent 实战：注入凭证后在 workspace 下 headless 跑 `pi -p`：
  rom_load → rom_run → rom_screenshot（图片返回、模型可描述画面），且不产生 gba/ 自愈拷贝

## gbajs2 底层引擎概述

gbajs2 是一个用纯 JavaScript 编写的 Game Boy Advance 模拟器，基于原版 Endrift 的 gbajs 项目进行了社区维护和改进。该项目使用 HTML5 Canvas 和 Web Audio API 实现图形渲染和音频输出，无需任何插件即可在现代浏览器中运行。以下内容为 gbajs2 引擎的分析报告，供理解 hook 点与内存布局时参考。

### 基本信息
- **原始仓库**: Endrift (已归档)
- **社区维护**: Andrew Chase
- **许可证**: BSD 风格许可证
- **在线演示**: https://andychase.me/gbajs2

## 核心架构

### 1. 主控制器 (js/gba.js)

**GameBoyAdvance** 类是整个模拟器的核心控制器，负责协调所有子系统：

```javascript
核心组件：
- cpu: ARMCore (ARM/Thumb 处理器)
- mmu: GameBoyAdvanceMMU (内存管理单元)
- irq: GameBoyAdvanceInterruptHandler (中断处理)
- io: GameBoyAdvanceIO (I/O 寄存器)
- audio: GameBoyAdvanceAudio (音频系统)
- video: GameBoyAdvanceVideo (视频系统)
- keypad: GameBoyAdvanceKeypad (键盘输入)
- sio: GameBoyAdvanceSIO (串行通信)
```

**主要功能**:
- ROM 加载和验证
- 存档管理 (localStorage/文件导入导出)
- 运行循环控制
- 存储状态序列化 (freeze/defrost)
- FPS 统计和节流控制

### 2. CPU 模拟 (js/core.js, js/arm.js, js/thumb.js)

**ARMCore** 类实现了 ARM7TDMI 处理器：

**指令集支持**:
- **ARM 指令**: 32 位指令，包括数据处理、乘法、加载/存储、分支等
- **Thumb 指令**: 16 位压缩指令集，提高代码密度

**处理器模式**:
- User, System, FIQ, IRQ, Supervisor, Abort, Undefined
- 银接寄存器支持 (Banked Registers)

**核心特性**:
```javascript
- 动态指令编译和缓存 (icache)
- 条件执行支持 (14 个条件码)
- CPSR 寄存器管理 (标志位: N, Z, C, V)
- 桶形移位器 (Barrel Shifter)
- 中断处理 (IRQ, SWI)
```

**性能优化**:
- 指令缓存页面 (Page-based instruction cache)
- 预取优化
- 写入 PC 特殊处理

### 3. 内存管理 (js/mmu.js)

**GameBoyAdvanceMMU** 类管理 GBA 的内存映射和访问：

**内存区域映射**:
```
0x00000000-0x00003FFF: BIOS (16KB)
0x02000000-0x0203FFFF: 工作 RAM (256KB)
0x03000000-0x03007FFF: 内部 RAM (32KB)
0x04000000-0x040003FF: I/O 寄存器 (1KB)
0x05000000-0x050003FF: 调色板 RAM (1KB)
0x06000000-0x06017FFF: 视频 RAM (96KB)
0x07000000-0x070003FF: OAM (对象属性内存, 1KB)
0x08000000-0x0DFFFFFF: 卡带 ROM (32MB)
0x0E000000-0x0E00FFFF: 卡带 SRAM (64KB)
```

**内存视图类**:
- **MemoryView**: 基础内存视图，支持 8/16/32 位访问
- **MemoryBlock**: 带指令缓存的内存块
- **ROMView**: 只读 ROM，支持 GPIO 写入
- **BIOSView**: BIOS 内存，带有保护检查
- **BadMemory**: 未映射内存的 Open Bus 行为

**DMA 控制器**:
- 4 个 DMA 通道 (DMA0-DMA3)
- 传输时序: 即时、VBlank、HBlank、自定义
- 地址控制: 增量、减量、固定、重载
- 支持 16 位和 32 位传输

**等待状态管理**:
- ROM 访问时序控制
- 顺序访问优化
- 预取控制

### 4. 视频系统 (js/video.js, js/video/software.js, js/video/proxy.js)

**GameBoyAdvanceVideo** 类管理显示控制：

**显示参数**:
```
- 分辨率: 240×160 像素
- HBlank: 68 像素
- VBlank: 68 行
- 总周期: 280,896 周期
```

**背景模式**:
- **模式 0**: 4 个文本背景层
- **模式 1**: 2 个文本 + 1 个旋转/缩放背景
- **模式 2**: 2 个旋转/缩放背景
- **模式 3**: 16 位直接颜色背景 (320×240)
- **模式 4**: 8 位直接颜色背景 (320×240, 双帧)
- **模式 5**: 16 位直接颜色背景 (160×128, 双帧)

**渲染组件**:
```
- GameBoyAdvanceSoftwareRenderer: 软件渲染器
- GameBoyAdvanceVRAM: 视频 RAM 管理
- GameBoyAdvancePalette: 调色板和颜色混合
- GameBoyAdvanceOAM: 对象属性内存 (精灵)
- GameBoyAdvanceOBJ: 精灵对象
```

**特殊效果**:
- Alpha 混合 (16 种颜色混合)
- 亮度/对比度调整
- 马赛克效果
- 窗口系统 (Win0, Win1, WinOut, ObjWin)

**精灵特性**:
- 4 种形状和大小组合
- 水平/垂直翻转
- 仿射变换 (旋转/缩放)
- 模式: 正常、半透明、窗口
- 优先级 (0-3)

### 5. I/O 寄存器 (js/io.js)

**GameBoyAdvanceIO** 类实现所有 GBA 硬件寄存器：

**寄存器类别**:
```
视频寄存器 (0x000-0x054):
- DISPCNT, DISPSTAT, VCOUNT
- BGxCNT, BGxHOFS, BGxVOFS
- BGxPA, BGxPB, BGxPC, BGxPD
- BGxX, BGxY
- WIN0H, WIN1H, WIN0V, WIN1V
- WININ, WINOUT, MOSAIC
- BLDCNT, BLDALPHA, BLDY

音频寄存器 (0x060-0x0A6):
- 声道 1-4 控制
- 音频控制寄存器
- 波形 RAM
- FIFO A/B

DMA 寄存器 (0x0B0-0x0DE):
- DMAxSAD, DMAxDAD, DMAxCNT

定时器寄存器 (0x100-0x10E):
- TMxCNT_LO, TMxCNT_HI

SIO 寄存器 (0x120-0x158):
- SIODATA, SIOCNT, RCNT
- JOY 寄存器

中断寄存器 (0x200-0x208):
- IE, IF, IME

其他 (0x300-0x301):
- POSTFLG, HALTCNT
```

### 6. 中断和定时器 (js/irq.js)

**GameBoyAdvanceInterruptHandler** 类管理中断系统：

**中断类型**:
- VBlank: 垂直消隐
- HBlank: 水平消隐
- VCounter: 计数器匹配
- Timer 0-3: 定时器溢出
- DMA 0-3: DMA 完成
- Keypad: 按键输入
- Cart: 卡带事件

**定时器系统**:
- 4 个 16 位定时器
- 级联模式支持
- 可选预分频 (1 或 64)

**中断控制**:
- IME: 主中断使能
- IE: 中断使能标志
- IF: 中断标志

### 7. 音频系统 (js/audio.js)

**GameBoyAdvanceAudio** 类实现音频输出：

**音频通道**:
1. **声道 1**: 方波 + 频率包络
2. **声道 2**: 方波 (无包络)
3. **声道 3**: 波形播放 (8 位 PCM)
4. **声道 4**: 噪声生成
5. **FIFO A/B**: DMA 驱动音频

**特性**:
- 4 个 PSG 声道
- 2 个 FIFO 声道
- 8 位或 16 位采样
- 可选输出到左/右声道
- 主音量控制
- Web Audio API 集成

### 8. 存档系统 (js/savedata.js)

**存档类型**:
1. **SRAMSavedata**: 静态 RAM (64KB)
2. **FlashSavedata**: Flash 存储器 (512KB 或 1MB)
3. **EEPROMSavedata**: EEPROM (8KB)

**功能**:
- 自动检测存档类型
- Flash 擦除/编程命令支持
- EEPROM 读/写命令支持
- 存档状态持久化

### 9. 输入处理 (js/keypad.js, js/sio.js, js/gpio.js)

**GameBoyAdvanceKeypad** 类处理按键输入：
- 10 个 GBA 按键映射
- 键盘中断支持
- 可选输入吞噬模式

**GameBoyAdvanceSIO** 类实现串行通信：
- 常规模式 (8 位传输)
- 多玩家模式
- UART 模式
- JOY 总线模式

**GPIO** 类实现通用 I/O：
- 用于卡带外设 (如 RTC)
- 读写方向控制

## 渲染架构

### 软件渲染器 (js/video/software.js)

**渲染流程**:
```javascript
1. 准备扫描线:
   - 清除模板缓冲区
   - 设置背景颜色

2. 按优先级绘制图层:
   - 背景层 (BG0-BG3)
   - 精灵层 (OBJ0-OBJ3)
   - 背景层

3. 应用窗口系统:
   - Win0/Win1/WinOut/ObjWin
   - 窗口内外的渲染控制

4. 应用混合模式:
   - Alpha 混合
   - 亮度/对比度调整
   - 马赛克效果

5. 转换到输出格式:
   - 16 位 BGR -> 32 位 RGBA
   - 写入 Canvas
```

**渲染优化**:
- 扫描线级缓存
- 跳过不可见像素
- 空闲跳过
- 图块缓存

### Web Worker 代理 (js/video/proxy.js)

**GameBoyAdvanceRenderProxy** 类提供可选的 Worker 渲染：
- 将渲染移至独立线程工作
- 减少主线程阻塞
- 提高响应性

## 性能优化

### 1. 指令缓存
- 页面级缓存 (默认 8-10 位)
- 动态编译为 JavaScript 函数
- 缓存失效检测

### 2. 内存访问优化
- 直接使用 TypedArray
- 避免边界检查
- 对齐访问优化

### 3. 渲染优化
- 扫描线级渲染
- 跳过透明像素
- 模板缓冲区优化

### 4. 时间管理
- 周期精确模拟
- 等待状态模拟
- 帧同步

## 存储状态系统

### 序列化机制

每个组件实现 `freeze()` 和 `defrost()` 方法：

```javascript
freeze() {
    return {
        cpu: this.cpu.freeze(),
        mmu: this.mmu.freeze(),
        irq: this.irq.freeze(),
        io: this.io.freeze(),
        audio: this.audio.freeze(),
        video: this.video.freeze()
    };
}
```

**支持的功能**:
- CPU 寄存器状态
- 内存内容
- 硬件寄存器
- 渲染器状态
- 音频状态

## 调试和开发

### 调试器界面 (debugger.html)

**特性**:
- 断点管理
- 单步执行
- 寄存器查看
- 内存查看
- 反汇编视图
- 调用栈跟踪

### 日志系统

**日志级别**:
- LOG_ERROR: 错误消息
- LOG_WARN: 警告消息

- LOG_STUB: 未实现功能
- LOG_INFO: 一般信息
- LOG_DEBUG: 调试信息

### 兼容性列表

项目维护了一个兼容性列表，记录不同 ROM 的运行状态。

## 文件结构

```
gbajs2/
├── index.html          # 主界面
├── console.html        # 控制台界面
├── debugger.html       # 调试器界面
├── bios.S             # BIOS 汇编源码
├── COPYING            # 许可证
├── README.md          # 项目说明
├── js/               # JavaScript 源代码
│   ├── core.js        # CPU 核心
│   ├── arm.js        # ARM 指令解码
│   ├── thumb.js      # Thumb 指令解码
│   ├── mmu.js        # 内存管理
│   ├── io.js         # I/O 寄存器
│   ├── audio.js      # 音频系统
│   ├── video.js      # 视频控制
│   ├── video/        # 渲染器
│   │   ├── software.js  # 软件渲染
│   │   ├── proxy.js     # Worker 代理
│   │   └── worker.js    # Worker 线程
│   ├── irq.js        # 中断处理
│   ├── keypad.js     # 键盘输入
│   ├── sio.js        # 串行通信
│   ├── savedata.js   # 存档系统
│   ├── gpio.js       # GPIO 控制
│   ├── gba.js        # 主控制器
│   └── util.js       # 工具函数
└── resources/         # 资源文件
    ├── main.css      # 样式表
    ├── xhr.js        # XMLHttpRequest 封装
    └── biosbin.js   # BIOS 二进制数据
```

## 使用方法

### 基本使用

```javascript
// 创建模拟器实例
const gba = new GameBoyAdvance();

// 设置画布
gba.setCanvas(canvasElement);

// 加载 BIOS
gba.setBios(biosArrayBuffer, true);

// 加载 ROM
gba.setRom(romArrayBuffer);

// 开始运行
gba.runStable();

// 暂停
gba.pause();
```

### 存档管理

```javascript
// 导出存档
gba.downloadSavedata();

// 导入存档
gba.loadSavedataFromFile(fileObject);

// Base64 编码/解码
const state = gba.encodeBase64(view);
const data = gba.decodeBase64(string);
```

### 事件监听

```javascript
// VBlank 回调
gba.video.vblankCallback = function() {
    // 每帧调用一次
};

// 绘制回调
gba.video.drawCallback = function() {
    // 渲染完成后调用
};

// FPS 报告
gba.reportFPS = function(fps) {
    console.log('FPS:', fps);
};
```

## 技术特点

### 优点

1. **纯 JavaScript 实现**: 无需 WebAssembly 或原生模块
2. **浏览器兼容性**: 支持所有现代浏览器
3. **无外部依赖**: 单文件即可运行
4. **完整功能**: 支持 GBA 所有硬件特性
5. **可调试**: 内置调试器和日志系统
6. **存档支持**: 自动存储到 localStorage
7. **开源许可**: 允许自由使用和修改

### 限制

1. **性能**: 纯 JavaScript 比 WebAssembly 慢
2. **兼容性**: 部分游戏可能存在兼容性问题
3. **音频**: 部分音频特性未完全实现
4. **调试**: 调试功能需要额外窗口

## 扩展和定制

### 添加新的音频后端

```javascript
// 扩展 GameBoyAdvanceAudio
class CustomAudio extends GameBoyAdvanceAudio {
    constructor() {
        super();
        // 自定义初始化
    }
}
```

### 自定义渲染器

```javascript
// 实现渲染器接口
class CustomRenderer {
    clear(mmu) {}
    setBacking(backing) {}
    drawScanline(y) {}
    finishDraw(caller) {}
}
```

### 添加调试钩子

```javascript
// 监控内存访问
gba.mmu.load8 = function(offset) {
    console.log('Read:', offset.toString(16));
    // 调用原始方法
};
```

## 安全性和兼容性

### 安全性检查

- BIOS 内存保护
- 无效地址处理
- 寄存器权限控制
- 中断状态验证

### 浏览器兼容性

- Chrome/Edge: 完全支持
- Firefox: 完全支持
- Safari: 完全支持
- IE11: 有限支持

## 未来改进方向

1. **性能优化**: 使用 WebAssembly 重写核心循环
2. **兼容性**: 改进边缘情况的模拟
3. **音频**: 实现更多音频特性
4. **调试器**: 增强调试功能
5. **网络**: 添加联机对战支持
6. **移动端**: 优化移动设备体验

## 总结

gbajs2 是一个功能完整、架构清晰的 GBA 模拟器实现。其模块化设计使得各个子系统（CPU、内存、视频、音频等）相互独立又紧密协作。软件渲染器的实现特别值得关注，它展示了如何在 JavaScript 中高效地实现复杂的图形渲染。

该项目不仅是一个实用的模拟器，也是学习模拟器开发和嵌入式系统模拟的优秀资源。通过研究其代码，可以深入理解 GBA 的硬件架构和模拟器设计原理。

### 代码质量评估

- **架构**: ⭐⭐⭐⭐⭐ 模块化设计清晰
- **性能**: ⭐⭐⭐⭐ 软件渲染优化良好
- **兼容性**: ⭐⭐⭐⭐ 支持大多数游戏
- **可维护性**: ⭐⭐⭐⭐⭐ 代码组织良好
- **文档**: ⭐⭐⭐ 代码注释充分，外部文档较少

### 学习价值

对于想了解以下内容的开发者，gbajs2 是优秀的学习资源：
- ARM 架构模拟
- 嵌入式系统模拟
- JavaScript 性能优化
- 图形渲染技术
- 音频处理
- 模拟器架构设计

---

**文档生成时间**: 2026-03-15  
**分析版本**: gbajs2 Community Fork  
**代码库路径**: D:\vibecoding\gba-font-studio\gbajs2
