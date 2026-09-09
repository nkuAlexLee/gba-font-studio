---
name: gba-font-crack
description: GBA 宝可梦改版 ROM 中文字库破解全流程：正向分析范式（定位引擎→控制流→探针实证）、无头调试（romctl/serve 实时交互+插桩取证）、整库插入+渲染 hook 为标准路线（ESC 编码、多字号渲染器）、ER 画布渲染引擎全解码（blitter→WORKBUF→合成器→位图上下文，2:1 亚采样定论）、槽位注入仅限验证、字符串修改与 NEW GAME 截图像素校验、回归 vs 模拟器缺陷的对照实验二分法。当需要给 Pokemon 改版 ROM 打中文字库、改菜单文本为中文、分析中文渲染引擎、用 romctl 调试 GBA 内存/hook/截图、处理字形格式（2bpp 压缩、LUT 展开、1bpp 位流）、逆向画布/位图渲染引擎、排查 hook 后乱码/卡死问题时使用。
---

> **⚠ pi-web 仓库版路径注记**：本仓库（pi-web）中引擎与数据自包含于 `gba/` 子目录——
> romctl 为 `node gba/romctl.js serve`；码表/字库在 `gba/assets/`；翻译工程在 `gba/translation-er/`；
> 流水线产物在 `gba/work/`。pi 扩展（`.pi/extensions/gba-fontpatch.ts`）已自动指向这些路径，工具优先。

# GBA 中文字库破解

> **★ 分工**：渲染能力（字库/hook/验证）= 本 skill；翻译内容回填 = `../gba-text-translate/`。
> **★ 接任务先查 `cases/README.md` 索引**，找同基板/同引擎的成功案例照搬已验证手段；
> 每次成功破解必须按阶段 6 归档并登记索引。

## 〇、路线决策树（先读这个）

```
引擎已支持中文（双字节取字特征 probe-dualbyte / 已有字库版）？
├── 是 → 【方案 A】只改字符串，翻译走 gba-text-translate
└── 不支持 → 目标是整游戏汉化？
    ├── 是 → 【方案 C ★标准路线】整库插入 + RenderText hook（ESC 编码）→ 走六阶段
    └── 只需验证字库格式逆向（≤3 个字）→ 【方案 B】槽位注入（零 hook，必然兼容）
```

- 方案 B 与原版渲染同路径必然兼容，但槽位天花板极低（EliteRedux 仅剩 3 空槽），
  **只用于验证；不要用槽位方案堆字数**
- **改菜单/界面串为中文 = 字库验证手段，不是翻译**；正式翻译一律 gba-text-translate 回填
- 方案 C 的 hook 跳板必须逐条核对本 ROM 实际指令排布
- **渲染尺寸需求先查 §四-ER 画布引擎**：合成器=固定 2:1 亚采样，窄字源=点阵化
  （踩坑 47），小尺寸文本需另想办法（细笔画/文案缩短）

## 一、工具链速查

### romctl.js（无头调试引擎，状态跨命令连续；均先 `cd gbajs2`）

```bash
node romctl.js load <rom.gba>          # 加载（重置状态，hook 需重新 add）
node romctl.js run [frames]            # ⚠单批上限 3600，长时序分多次
node romctl.js key A,START [frames]    # 按住按键跑 N 帧后松开
node romctl.js screenshot [out.bmp]    # 截图（read 工具直接查看）
node romctl.js memread <addr> [len] / memwrite <addr> <hex>
node romctl.js disasm <addr> [n] / regs / info
node romctl.js snap <name> / diff <name>       # 快照 / 对比找内存变化
node romctl.js hook add <addr|preset rs|emerald> [name]
node romctl.js hook events [--chars] / hook clear
```
产物全在 `tmp/`（state json、截图、hook-events.jsonl）。

### serve 即时存档（命名多槽位快照）

```bash
curl "http://127.0.0.1:8645/snap?op=save&name=标题屏"   # 存当前状态 → tmp/snaps/标题屏.json
curl "http://127.0.0.1:8645/snap?op=load&name=标题屏"   # 读档（逐字节确定性恢复）
curl "http://127.0.0.1:8645/snap?op=list"               # 列出快照（含 frames/emuVer/verMatch）
curl "http://127.0.0.1:8645/snap?op=del&name=旧档"
```
- **emuVer 版本防护**：快照记录模拟器语义代码哈希；load 版本不符**默认拒绝**，确信无影响才 `&force=1`
- **排查纪律**：①改模拟器代码后对照基准快照必须**重录**；②快照不恢复 watch/hook 事件缓冲；③读档后跑 1 帧再截图

### serve 实时调试服务器（★优先）

`node romctl.js serve [port=8645]` 后台启动，状态常驻、CLI 命令互通：

```bash
curl "http://localhost:8645/status"
curl "http://localhost:8645/run?frames=600"        # /key?keys=DOWN&frames=40
curl "http://localhost:8645/shot?name=s1"          # 截图 → read 看 → 决定下一步按键
curl "http://localhost:8645/memread?addr=0x02000000&len=32"
curl "http://localhost:8645/hookadd?addr=0x080653D8&name=printtext"
curl "http://localhost:8645/hookevents?tail=50"
curl "http://localhost:8645/load?rom=path.gba"     # 换 ROM（重置状态与 hook）
```
★交互循环：/shot 看画面 → 决定按键 → 再 /shot，避免预录长键序时序错位。
结束：用锁文件 PID 重启机制，不要 taskkill 全部 node（会杀掉 pi agent 自己）。

**★/memread 与 /shot 陷阱**：
- `/memread` len **必须十进制且 ≤4096**：`len=0x90` 被 parseInt(…,10) 解析成 0 →
  静默返回空；超 4096 静默截断。大区域分块循环拼接（踩坑 45）
- `/shot?file=X` 的路径会被净化（返回 JSON 的 `file` 字段才是真实落盘路径，
  如 `tmp/tmp_X.bmp`），跨会话对比截图以返回值为准

**会话录制与确定性重放**：
```bash
curl "http://localhost:8645/session?op=start"   # ...操作... op=stop / op=steps / op=replay
```
重放帧号与结束快照一致、截图逐像素 diff 0。用途：复现 bug、验证汉化后行为不变。

### 内存取证与插桩（2026-09-07 新增）

```bash
node tmp/bmp2png.js <in.bmp> <out.png> [cropH_bottom] [scale]  # BMP→PNG（BMP 不压缩超 read 50KB 限制）
node tmp/dis.js <rom.gba> <GBA地址hex> [指令数] [arm]           # 无头反汇编 CLI（thumb-disassembler 的 MMU 桩封装）
```
- **blit 快照仪**（取证字形 blit 输出的标准模式）：把 blit 循环最后一次调用的返回地址
  字面量改指插桩拷贝循环（WORKBUF → EWRAM 暂存区），插桩后回流原返回点。
  **插桩必须成为返回目标**（bx+lr 模式下插在中间 = 死代码，踩坑 43）；可按窗口字段
  （如 [r4+9]=Y）分流多暂存区，同帧区分不同 widget 的码流。范本见
  `fontpatch/elite-redux-fullfont.s` 历史版本（@@snap，已回滚）
- **hookadd/hook 必须偶地址**（Thumb PC 对齐；奇地址静默永不触发，踩坑 42）
- **内存取证 stride/格式先用直方图自校**（踩坑 44），画布可能是双缓冲/多画布（踩坑 47）

### 离线分析

```bash
node scripts/disasm-offline.js <rom.gba> <GBA地址hex> [指令数] [--arm]
```
- `scripts/bmp-ascii.js` — 截图像素校验（NEW GAME 范式判定工具）
- `scripts/trace-after-hook.js` — hook 命中后逐指令 trace，反查异版本引擎函数
- `scripts/watch-read.js` — 监视内存区间读取并记录读取者 PC（零假设定位大杀器）
- `scripts/patch-elite-redux-2651.js` — EliteRedux 槽位注入（v6 早期验证路线）
- `fontpatch/armips-src/armips.exe` + `fontpatch/tileconv_elite.s`（Thumb 注入范例）
- `../gba-text-translate/scripts/` — 文本翻译/回填相关工具

---

## 二、标准工作流（六阶段）

> 主范式 = 正向分析：定位引擎 → 梳理渲染控制流 → 探针实证数据格式 →
> 最低风险修改点。每个结论都要**静态反汇编 + 动态运行时证据**双重支撑。
> 实战样本：cases/EliteRedux-正向分析（第三方补丁盲改多日无果，正向分析一次打通）。

**阶段 0 侦察**：ROM 头定基板（BPEE=Emerald 系/BPRE=FRLG 系）；文件大小定扩容；
现成中文版 ROM 只用于 diff 学习格式，**不要搬它的 hook/地址**（decomp 重编译布局必变，
且补丁本身可能有原理性缺陷）。

**阶段 1 定位文本引擎与 hook 点**——特征搜索（命中率从高到低）：
1. 已知版本函数签名搜索 + 平移规律（同引擎函数群常整体平移，EliteRedux -0x532C）
2. 控制符判断特征（版本而异：stock Emerald `sub r0,#0xF8+cmp #7`；EliteRedux `(c+8)&0xFF≤7`）
3. currChar 模式 `ldr rX,[rY]; ldrb rZ,[rX]` 后紧跟 `adds #1; str`
4. 跳转表分发 `mov pc,r3`（469F）附近 pool
5. 已知明文/编码字符串反查（Emerald charmap：A=0xBB.. 小写 a=0xD6..，FF=结束符）

动态互证：IWRAM/EWRAM 搜字符串指针定窗口结构体；快照 diff 找渲染缓冲；
hook 候选地址看触发。⚠ pool 字面量是指针值不是表（`ldr r2,=X` 的 X = 指针数组首址）。
**hook 点**：读字符后、控制符分发前；跳板完整复现被覆盖指令；失败路径回流下一条未覆盖指令。

**阶段 3 逆向渲染管线**：沿执行流逐层 dump（分发器→字体 handler→解压函数→
写入目标与消费者）。数据格式**用探针实证而非理论推导**：写全值/非对称图案 →
真实渲染 → 读回缓冲逐字节比对（一次确定 2bpp 语义、半字装配、像素序三件事）。
ER 这一步产出 = 画布渲染链（见 §四-ER 画布引擎，快照仪+反汇编 CLI 是主力工具）。

**阶段 4 修改**：方案取舍见 〇 决策树。整库路线要点见四 EliteRedux v7 小节。

**阶段 5 验证（NEW GAME 范式）**：主菜单是第一个渲染的文本 = 最小验证载体，
改串为中文仅为验证渲染链（正式翻译走 gba-text-translate）。判据 = 截图像素分析
（`scripts/bmp-ascii.js`，不靠目测）：
1. 定位：标题屏 START 进菜单；ASCII→charmap 搜串（"New Game" = C8D9EB00C1D5E1D9FF）
2. 替换：等长优先；改短用 FF 收尾+00 填充；编码查 assets/wholewords.txt
3. 时序：先 run 到标题屏亮起再按 START（按早被吞）。Emerald 系 = run 3600+1500 → START → 600
4. 像素分析：ASCII 图与预期字形逐行一致；包围盒宽 = N字×步进（不足 = 右列被裁）
5. 回归：方向键切换重渲染不变坏；进子界面确认英文路径无损
6. 对照：保留"英文原串+其他修改"对照 ROM（控制变量法）

**阶段 6 归档**：版本号递增存 tmp/；结论实时写入本 skill；失败路径也要记。
成功后 `cases/<案例名>/`（README 实录 + scripts/ + data/ + artifacts/）并登记索引。

---

## 三、踩坑知识库

### 症状速查（→ 条目号）

| 症状 | 条目 |
|------|------|
| hook 零事件/不触发 | 4, 7, 36, 37, **42** |
| 插桩读数不变/陈旧（快照死代码） | **43** |
| memread 空返回/静默截断 | **45** |
| 画布 dump 全是纹理没文本 | **44, 47** |
| 窄字形源渲染点阵化 | **47**（画布引擎） |
| 同屏部分 widget 乱码部分正常 | **46**（widget 路径分离） |
| 中文不显示/空白/被裁 | 26, 29(右列), 33, 34, 39 |
| 中文变重音字母乱码 | 22, 23, 24 |
| 游戏崩溃/跳飞/Illegal instruction | 13, 14, 15, 16, 17, 18, 28 |
| 特定界面进即挂死（pc 恒 0x1c）| 40 |
| 死循环/渲染失控 | 28, 12(残留污染) |
| 修好的东西突然全坏 | 10, 21, 12 |
| 时序错位/按键落错状态 | 3, 9 |
| 黑屏（转场/场景） | 11(先做对照实验!) |
| 自检 100% 但整字全错 | 39 |
| 工具显示/输出异常 | 31, 35, 36 |
| LUT/映射表全错 | 35, 38 |
| 写了没效果 | 29, 30 |

### 模拟器/工具（1-12）

1. **必须软件渲染器**：memview/romctl 不加载 `js/video/proxy.js`（Worker 渲染静默黑屏）
2. **gba.freeze() 不可用**：Serializer.prefix 依赖浏览器 Blob；romctl 用自己的 JSON 快照，恢复前必须先 setRom
3. **romctl run 单批 3600 帧上限**（静默截断）——长时序分多次 run，否则按键时序全错
4. **进程崩溃时 hook 事件不 flush**（runFrames 中途 throw）——0 事件 ≠ 没触发
5. VRAM 无 overwrite()，用 `vram.buffer.set()`；OAM/Palette 用 overwrite
6. 截图全黑但能操作 = 渲染路径问题；画面冻结 = 每帧异常被 pause（看 stderr）
7. **hook 前必须 load**：load 重置 state 会清掉 hook
8. **hook preset（rs/emerald）是美版地址**：非美版/改版基板引擎整体平移且**各区域平移量不同**（蓝宝石：文本区 +0x134、战斗区 +0x324），preset 不触发 ≠ 函数不存在——先用 trace 法重定位（cases/红龙传说 §三）；非美版查 `assets/symbols/` 对照表
8b. **★serve 下截图/音频的正确姿势**：serve 运行时 CLI `screenshot` 读的是落盘快照（最多滞后 600 帧）——白屏/黑屏诊断若全靠 CLI 截图会全错！必须用 HTTP `/shot?file=x.bmp`（活体画面）。音频走 `GET /audio`（float32 交错 L/R，32768Hz）。详见技术报告 §4.7。
8c. **★serve-only 架构**：memview 只做手柄+屏幕+内存监视，模拟器只在 serve 侧；音频=复用 gbajs2 Audio 消费器（clear() 补假 core、手动 connect、环扩 2s、outputPointer 起点四个陷阱），推帧实时节流。详见技术报告 §4.7。
8e. **★WebSocket 推送通道**：serve 内置手写 WS。服务端帧泵=每帧 runFrames(1)+推 BMP+音频+setImmediate 还栈+忙等补齐 16.7ms。三坑：①画面攒批=掉 fps（必须每帧推）②Windows 15.6ms 定时器粒度（忙等消除，见 8f）③同步泵不还栈饿死 I/O。详见技术报告 §4.8。
8f. **★Windows 定时器粒度（通用坑）**：所有睡眠原语被量化到 15.6ms。精确节流只有忙等（performance.now 自旋）。终止 serve 用锁文件 PID 重启，不要 taskkill 全部 node。
8d. **★写只读寄存器 open-bus（已修复）**：gbajs2 旧版读只读 DMA/FIFO 寄存器恒返回 badMemory[0] → 游戏轮询标志永假 → 无限轮询饿死。已改 js/io.js 返回最后写入值（与 mGBA 一致）。
8g. **★BIOS 区保护读 open-bus（已修复）**：真机返回 biosPrefetch（0xE... 恒负）；坏实现返回当前指令半字（恒正）→ 判负分支翻转（踩坑 11 根因之一）。
8i. **★CPU 半字访问对齐/符号扩展（已修复）**：LDRH/STRH 地址 bit0 清零；LDRSH/LDRSB 符号扩展。注意 thumb-disassembler 曾把 0x57DF 误标 ldrsh（实为 LDRSB）——反汇编输出必须人工复核 bits[11:9]（011=LDRSB, 101=LDRH, 111=LDRSH）。
8h. **★romctl watchwrite 长度参数陷阱（已修复）**：len=0x1C 被 parseInt(…,10) 解析成 0 → 监视范围为 0 → 永不命中且无报错。"/零写入"结论前先 /wwdebug；/load 会重建内存块（已自动重包装 watchwrite，hook 仍需重新 add）
9. **预录长按键序列极易时序错位**——改用 serve 模式逐步交互（/shot 看画面 → 决定按键）
10. **注入函数严禁越界覆盖**：算准 bin 大小与空区边界（曾把 96B 写进 48B 空隙覆盖跳板前半）
11. **★回归 vs 模拟器缺陷的二分法（serve 对照实验）**：疑似补丁卡死/黑屏，先在 serve 模式用**完全相同按键流程跑原版 base** 到同一位置——原版也黑 = gbajs2 模拟缺口（非补丁问题），换 mGBA/实机验证补丁。三个已修复缺口 + 一个未解缺口（详见技术报告 §4.9、§8-§12）：
    - **BIOS 保护读 open-bus（已修复）**：真机返回 biosPrefetch（恒负），旧版返回当前指令半字（恒正）→ 依赖负值判定的代码死循环 17.5 亿次（红龙传说 InitBackupMapLayoutConnections NULL 检查）。修复 = mmu.js biosPrefetch + BIOSView 切片 + core.js raiseTrap 出口指令字 + irq.js HLE swi 0xE3A02004
    - **SWI 0x04/0x05 IntrWait（已修复）**：旧版清 IF 后立即返回不等待，真机 HALT 到 VBlank。后果 = gate 槽读 0 → fade 锁存不清 → 转场永久黑屏。修复 = js/irq.js waitForIRQ + intrWaitPoll
    - **EliteRedux boot 相位初始化从不执行（未解）**：自定义 boot/相位初始化（指针表 0x084B2298）在 gbajs2 零命中 → EWRAM 文件系统表（扩展条目/FAT 姊妹表）从未建立 → 文件加载提前退出 → 瓦片/调色板永不到位；gate12 安装/卸载竞态 + fade 锁存只是永久化机制。memwrite 伪造 fade 完成、注入 512B 表条目均不充分（缺整组表）。关键函数地图（setentry=0x8118084、submit=0x8117FF0、enqueue2=0x8253810 等）与技术报告 §8-§12。**实用结论：NEW GAME 开场链在 gbajs2 不可用，进游戏走存档导入（mGBA 过开场 → .sav → CONTINUE）；guardian（/guardian?on=1）修战斗期引擎死亡；一次性内存补丁会被场景切换冲掉**
    - 工具教训：①memread hex 是小端，多字节一律 readUInt16LE（"8500"≠0x8500）②pchist pc 无前导零，Thumb 用偶地址 ③快照恢复后 audio 与 IO 失配 → 栈溢出（io.defrost 重放 0x60-0xB4 修复）④serve 端点 /regs /pchist /watchio /watchwrite /watchdma /callertrace /guardian /irqcount（DMA 写走快路径 store32 不可见，必须 /watchdma）⑤IO 读写路径读数不一致，诊断以 watchio 写入侧为准
12. **★函数区指令流零分叉 = 洞无辜的实锤**：trace-after-hook 采 base 与补丁版同函数区域指令流做 pc/寄存器对齐比对，零分叉则立即转向洞外因素（实例：RT 洞 1705 条零分叉，真凶是 GSW 区 v1 残留污染）

### 地址与汇编（13-21）

13. **GBA 地址 = 0x08000000 + 文件偏移**，算错 0x01000000 → 崩溃信息含 ICACHE_PAGE_BITS = 跳到不存在的内存 region
14. **push/pop 必须平衡**：push 20B 配 pop 16B = 每次调用泄漏 4B 栈，多次后栈污染跑野地址
15. **decomp 重编译版不能搬 hook 字节**：地址一致但指令排布全新，hook 移植必须连被覆盖指令差异一起适配
16. **跳板里改寄存器必须在 push 之后**：之前执行 = pop 恢复脏值
17. **跳板返回点 = 被覆盖指令的下一条，一条不能跳过**（跳过 = 查表索引错乱）
18. **崩在 mov pc,rX 且 rX=垃圾** = 跳转表/函数指针路径错乱（lr 残留在渲染函数中部）；先核对失败分支回流地址
19. **仓库 baserom 全是 FF 占位文件**（法律原因），不能当字节参照；验证用真 ROM diff
20. **代码写入位置**：补丁区尾部/原版空区；armips .org 必须用正确 GBA 地址（pool 字面量跟着 .org 走）
21. **armips Thumb 语法**：`orr rd, rm` 两操作数；寄存器移位 `lsl rd, rm` 两操作数；**SP 相对只有字加载（无 ldrb [sp]）**

### 字形与编码（22-30）

22. **★多字号渲染器（FRLG 系通用结构）**：fontid 分发表 @0x0825738C pool→0x0901C2AC，四套字形渲染器：fontid 0→0x08257CD8（小字，base 0x0904F718，[buf+0x81]=13）、1→0x08257FFC（普通，0x09067D18，15）、7→0x08257D98（0x09057918，15）、8→0x08257E58（0x09047518，12）。四套宽字形 blit 模式相同（4×16B chunk，dst=0x03005600+0x20k），窄字形（≤8px）跳过 TR/BR chunk。**hook 只覆盖一个 fontid → 其它字号的窗口把双字节中文码当普通字符渲染成重音字母乱码**
23. **窗口 variant 门不能加**：[win+0x21]≠0 的窗口（标题栏等）也走渲染；加 variant==0 过滤 = 这些窗口漏拦截 → 乱码。正确做法：fontid 全放行
24. **全角标点码位字形不可靠**：merged charmap 给 。！？：等全角字分配了码位，能编码≠能渲染（。→看着像 "er"）。翻译产出一律半角标点
25. **X+0x20 是阴影层不是下半 tile**：写进去 = 主体新字形+旧字母阴影叠加 = 乱码
26. **宽字形塞 8px 槽必须整 8 像素对齐拆分**（左=列0-7 右=列8-10补空），拆错跳过中间列缺笔画
27. **引擎对 glyph 编码有区间修正**（0x01-05→-1、0x07-1A→-2、0x1C-1E→-3 等），自选槽位显示错位——黑盒探针法（每槽写可识别图案再渲染）测真实映射
28. **中文字节会撞游戏控制码**：Emerald 系 0x01-0x1B 区有控制符，字符串预处理/复制函数会吃掉或转义它们（hi=0x03 曾致渲染死循环）。选编码避开控制码区。**非英语基板另撞重音字母**：RS charmap 0x01-0x1E 是 Á/É/Ñ/é 字形字节，西语 GetStringWidth 会把重音字+后一字节当中文对（cases/红龙传说 §七）
29. **字体数组空槽/空字形 = 跳板代码的天然藏身处**（零扩容注入），但确认该槽不被引擎读作数据
30. **work buf/中间缓冲必须有消费者**：搜全 ROM 确认合法 pool 字面量引用，否则写了也白写（EliteRedux 第三方补丁用 0x030064EC 但真缓冲 = 0x03005600）

### 反汇编与编码器/验证（31-41）

31. **工具输出与预期不符时，人工核对原始字节**：thumb-disassembler 曾把 LSR 恒显示为 LSL（已修复）、误判条件分支 off-by-2——先逐位重推编码再改工具
32. **编码器必须有自检回路**：自编码→自解码→与源字模逐像素比对（<<1 vs <<2 这类 bug 肉眼难发现）
33. **字符步进 < 字形内容宽 → 右列被后字覆盖**：内容必须完整落在步进窗口内
34. **中文宽度 = 两个英文字符位**（2×6=12px），advance 与字形内容宽一起设计；拉丁字形自带右下阴影，中文补阴影才风格一致
35. **LUT 是运行时数据时转录极易出错**：从 memread 原文程序化转录，用已知字形（如 'N'）回代验证
36. **工具地址显示易看漏位**：手抄地址看漏一位 = 全部 hook 永不命中。零事件时先做对照实验（挂 0x08000000 重启向量）区分「地址错」vs「机制坏」
37. **romctl hook 按基本块首 PC 匹配**：函数中部地址可能在已编译块内部永不命中；跳表目标/函数入口安全。零事件 ≠ 没执行，用 watch-read 双验证
38. **同族引擎字形像素语义必须逐版探针实证**：XTREME 实证 1=深墨、2/3=灰影（与 Quetzal 0/3=透明 1=前景 2=阴影 不同）——LUT 运行时按文字色重填；自检比对锚点会造成假阴性
39. **★像素自检无法发现字库索引映射错误**：编码与比对共用同一解码函数时自洽但可能全错（XTREME：×256 索引把"新"渲染成"研"，自检仍 100%）。权威索引 = **(hi修正)×0xF7 + lo**（pokeE DecompressGlyph_Chinese）；必须外部参照验证（宋体/黑体栅格化对比）
40. **★ESC 前缀可能撞引擎自有控制码分发表（EliteRedux Option 页挂死根因）**：渲染侧 RenderText 被截流 ≠ 其它字符串消费器安全。EliteRedux GSW 控制码分发表 `(c+9)&0xFF≤7` → **0xF7 = 表[0] = "打印动态缓冲区"**（0x082577BC：读索引字节→bl 0x0810FA80 无边界检查→沿缓冲区找 0xFF）。汉字 hi 作索引指向全零 EWRAM → 永无 FF → 死循环（pc 恒 0x1c）。隐蔽性：多数汉字 hi 恰好指向含 FF 区域→侥幸不挂，只有个别串/界面才炸；GSW_HOOK（挂普通字符路径）收不到 F7（分发表先行劫走）。修复 = 原地 8B 改写 F7 handler（吃 hi/lo、宽 12、推进 2）。**通用法则：选 ESC 前缀前必须反汇编目标引擎全部字符串消费器（渲染/量宽/复制/展开）的控制码分发表，前缀避开所有特殊语义字节**
41. **★对话框末尾的"❤/♥"是翻页等待光标，不是文字**：Pokémon 文本框等待按键时在末尾渲染的光标符号，低分辨率 BMP 截图里易误读成心形字符。读图判读译文、像素校验、对照源串时不要把它当文本内容；每页末尾出现是正常现象

### 插桩与内存取证（42-47，2026-09-07 新增）

42. **★hookadd/hook 必须偶地址**：Thumb PC 恒偶对齐，奇地址钩子**静默永不触发**（无任何报错，与地址写错同症）。实证：blitter 0x082562A9 挂钩 0 事件，改 0x082562A8 立即正常。零事件先查地址奇偶再查机制
43. **★插桩代码必须成为返回目标**：`bx r6`+lr 返回模式下，插在调用点与原返回点之间的代码**永不执行**（死代码），读到的"快照"是陈旧内存。修法 = 改返回地址字面量（`ldr r3,=(@@snap+1)`）让插桩成为返回点，插桩尾回流原返回点。判据：插桩启用前后内存内容完全不变 = 插桩没跑
44. **★内存取证 stride/格式先用直方图自校**：画布 stride/像素格式连续三次误判（4B/px→16bpp→8bpp），每次渲染出"纯纹理"假象。正确流程：①dump 一行做字节直方图找重复单元 ②按候选 stride 渲染灰度图看可读结构 ③枚举全部画布指针（上下文表/描述符可能各指一块）④同地址不同时刻 dump 内容不同（画布是动态的），取证选静态画面
45. **serve /memread：len 上限 4096、必须十进制**：`len=0x90` 被解析成 0 → 静默返回空；>4096 静默截断。大区域分块循环拼接（每块 4096）
46. **★widget 级渲染路径必须逐个实证**：同屏不同 widget 可走不同渲染路径——ER 设置页实证：列表标签的小字码流渲染正常、底部 bar 同码流乱码（bar 有独立解码假设，未逆向）；全局 blit 换序会同时破坏两者（M-B 实验）。"同屏=同合成器/同路径"假设不可靠；hook/补丁效果必须逐 widget 验证
47. **多 canvas/双缓冲**：上下文表与描述符可指向不同画布（0x02001054 与 0x0203EEF8 并存），取证先枚举全部画布指针（上下文表 word@8、描述符 [r0+0x24]）再找文本；画布格式自校见 44

---

## 四、游戏知识库

### 编码体系（Emerald 系通用）
- 文本 = charmap 单字节；中文 = 双字节 [hi][lo]，hi∈0x01-0x1E（排除 0x00/0x06/0x1B），lo<0xF7
- 码表 `fonts/wholewords.txt`（hex=汉字，~6768 字）：新=0E4D 的=030B 游=0F7C 戏=0DDB
- 字库索引 = (hi-修正)×0xF7 + lo
- charmap 字母：A=0xBB、G=0xC1、N=0xC8、小写 a=0xD6..、空格=0x00、FF=串结束

### Emerald 字形格式（2bpp 压缩 + LUT，Quetzal 验证）
- 字体数组（Quetzal）@文件 0x1400BF4，64B/编码 = [主体 32B][阴影层 32B]
- 主体 = 16 行×u16(LE)，每行 8px×2bpp；值 0/3=透明 1=前景 2=阴影
- 运行时双 LUT 展开：LUT4 @0x08369CF4（ROM）、LUT5 @0x03000948（IWRAM），nibble A=透明 B=前景 C=阴影

### Quetzal（✅"新的游戏"上屏）
- 基座：`roms/PokemonQuetzalAlpha7v0(字库).gba`（已含中文引擎）+ 字符串改写
- 一键：`cd fontpatch && node patch-newgame-string.js`
- 主菜单串 @文件 0x137E070；hook@RenderText+0xBA(0x0800586E) → 跳板@0x081400C34 → 字库@0x1B7FFCC
- 关键地址（同 stock Emerald 布局）：RenderText=0x080057B4、GetStringWidth=0x08005ED8、DecompressGlyphTile=0x08004C04

### EliteRedux 2.65.1（✅ v7 整库路线；详细实录 cases/EliteRedux-正向分析/README.md）
- 与 beta2 完全不同代码布局（diff 59%）：文本引擎三函数整体平移 -0x532C：
  RenderText=0x08257010、GetStringWidth=0x082576E4、DecompressGlyphTile=0x08256CB0
- PokemonER 第三方补丁在本引擎**原理性不可行**（失败路径返回点落控制码跳转表内；
  gCurGlyph=0x030064EC 零合法引用，真缓冲=0x03005600）——勿再移植
- **FONT_NORMAL（fontid=1）字形数组** @文件 0x1067D18，64B/字 = 四个 8x8 tile，
  每行 u16：高字节=px0-3（2bpp MSB pair first）低字节=px4-7；宽度表 @0x106FD18
- 解压链：0x082572FA → bl 0x08257FFC → 宽>8 调 0x082562A8 ×4（src 步进 0x10 →
  dst=0x03005600 步进 0x20）→ 宽度写 [buf+0x80] → 公共后继 0x0825728C
- 像素语义（探针实证）：0/3=透明 1=前景 2=阴影；LUT4@0x090191E0 + LUT3@IWRAM 0x03005550（勿手抄）
- **v6 槽位注入（早期验证）**：空槽 0x0A/0x18/0x1F；字模 pokeE gba_chs_font_11x11.bin
  （glyphId=(hi修正)×0xF7+lo）；H_OFF=1 V_OFF=2 阴影(r+1,c+1) 宽 12；
  菜单串 @0xEFB11C（文字起点 x=16）——⚠ 改串仅为字库验证，翻译走 gba-text-translate；
  复现脚本 scripts/patch-elite-redux-2651.js
- **★v7 整库中文插入（标准路线）**：
  - ESC 编码 [F7][hi][lo] 3B/汉字；记录索引 = corrected_hi×256+lo
  - 字库全量 @GBA 0x0968A4D8（0xED700B，64B/字），代码洞 @0x09777C58；
    RenderText 截流 @0x08257098（12B detour）；GetStringWidth 不挂（挂了会因
    残留污染 GSW 函数体致 Option 页挂死，踩坑 12）
  - ★GSW 0xF7 中和补丁：ESC 前缀 F7 = GSW 控制码分发表表[0]（@0x0901C358 →
    0x082577BC "打印动态缓冲区"），汉字串进 GSW 量宽即可能指向全零 EWRAM 死循环
    （踩坑 40）。修复 = 0x082577BC 8B：add r4,#12; add r5,#2; add r7,#2; b 0x08257786。
    已集成进 elite-redux-fullfont.s；成品 roms/..._汉化beta.gba
  - RT 洞支持 fontid 0-8（四渲染器），出口按 fontid 写 [buf+0x81]；不加 variant 门
  - 回填 = gbajs2/translation-er 工程（gba-text-translate，escPrefix=f7）
  - ★改 .s 后必须 rebuild → insert → 拷贝成品（否则翻译与硬编码串全丢）
- 时序：load → run 3600 → run 1500（标题屏）→ START → run 600 → 菜单
- 已知限制：NEW GAME 开场链在 gbajs2 不可用（boot 相位初始化缺口，踩坑 11），
  进游戏走存档导入；字库验证用主菜单/设置页阶段即可

### ★EliteRedux 画布渲染引擎（2026-09-07 全解码；自定义 UI 文本路径）
```
RenderText（hook 截流 @0x08257098）
  → blitter 0x082562A8（★调色板 LUT 展开器：src 半字 → LUT[byte]@0x090191E0
    → 状态表@0x03005550 → dst；16B src→32B dst；保护 r4-r7、脏 r0-r3）
  → WORKBUF 0x03005600（每字形 128B = 4×32B tile 象限，行主序 TL,TR,BL,BR；
    [buf+0x80]=宽度 [buf+0x81]=高度）
  → RT_SUCC 0x0825728C（无条件消费 [buf+0x80] 推进光标 [r4+8]；[r4+0x20]=前字宽标志）
  → 合成器 0x082563BC（双 pass 基址 0x5600/0x5620，4B/行 nibble 移位读，
    裁剪 min(画布宽-[r0+8], 宽度)）
  → 上下文表 0x0203F748（每项 12B：[3]×8=画布宽 240、[4]×8=高 160、word@8=画布指针）
  → 16bpp 位图画布（480B/行，240×160；存在多画布/双缓冲）
```
- **关键事实**：
  - blitter = 调色板 LUT 展开器（非普通拷贝）：src byte(4×2bpp) → LUT[byte] →
    状态表索引 → 输出码；输出码 = 2 源像素合并的子像素对（状态表=4×4 组合，
    值域形如 0x11/0x21/0x31…，随场景重载）
  - RT_SUCC **无条件**消费 [buf+0x80] 推进光标（不分 fontid）——宽度参数总是生效
  - 合成器按 **4B/行** 读 WORKBUF；画布=16bpp 位图（**非 VRAM tile**），
    ER 自定义 UI（设置页等）走此路径；对话文本仍走原版 tile 路径
  - 窗口结构：[r4+8]=X、[r4+9]=Y、[r4+0x14]低4位=fontid、[r4+0x20]=前字宽
  - 描述符（合成器入参 r0）：[+4]=上下文索引、[+8]=X、[+9]=Y、[+0x24]=缓冲指针
- **★2:1 亚采样定论（小字体不可行）**：合成器=固定 2:1 水平亚采样——16px 源码流
  渲染 8px + 亚像素抗锯齿。**8px 窄字源 = 笔画<采样窗 → 点阵化不可读**（实验矩阵：
  原序/列主序/半tile×8/宽度8/居中布局全失败）。真·小尺寸文本 = 需重写合成器标量
  （~600 指令状态机），投入/收益比不成立。可行替代 = 同尺寸细笔画（视觉更轻盈，
  结构与全字体一致保证兼容）或 bar 文案缩短
- **★widget 路径分离**：同屏不同 widget 可走不同渲染路径——实证：列表标签的小字
  码流渲染正常、底部 bar 同码流乱码（bar 独立解码假设未逆向：descriptor 变换
  [r0+0x24] 缓冲、双 pass 语义、137 次/帧多 pass 调用粒度均未定）。"同屏=同路径"
  假设不可靠（踩坑 46）
- **取证方法**（详见踩坑 42-47）：blit 快照仪（改返回地址字面量）、Y 分流双暂存区、
  16bpp@480B/行 灰度渲染、直方图自校 stride。工具：tmp/bmp2png.js、tmp/dis.js

### 红龙传说（西语蓝宝石改版，✅"新的游戏"上屏；实录 cases/红龙传说-西语蓝宝石移植/README.md）
- 非美版布局（各区域平移量不同：文本区 +0x134、战斗区 +0x324），必须逐函数重映射
  （pokesapphire_de.sym 恰好与本 ROM 一致）
- trace 定位法（最可靠）：已知串地址 → 代码块 → hook 触发 → 逐指令 trace 8 万步，
  用字形值序列匹配函数地址（双证据）
- 地址映射：GetGlyphWidth=0x08004A1C、GetStringWidth=0x08004D00、DrawGlyphTiles=0x080069A8、
  DrawGlyphTile_ShadowedFont=0x080057B4、CpuSet=0x081ED6EC；字库改放 0x09200000/0x09300000
- ⚠ 西语与 pokeRS 方案冲突（RS charmap 0x01-0x1E 全是重音字母）——不保西语则无需处理

### FRLG（火红）
- 参考 `../../../../gui_related/font_patch.py`（跳板签名 3068037801303060 同源）
- 函数入口见 `pokeRS/include/OriginSymbols_R.s`

### Pokemon 窗口结构体（r0 指向）
```
[0x01] fontNum 0/3=普通字库 1/2/4/5=小字库   [0x02] language
[0x0E] spacing     [0x1E] textIndex(u16)     [0x20] *text 文本缓冲指针
```
EliteRedux 窗口：+0=currChar 指针、+0x14=fontId（低 4 位）、+0x21=字体变体标志；
画布描述符（合成器入参 r0）：+4=上下文索引、+8=X、+9=Y、+0x24=缓冲指针

### 汉字码合成（hook 解码用）
```
修正: glyph 0x01-05→-1 | 0x07-1A→-2 | 0x1C-1E→-3 | 0x06/0x1B→0
charId = ((glyph - 修正) << 8) | text[textIndex]   # 0x0100-0x1FF6 即汉字
```

---

## 五、资源与相关文件（路径均相对本目录）

**自带脚本（scripts/）**：bmp-ascii.js（像素校验）、disasm-offline.js、trace-after-hook.js、
watch-read.js（监视读取定位消费者）、patch-elite-redux-2651.js（v6 槽位注入）；
文本翻译/回填工具见 ../gba-text-translate/scripts/。

**取证工具（gbajs2/tmp/，2026-09-07 新增）**：bmp2png.js（BMP→PNG 灰度转换，
内存取证渲染必备）、dis.js（无头反汇编 CLI）。

**自带资源（assets/）**：gba_chs_font_11x11.bin（中文字模）、wholewords.txt（码表）、
charmap_rs.txt（RS 家族 charmap；0x01-0x1E 重音字母区）、
symbols/pokesapphire{,_de}.sym（蓝宝石符号表；非美版先对照 de 版重映射）

**小字体研究留档（未完成，勿直接使用）**：fontpatch/armips-src/graphics/fonts/small_fonts.bin
（15198 条居中 8x8 版）、translation-er/tmp/make-small-font.js（生成器 v3）、
translation-er/tmp/bmp2png.js、translation-er/tmp/dis.js。
结论见 §四-画布引擎（2:1 亚采样定论）。

**外部文件（相对 gbajs2/ 根）**：romctl.js、js/thumb-disassembler.js、
fontpatch/ELITEREDUX-STATUS.md、docs/memview开发经验与调试记录.md、
docs/技术报告-mGBA-vs-gbajs2核心差异-EliteRedux转场卡死.md、
../fonts/绿宝石字库.bin、../roms/、../testfiles/
