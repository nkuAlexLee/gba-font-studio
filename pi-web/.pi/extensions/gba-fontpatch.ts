/**
 * gba-fontpatch — GBA 字库处理与翻译领域工具集（pi 扩展）
 *
 * 把 romctl.js（无头调试引擎）与 gba-text-translate skill 脚本包装成结构化工具，
 * 并通过 work/pipeline.json + pi.appendEntry("gba.event") 驱动 Studio 可视化：
 *   - rom_*        模拟器操作（serve HTTP 优先，CLI 兜底）
 *   - pipeline_*   流水线阶段记录（Studio 流水线看板数据源）
 *   - font_*       码表查询与字模渲染（字模以 PNG 图片返回，模型可"看"字）
 *   - text_*       翻译工程校验与回填（gba-text-translate skill 脚本）
 *
 * 配套可视化: http://127.0.0.1:8645/studio/index.html （romctl serve 提供）
 * 设计文档:   docs/GBA字库Agent可视化设计方案.md
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const zlib = require("node:zlib") as typeof import("node:zlib");

/* ---------------- 路径与常量 ---------------- */
// 兼容 jiti/tsx/编译产物三种加载方式下的 __dirname 解析
const here: string = (typeof import.meta !== "undefined" && (import.meta as { dirname?: string }).dirname)
	|| (typeof __dirname !== "undefined" ? __dirname : process.cwd());
// .pi/extensions/gba-fontpatch.ts → 仓库根 = ../../；引擎与数据在 ROOT/gba（自包含）
const ROOT = path.resolve(here, "..", "..");
// 引擎目录回退链：工作区副本 → 遗留仓库根 → 客户端安装布局（payload/gba）→ 开发兄弟目录
function firstExisting(...paths: string[]): string {
	for (const p of paths) if (p && fs.existsSync(p)) return p;
	return paths[paths.length - 1] ?? "";
}

function resolveEngineDir(): string {
	const candidates = [
		path.join(ROOT, "gba"),
		ROOT, // 遗留仓库布局（romctl.js 在仓库根）
		process.env.PI_CODING_AGENT_DIR ? path.resolve(process.env.PI_CODING_AGENT_DIR, "..", "..", "payload", "gba") : "",
		path.resolve(ROOT, "..", "pi-web", "gba"),
	];
	for (const c of candidates) if (c && fs.existsSync(path.join(c, "romctl.js"))) return path.resolve(c);
	return path.join(ROOT, "gba");
}
const BASE = resolveEngineDir();
const ROMCTL = path.join(BASE, "romctl.js");
const WORK_DIR = path.join(BASE, "work");
const TMP_DIR = path.join(BASE, "tmp");
const PIPELINE_FILE = path.join(WORK_DIR, "pipeline.json");
const CHARMAP_TXT = firstExisting(path.join(BASE, "assets", "wholewords.txt"), path.join(ROOT, ".pi", "skills", "gba-font-crack", "assets", "wholewords.txt"));
const FONT_BIN = firstExisting(path.join(BASE, "assets", "gba_chs_font_11x11.bin"), path.join(ROOT, ".pi", "skills", "gba-font-crack", "assets", "gba_chs_font_11x11.bin"));

/* ---------------- PNG 编码（与 romctl.js 同实现，无依赖） ---------------- */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
	return t;
})();
function pngChunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	let crc = 0xffffffff;
	for (const b of body) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
	return Buffer.concat([len, body, crcBuf]);
}
/** gray 值 0=白 1=墨 2=影 的点阵 → PNG（scale 放大 + 1px 网格线） */
function encodeGridPNG(grid: Uint8Array, w: number, h: number, scale: number): Buffer {
	const W = w * scale + 1, H = h * scale + 1; // +1 画外框网格
	const px = Buffer.alloc(W * H * 3, 0xff);
	const put = (x: number, y: number, r: number, g: number, b: number) => {
		const i = (y * W + x) * 3;
		px[i] = r; px[i + 1] = g; px[i + 2] = b;
	};
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const v = grid[y * w + x];
			for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
				const px0 = x * scale + sx + 1, py0 = y * scale + sy + 1;
				if (v === 1) put(px0, py0, 0x10, 0x10, 0x10);       // 墨
				else if (v === 2) put(px0, py0, 0xb0, 0xb0, 0xb0);  // 影
			}
		}
	}
	// 网格线（浅灰，每 scale 像素一条）
	for (let x = 0; x <= W - 1; x += scale) for (let y = 0; y < H; y++) put(x, y, 0xd8, 0xd8, 0xe8);
	for (let y = 0; y <= H - 1; y += scale) for (let x = 0; x < W; x++) put(x, y, 0xd8, 0xd8, 0xe8);
	// 编码 RGB
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
	ihdr[8] = 8; ihdr[9] = 2;
	const stride = W * 3;
	const raw = Buffer.alloc((stride + 1) * H);
	for (let y = 0; y < H; y++) {
		raw[y * (stride + 1)] = 0;
		px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })), pngChunk("IEND", Buffer.alloc(0))]);
}

/* ---------------- 字模解码（移植自 skill 的 patch-xtreme-chs.js glyph11，pokeE 官方索引） ---------------- */
function fixHi(hi: number): number {
	if (hi >= 0x01 && hi <= 0x05) return hi - 1;
	if (hi >= 0x07 && hi <= 0x1a) return hi - 2;
	if (hi >= 0x1c && hi <= 0x1e) return hi - 3;
	if (hi === 0x06 || hi === 0x1b) throw new Error("码表码含控制字节 0x" + hi.toString(16));
	return hi;
}
/** 11x11 点阵：16B/字，每行 11bit MSB first；返回 w*h Uint8Array（1=墨 0=空） */
function glyph11(fontBuf: Buffer, code: number): Uint8Array {
	const id = ((fixHi(code >> 8) * 0xf7 + (code & 0xff)) >>> 0) * 16;
	const off = new Uint8Array(16);
	for (let i = 0; i < 16; i++) off[i] = fontBuf[id + i] ?? 0;
	const g = new Uint8Array(11 * 11);
	for (let r = 0; r < 11; r++) {
		for (let c = 0; c < 11; c++) {
			const bit = (r * 11 + c);
			g[r * 11 + c] = (off[bit >> 3] >> (7 - (bit & 7))) & 1;
		}
	}
	return g;
}

/* ---------------- 码表 ---------------- */
type CharmapEntry = { code: number; hex: string; value: string };
let charmapCache: CharmapEntry[] | null = null;
function loadCharmap(): CharmapEntry[] {
	if (charmapCache) return charmapCache;
	const out: CharmapEntry[] = [];
	for (const line of fs.readFileSync(CHARMAP_TXT, "utf8").split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("/") || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq <= 0) continue;
		const hex = t.slice(0, eq).trim().toLowerCase();
		if (!/^[0-9a-f]{1,4}$/.test(hex)) continue;
		out.push({ code: parseInt(hex, 16), hex, value: t.slice(eq + 1) });
	}
	charmapCache = out;
	return out;
}

/* ---------------- romctl 调用（serve HTTP 优先，CLI 兜底） ---------------- */
type ServeLock = { port: number; pid: number; time: number };
function serveLock(): ServeLock | null {
	try {
		const f = path.join(TMP_DIR, "serve.lock");
		if (!fs.existsSync(f)) return null;
		const lock = JSON.parse(fs.readFileSync(f, "utf8")) as ServeLock;
		return lock?.port ? lock : null;
	} catch { return null; }
}
async function serveGet(port: number, apiPath: string, timeoutMs = 60000): Promise<{ status: number; body: Buffer; contentType: string }> {
	const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, { signal: AbortSignal.timeout(timeoutMs) });
	const buf = Buffer.from(await res.arrayBuffer());
	return { status: res.status, body: buf, contentType: res.headers.get("content-type") || "" };
}
function cliRomctl(args: string[], timeoutMs = 300000): { ok: boolean; output: string } {
	const r = spawnSync(process.execPath, [ROMCTL, ...args], { cwd: BASE, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
	const output = ((r.stdout || "") + (r.stderr ? "\n[stderr] " + r.stderr : "")).trim();
	return { ok: r.status === 0, output: output.length > 12000 ? output.slice(0, 12000) + "…[截]" : output };
}
/** 只读查询：serve 在且可用 → HTTP；否则 CLI（读落盘快照，最多滞后） */
async function queryRomctl(apiPath: string, cliArgs: string[], timeoutMs = 300000): Promise<string> {
	const lock = serveLock();
	if (lock) {
		try {
			const r = await serveGet(lock.port, apiPath, 15000);
			if (r.status === 200) return r.body.toString("utf8");
		} catch { /* serve 无响应 → 降级 CLI 只读 */ }
	}
	return cliRomctl(cliArgs, timeoutMs).output;
}
/** 变更命令：无 serve → CLI；有 serve → 必须 HTTP（CLI 与 serve 双写者冲突，锁文件但无响应时报错） */
async function commandRomctl(apiPath: string, cliArgs: string[], timeoutMs = 300000): Promise<string> {
	const lock = serveLock();
	if (lock) {
		const r = await serveGet(lock.port, apiPath, 120000).catch((e) => {
			throw new Error(`serve :${lock.port} 正在运行但无响应（${e instanceof Error ? e.message : e}）。请先恢复/关闭 serve，避免双写者冲突。`);
		});
		if (r.status !== 200) throw new Error("serve 返回 " + r.status + ": " + r.body.toString("utf8").slice(0, 300));
		return r.body.toString("utf8");
	}
	return cliRomctl(cliArgs, timeoutMs).output;
}

/* ---------------- 流水线 ---------------- */
type Stage = { id: string; name?: string; status?: string; progress?: number; evidence?: string[]; notes?: string; updated?: string; entryId?: string };
type Pipeline = { rom?: string; base?: string; updated?: string; stages: Stage[] };
function loadPipeline(pfile: string): Pipeline {
	try { return JSON.parse(fs.readFileSync(pfile, "utf8")) as Pipeline; } catch { return { stages: [] }; }
	try { return JSON.parse(fs.readFileSync(PIPELINE_FILE, "utf8")) as Pipeline; } catch { return { stages: [] }; }
}
function savePipeline(p: Pipeline, pfile: string) {
	fs.mkdirSync(path.dirname(pfile), { recursive: true });
	fs.mkdirSync(WORK_DIR, { recursive: true });
	p.updated = new Date().toISOString();
	fs.writeFileSync(pfile, JSON.stringify(p, null, "	"));
}
/** 运行时数据根：agent 工作目录（客户端=安装路径 data/workspace；开发态=仓库根） */
const workDir = (ctx?: ExtensionContext): string => (ctx?.cwd ? path.resolve(ctx.cwd) : BASE);
const pipelineFile = (ctx?: ExtensionContext): string => path.join(workDir(ctx), "work", "pipeline.json");

/* ---------------- 会话图片预算 ----------------
 * 渠道（如 Console Go 中转）对单次请求的图片数有硬上限（典型 30），超限整个请求 400:
 * "Too many images in request: 31 > 30"。截图/字模等工具结果里的图会永久留在会话历史，
 * 截图循环极易撞限。pi 的自动 compaction 按 token 阈值触发（大窗口模型下远晚于图片上限），
 * 兜不住 —— 所以在扩展层计数，接近上限时降级为「存盘路径+画面摘要」并提示 /compact。
 * 计数以会话文件为准（覆盖内置 read 等其它图片来源；compaction 后按 firstKeptEntryId 重算，
 * 进程重启仍准确）；读不到会话文件（无 PI_SESSION_FILE）时退化为本进程兜底计数。 */
const IMAGE_LIMIT = Math.max(6, parseInt(process.env.GBA_IMAGE_LIMIT || "30", 10) || 30);
const IMAGE_BUDGET = Math.max(2, parseInt(process.env.GBA_IMAGE_BUDGET || "25", 10) || 25);
const IMAGE_SOFT = Math.max(1, Math.min(IMAGE_BUDGET - 1, 5));
const AUTO_COMPACT_AT = Math.max(0, parseInt(process.env.GBA_IMAGE_AUTOCOMPACT || "20", 10) || 20); // 图片数达到此值自动触发 compaction；0=关闭
const IMAGE_KEEP = Math.min(24, Math.max(1, parseInt(process.env.GBA_IMAGE_KEEP || "4", 10) || 4)); // 请求时保留最近几张“活图”，其余虚拟化为文本
const IMG_MARK = '"type":"image"';
let imgScanCache: { size: number; mtime: number; count: number } | null = null;
let imagesEmittedHere = 0;
function pngSize(buf: Buffer): { w: number; h: number } | null {
	if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
	return null;
}
function countContextImages(ctx?: ExtensionContext): number {
	// 首选：内存中的上下文条目（权威、免文件 I/O、天然 compaction 感知；
	// 客户端 agent 进程 env 没有 PI_SESSION_FILE，之前靠它计数会在恢复重会话时失明）
	try {
		const entries = ctx?.sessionManager?.buildContextEntries?.();
		if (entries && entries.length) {
			let n = 0;
			for (const e of entries) {
				const s = JSON.stringify(e);
				if (!s) continue;
				for (let i = s.indexOf(IMG_MARK); i !== -1; i = s.indexOf(IMG_MARK, i + 1)) n++;
			}
			return n;
		}
	} catch { /* fallthrough */ }
	// 次选：会话文件扫描
	const f = process.env.PI_SESSION_FILE || "";
	if (f && fs.existsSync(f)) {
		try {
			const st = fs.statSync(f);
			if (imgScanCache && imgScanCache.size === st.size && imgScanCache.mtime === st.mtimeMs) return imgScanCache.count;
			const buf = fs.readFileSync(f, "latin1");
			let start = 0;
			const c = buf.lastIndexOf('"type":"compaction"');
			if (c >= 0) {
				// compaction 后旧图已不在上下文：从 firstKeptEntryId 对应条目起算；
				// 解析/定位失败则从头数（宁可多算提前降级，不可少算撞 400）
				const ls = buf.lastIndexOf("\n", c) + 1;
				const le = buf.indexOf("\n", c);
				let keptId = "";
				try { keptId = (JSON.parse(buf.slice(ls, le === -1 ? undefined : le)) as { firstKeptEntryId?: string }).firstKeptEntryId || ""; } catch { /* keptId 为空 → 从头数 */ }
				if (keptId) {
					const k = buf.indexOf('"id":"' + keptId + '"');
					if (k >= 0) start = k;
				}
			}
			let n = 0;
			for (let i = buf.indexOf(IMG_MARK, start); i !== -1; i = buf.indexOf(IMG_MARK, i + IMG_MARK.length)) n++;
			imgScanCache = { size: st.size, mtime: st.mtimeMs, count: n };
			return n;
		} catch { /* 读不到 → 兜底 */ }
	}
	return imagesEmittedHere;
}
let autoCompactPending = false; // compaction 进行中不再重复触发（完成/失败事件复位）
let virtOk = false; // 请求时虚拟化是否已生效（context 事件至少成功跑过一次）
/** 图片数达阈值时自动触发 compaction——代替仅提示 agent 手动 /compact；
 *  恢复已超限的会话时同样自愈（ctx.compact() 异步执行，不阻塞本工具结果） */
function maybeAutoCompact(count: number, ctx?: ExtensionContext): string {
	if (!AUTO_COMPACT_AT || autoCompactPending || count < AUTO_COMPACT_AT) return "";
	if (typeof ctx?.compact !== "function") return "";
	try {
		ctx.compact();
		autoCompactPending = true;
		return "已自动触发 /compact —— 旧截图将折叠为摘要，配额在完成后释放。";
	} catch { return ""; }
}
/** 计划再附 adding 张图时的预算判定；over=true 时调用方必须停止附图 */
function imageBudget(adding: number, ctx?: ExtensionContext): { over: boolean; warn: boolean; count: number; note: string } {
	const count = countContextImages(ctx);
	const after = count + adding;
	if (virtOk) {
		// 请求时旧图已被虚拟化替换：实际发送图数恒 ≤ IMAGE_KEEP，渠道 30 图上限不会触发
		return { over: false, warn: false, count: Math.min(after, IMAGE_KEEP), note: "" };
	}
	const stat = `图片预算 ${count}→${after}/${IMAGE_LIMIT}（降级阈值 ${IMAGE_BUDGET}）`;
	const auto = maybeAutoCompact(after, ctx);
	if (after > IMAGE_BUDGET) {
		const how = auto || "请先执行 /compact 把旧截图折叠为摘要、释放配额后再重新获取。";
		return { over: true, warn: true, count, note: `⚠ ${stat} — 已停止附图（渠道对单请求图片数有硬上限，超限整个请求会被拒 400）。${how}⚠ 本张图片已存盘但不要用 read 打开——read 会把图拉回上下文，继续超限；需要画面信息时先用画面摘要（尺寸/与上张差异）判断。` };
	}
	if (count + adding >= IMAGE_BUDGET - IMAGE_SOFT) return { over: false, warn: true, count, note: `⚠ ${stat} — 接近上限。${auto || "建议本轮验证结束后 /compact。"}` };
	return { over: false, warn: false, count, note: "" };
}

/* ---------------- 扩展主体 ---------------- */
export default function gbaFontpatch(pi: ExtensionAPI) {
	let lastWidgetLines: string[] = [];
	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const p = loadPipeline(pipelineFile(ctx));
		const cur = p.stages.find((s) => s.status === "running");
		const done = p.stages.filter((s) => s.status === "done").length;
		const lock = serveLock();
		lastWidgetLines = [
			`GBA 流水线: ${p.stages.length ? `${done}/${p.stages.length} 完成` : "未初始化"}${cur ? ` | 当前: ${cur.name || cur.id}` : ""}`,
			`模拟器: ${lock ? `serve :${lock.port}` : "serve 未运行"}${p.rom ? ` | ROM: ${path.basename(p.rom)}` : ""}`,
		];
		ctx.ui.setWidget("gba-fontpatch", lastWidgetLines);
	};
	const event = (data: Record<string, unknown>) => { try { pi.appendEntry("gba.event", data); } catch { /* 无会话时忽略 */ } };

	pi.on("session_start", async (_ev, ctx) => { imgScanCache = null; updateWidget(ctx); });
	// compaction 后旧图退出上下文：清扫描缓存与兜底计数，下次重新统计
	try { pi.on("session_compact", async () => { imagesEmittedHere = 0; imgScanCache = null; autoCompactPending = false; }); } catch { /* 旧版本无此事件 */ }
	try { pi.on("session_compact_failed", async () => { autoCompactPending = false; }); } catch { /* 事件不存在时忽略 */ }

	/* ---- 请求时图片虚拟化：会话历史保留原图，仅发送最近 IMAGE_KEEP 张，其余替换为文本注记。
	 *     渠道 30 图上限从此不触发（配额与 token 双省）；Studio 看板/回放不受影响；
	 *     失败则原样发送，由预算降级/自动 compact 兑底。---- */
	pi.on("context", async (ev) => {
		try {
			const msgs = (ev as { messages?: unknown[] }).messages || [];
			let seen = 0, replaced = 0;
			for (let mi = msgs.length - 1; mi >= 0; mi--) {
				const content = (msgs[mi] as { content?: unknown } | undefined)?.content;
				if (!Array.isArray(content)) continue;
				for (let bi = content.length - 1; bi >= 0; bi--) {
					const block = content[bi] as { type?: string } | undefined;
					if (!block || block.type !== "image") continue;
					seen++;
					if (seen <= IMAGE_KEEP) continue; // 保留最近几张活图
					let path = "";
					for (const b of content as Array<{ type?: string; text?: string }>) {
						if (b?.type === "text" && b.text) {
							const m = b.text.match(/[^\s"'<>]+\.(?:png|bmp|jpg|jpeg)/i);
							if (m) { path = m[0]; break; }
						}
					}
					content[bi] = { type: "text", text: path
						? `[旧截图已省略（会话历史仍保留原图）→ ${path}；agent 当时已直接查看并分析]`
						: `[旧截图已省略（会话历史仍保留原图；agent 当时已直接查看并分析）]` };
					replaced++;
				}
			}
			virtOk = true;
			if (replaced) return { messages: msgs };
		} catch { /* 虚拟化失败 → 原样发送，预算降级/自动 compact 兑底 */ }
	});
	let lastShot: { file: string; buf: Buffer } | null = null;

	const text = (s: string) => [{ type: "text" as const, text: s }];
	const fail = (e: unknown) => ({ content: text(`✘ ${e instanceof Error ? e.message : String(e)}`), isError: true as const, details: {} });

	/* ========== rom_* 模拟器工具 ========== */

	pi.registerTool(defineTool({
		name: "rom_status",
		label: "模拟器状态",
		description: "查询模拟器当前状态与身份：当前加载的 ROM 路径/帧数/PC/hook/serve 端口，以及与流水线记录 ROM 的一致性检查和后续工具建议。任何模拟器操作前先调用本工具确认身份。",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			try {
				const out = await queryRomctl("/status", ["info"]);
				// 解析 serve JSON 提炼关键身份信息；CLI 输出则原样附上
				let rom = "", frames = "", hooks = "", port = "";
				try {
					const j = JSON.parse(out);
					rom = j.rom || ""; frames = String(j.frames ?? "");
					hooks = Array.isArray(j.hooks) ? j.hooks.map((h) => h.name).join(",") : "";
					port = String(serveLock()?.port ?? "");
				} catch { /* CLI 文本输出，不做结构化解析 */ }
				const lines = [];
				if (rom) {
					lines.push(`当前 ROM: ${rom}`);
					const p = loadPipeline(pipelineFile(ctx));
					if (p.rom && path.resolve(p.rom) !== path.resolve(rom)) {
						lines.push(`⚠ 流水线记录的 ROM 与当前不一致：pipeline.json=${p.rom}`);
						lines.push("  如确要切换分析对象，用 rom_load 加载后 pipeline 会自动更新；否则以当前 ROM 为准。");
					}
				}
				else lines.push("当前未加载 ROM（用 rom_load 加载，或工作台顶栏「📂 打开 ROM」对话框）");
				if (frames) lines.push(`帧数: ${frames}`);
				if (hooks) lines.push(`已装 hook: ${hooks}`);
				if (port) lines.push(`serve: :${port}（Agent 工具与 Studio 面板共用）`);
				lines.push("", "后续工具建议:");
				lines.push("- 看画面/拿证据: rom_screenshot（返回图片，可直接看）");
				lines.push("- 定位渲染函数: rom_disasm（配 skill 的符号表）；挂 hook: rom_hookadd preset:rs / preset:emerald");
				lines.push("- 捕获字符: rom_hookevents；实验前后: rom_snap save/load；查内存: rom_memread");
				lines.push("- 里程碑: pipeline_stage（每完成一步必须记录+证据）；字模验证: font_glyph_render");
				updateWidget(ctx);
				return { content: text(lines.join("\n") + (rom ? "" : "\n原始输出: " + out)), details: { rom, frames, hooks } };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "rom_load",
		label: "加载 ROM",
		description: "向模拟器加载指定 ROM 并重置状态与 hook。ROM 路径相对 gba/roms（如 roms/xxx.gba）或绝对路径。重分析新 ROM 时使用。Studio「打开 ROM」对话框选择的任意位置 ROM 也可用绝对路径加载。",
		parameters: Type.Object({
			rom: Type.String({ description: "ROM 路径，相对仓库根，如 roms/PokemonQuetzalAlpha7v0.gba" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const abs = path.resolve(workDir(ctx), params.rom);
				if (!fs.existsSync(abs)) throw new Error("ROM 不存在: " + abs);
				const out = await commandRomctl("/load?rom=" + encodeURIComponent(abs), ["load", abs]);
				const p = loadPipeline(pipelineFile(ctx));
				p.rom = abs;
				savePipeline(p, pipelineFile(ctx));
				event({ kind: "load", rom: path.basename(abs) });
				updateWidget(ctx);
				return { content: text("ROM 已加载: " + out), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "rom_run",
		label: "运行帧",
		description: "让模拟器运行 N 帧（≤3600）。观察画面/等待动画/推进游戏状态。",
		parameters: Type.Object({ frames: Type.Number({ description: "帧数，默认 60" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const n = Math.max(1, Math.min(params.frames ?? 60, 3600));
				const out = await commandRomctl("/run?frames=" + n, ["run", String(n)]);
				updateWidget(ctx);
				return { content: text("已运行 " + n + " 帧: " + out), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "rom_key",
		label: "按键运行",
		description: "按住按键运行 N 帧后松开（如 START 打开菜单、A 确认）。keys 逗号分隔：A,B,L,R,START,SELECT,UP,DOWN,LEFT,RIGHT",
		parameters: Type.Object({
			keys: Type.Optional(Type.String({ description: "按键，逗号分隔（如 A / START / UP,A）。缺省 = 只跑 frames 帧不按键" })),
			frames: Type.Optional(Type.Number({ description: "按住帧数，默认 60" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const n = Math.max(1, Math.min(params.frames ?? 60, 3600));
				const keys = params.keys || "";
				const out = await commandRomctl("/key?keys=" + encodeURIComponent(keys) + "&frames=" + n, ["key", keys, String(n)]);
				updateWidget(ctx);
				return { content: text(`按键 ${params.keys} × ${n} 帧: ` + out), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "rom_screenshot",
		label: "模拟器截图",
		description: "截图当前画面并返回 PNG 图片（模型可直接看图）。默认先跑 1 帧保证画面新鲜。截图同时存 tmp/ 供 Studio 看板引用，并写入会话事件。会话附图接近渠道上限时自动降级为「存盘路径+画面摘要」并提示 /compact（防 400 Too many images）。",
		parameters: Type.Object({
			frames: Type.Number({ description: "截图前先运行的帧数，默认 1；0 表示不跑帧" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const n = Math.max(0, Math.min(params.frames ?? 1, 3600));
				const lock = serveLock();
				if (!lock) throw new Error("serve 未运行：先运行 `node romctl.js serve`（截图需实时模拟器）");
				const file = "studio-shot-f" + (n === 0 ? "cur" : n) + "-" + Date.now() + ".png";
				const r = await serveGet(lock.port, "/shot.png?frames=" + n + "&file=" + encodeURIComponent(file) + (n === 0 ? "&noframe=1" : ""), 120000).catch((e) => {
					throw new Error(`serve :${lock.port} 正在运行但无响应（${e instanceof Error ? e.message : e}）`);
				});
				if (r.status !== 200) throw new Error(r.body.toString("utf8").slice(0, 300));
				event({ kind: "screenshot", frames: n, file: "tmp/" + file });
				const png = r.body;
				const dim = pngSize(png);
				const dimText = dim ? `${dim.w}x${dim.h}` : `${png.length}B`;
				let diffText = "";
				if (lastShot && lastShot.buf.equals(png)) diffText = "；画面与上张截图完全相同";
				else if (lastShot) diffText = "；画面较上张有变化";
				lastShot = { file, buf: png };
				const budget = imageBudget(1, ctx);
				if (budget.over) {
					// 降级：不附图（超限会连整个请求一起 400），只回存盘路径 + 摘要 + /compact 提示
					return {
						content: text(`截图完成: tmp/${file}（${dimText}${diffText}）\n${budget.note}`),
						details: { file: "tmp/" + file, frames: n, imageCount: budget.count, degraded: true },
					};
				}
				if (!process.env.PI_SESSION_FILE) imagesEmittedHere++;
				return {
					content: [
						{ type: "text", text: `${budget.note ? budget.note + "\n" : ""}截图完成: tmp/${file}（${dimText}${diffText}；可用 rom_status 查看当前帧数）` },
						{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
					],
					details: { file: "tmp/" + file, frames: n, imageCount: budget.count + 1 },
				};
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "rom_memread",
		label: "读内存",
		description: "十六进制查看内存（如 EWRAM 0x02xxxxxx / IWRAM 0x03xxxxxx / ROM 0x08xxxxxx）。",
		parameters: Type.Object({
			addr: Type.String({ description: "地址，如 0x0203F000" }),
			len: Type.Number({ description: "长度字节，默认 64，上限 4096" }),
		}),
		async execute(_id, params) {
			try {
				const out = await queryRomctl(`/memread?addr=${encodeURIComponent(params.addr)}&len=${Math.min(params.len ?? 64, 4096)}`, ["memread", params.addr, String(params.len ?? 64)]);
				return { content: text(out), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "rom_memwrite",
		label: "写内存",
		description: "写内存（十六进制字节串）。用于实验性验证（改标志位/注入字节）。IWRAM/EWRAM 写入直接影响运行状态。",
		parameters: Type.Object({
			addr: Type.String({ description: "地址" }),
			hex: Type.String({ description: "十六进制字节串，如 AABBCC" }),
		}),
		async execute(_id, params) {
			try {
				const out = await commandRomctl(`/memwrite?addr=${encodeURIComponent(params.addr)}&hex=${encodeURIComponent(params.hex)}`, ["memwrite", params.addr, params.hex]);
				event({ kind: "memwrite", addr: params.addr, bytes: params.hex.length / 2 });
				return { content: text(out), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "rom_disasm",
		label: "反汇编",
		description: "反汇编 Thumb/ARM 代码（定位渲染函数、分析 hook 点时用）。",
		parameters: Type.Object({
			addr: Type.String({ description: "地址，如 0x08006876" }),
			n: Type.Number({ description: "指令条数，默认 24" }),
			mode: Type.String({ description: "thumb 或 arm，默认跟随 CPU" }),
		}),
		async execute(_id, params) {
			try {
				const qs = `/disasm?addr=${encodeURIComponent(params.addr)}&n=${Math.min(params.n ?? 24, 500)}${params.mode ? "&mode=" + params.mode : ""}`;
				const out = await queryRomctl(qs, ["disasm", params.addr, String(params.n ?? 24)]);
				return { content: text(out), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "rom_hookadd",
		label: "安装 hook",
		description: "在指定地址安装文本函数 hook（记录每次命中时的寄存器）。也可用内置预设：preset:rs / preset:emerald（GetGlyphWidth/GetStringWidth/DrawGlyphTiles）。",
		parameters: Type.Object({
			addr: Type.Optional(Type.String({ description: "hook 地址，或 preset:rs / preset:emerald" })),
			name: Type.Optional(Type.String({ description: "hook 名称" })),
		}),
		async execute(_id, params) {
			try {
				const a = params.addr || "";
				let out: string;
				const preset = HOOK_PRESETS[a.replace(/^preset:/, "")];
				if (preset) {
					// 预设：逐个函数挂 hook（serve 在跑则走 HTTP，否则 CLI）
					const parts: string[] = [];
					for (const [name, addr] of Object.entries(preset)) {
						parts.push(await commandRomctl(`/hookadd?addr=0x${addr.toString(16)}&name=${encodeURIComponent(name)}`, ["hook", "add", "0x" + addr.toString(16), name]));
					}
					out = parts.join("\n");
				} else {
					out = await commandRomctl(`/hookadd?addr=${encodeURIComponent(a)}&name=${encodeURIComponent(params.name || "")}`, ["hook", "add", a, params.name || ""].filter(Boolean));
				}
				event({ kind: "hookadd", addr: a, name: params.name });
				return { content: text(out), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "rom_hookevents",
		label: "hook 事件",
		description: "查看 hook 命中记录（每次渲染调用：字符码、寄存器等）。分析字符编码/宽度/绘制参数的证据来源。",
		parameters: Type.Object({ tail: Type.Number({ description: "最近 N 条，默认 20" }) }),
		async execute(_id, params) {
			try {
				const out = await queryRomctl(`/hookevents?tail=${Math.min(params.tail ?? 20, 1000)}`, ["hook", "events", "--last", String(params.tail ?? 20)]);
				return { content: text(out), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "rom_snap",
		label: "快照",
		description: "命名快照：save（当前状态）/ load（恢复）/ list / del。换实验前先 save，失败可回滚。",
		parameters: Type.Object({
			op: Type.String({ description: "save | load | list | del" }),
			name: Type.Optional(Type.String({ description: "快照名" })),
		}),
		async execute(_id, params) {
			try {
				const qs = `/snap?op=${encodeURIComponent(params.op)}${params.name ? "&name=" + encodeURIComponent(params.name) : ""}`;
				const out = await commandRomctl(qs, ["snap", params.op, params.name || ""].filter(Boolean));
				return { content: text(out), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	/* ========== pipeline_* 流水线工具 ========== */

	pi.registerTool(defineTool({
		name: "pipeline_stage",
		label: "记录流水线阶段",
		description: "记录/更新流水线阶段状态（Studio 流水线看板数据源）。标准阶段 id：engine(定位渲染引擎)/font(字库整库插入)/charmap(码表构建)/export(文本导出)/translate(翻译)/layout(排版与校验)/insert(回填 ROM)/verify(截图验证)。status: pending/running/done/blocked。每个里程碑必须带 evidence（截图文件、探针输出等）。",
		parameters: Type.Object({
			id: Type.String({ description: "阶段 id，如 engine、translate" }),
			name: Type.Optional(Type.String({ description: "阶段显示名（首次创建时）" })),
			status: Type.String({ description: "pending | running | done | blocked" }),
			progress: Type.Optional(Type.Number({ description: "0-1 进度" })),
			evidence: Type.Optional(Type.Array(Type.String()), { description: "证据列表（截图路径/命令输出摘要）" }),
			notes: Type.Optional(Type.String({ description: "说明" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const p = loadPipeline(pipelineFile(ctx));
				let st = p.stages.find((s) => s.id === params.id);
				if (!st) { st = { id: params.id, name: params.name || params.id }; p.stages.push(st); }
				if (params.name) st.name = params.name;
				st.status = params.status;
				if (params.progress !== undefined) st.progress = params.progress;
				if (params.evidence) st.evidence = [...(st.evidence || []), ...params.evidence];
				if (params.notes) st.notes = params.notes;
				st.updated = new Date().toISOString();
				savePipeline(p, pipelineFile(ctx));
				event({ kind: "stage", id: params.id, name: st.name, status: params.status, progress: params.progress });
				updateWidget(ctx);
				return { content: text(`阶段 ${params.id} → ${params.status} 已记录（共 ${p.stages.length} 个阶段）`), details: { pipeline: p } };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "pipeline_status",
		label: "流水线状态",
		description: "查看当前流水线全部阶段状态（决定下一步做什么时用）。",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			try {
				const p = loadPipeline(pipelineFile(ctx));
				if (!p.stages.length) return { content: text("流水线为空。用 pipeline_stage 记录第一个阶段。"), details: {} };
				const lines = p.stages.map((s) => `- ${s.id}${s.name ? "(" + s.name + ")" : ""}: ${s.status || "pending"}${s.progress !== undefined ? " " + Math.round(s.progress * 100) + "%" : ""}${s.notes ? " — " + s.notes : ""}`);
				return { content: text(`ROM: ${p.rom || "(未设置)"}\n` + lines.join("\n")), details: { pipeline: p } };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "pipeline_report",
		label: "生成项目报告",
		description: "把当前流水线（阶段、证据、会话事件）生成 Markdown 报告到 work/，返回报告路径与摘要。",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			try {
				const p = loadPipeline(pipelineFile(ctx));
				const lines = [
					`# GBA 字库/翻译流水线报告`, ``,
					`- ROM: ${p.rom || "(未设置)"}`,
					`- 生成时间: ${new Date().toISOString()}`, ``,
					`## 阶段`, ``,
					...p.stages.map((s) => `### ${s.id}${s.name ? " · " + s.name : ""} — **${s.status || "pending"}**${s.progress !== undefined ? `（${Math.round(s.progress * 100)}%）` : ""}\n${s.notes ? s.notes + "\n" : ""}${(s.evidence || []).map((e) => `- 证据: ${e}`).join("\n")}`),
				];
				const file = path.join(WORK_DIR, `report-${Date.now()}.md`);
				fs.mkdirSync(WORK_DIR, { recursive: true });
				fs.writeFileSync(file, lines.join("\n"));
				return { content: text(`报告已生成: work/${path.basename(file)}\n\n` + lines.join("\n").slice(0, 3000)), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	/* ========== font_* 字库工具 ========== */

	pi.registerTool(defineTool({
		name: "font_charmap_query",
		label: "码表查询",
		description: "查询码表（wholewords 体系）：按单字查码、按码查字、按十六进制前缀列举。返回 码↔字 映射。",
		parameters: Type.Object({
			query: Type.String({ description: "单个汉字/字符，或十六进制码/前缀（如 4e00 或 0x4e）" }),
			limit: Type.Number({ description: "最多返回条数，默认 20" }),
		}),
		async execute(_id, params) {
			try {
				const cm = loadCharmap();
				const q = params.query.trim().toLowerCase();
				let hits: CharmapEntry[];
				let body: string;
				if (/^(0x)?[0-9a-f]{1,4}$/i.test(q)) {
					// 码/前缀模式 → 列出码位
					const prefix = q.replace(/^0x/i, "");
					hits = cm.filter((e) => e.hex.startsWith(prefix)).slice(0, Math.min(params.limit ?? 20, 100));
					body = hits.map((e) => `0x${e.hex} = ${e.value}`).join("\n");
				} else if ([...params.query.trim()].length > 1) {
					// 多字模式（翻译最常用）：逐字查码，直接给出编码结果
					const lines: string[] = [];
					for (const ch of [...params.query.trim()].slice(0, 50)) {
						const hit = cm.find((e) => e.value === ch);
						lines.push(hit ? `${ch} = 0x${hit.hex}` : `${ch} = (码表未收录)`);
					}
					body = lines.join("\n");
					hits = [];
				} else {
					// 单字/子串模式 → 列出含该字符的条目
					hits = cm.filter((e) => e.value.includes(params.query.trim())).slice(0, Math.min(params.limit ?? 20, 100));
					body = hits.map((e) => `0x${e.hex} = ${e.value}`).join("\n");
				}
				return { content: text(`码表查询（共 ${cm.length} 条）:\n${body || "(无)"}`), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "font_glyph_render",
		label: "渲染字模",
		description: "把字符的字模从 11x11 字库渲染为 PNG 图片返回（模型可直接看字形；用于验证字库注入/码表映射）。一次最多 16 个字符。接近会话图片预算时仅附部分图，其余存盘为路径（/compact 后可用相同参数重渲染）。",
		parameters: Type.Object({
			chars: Type.String({ description: "要渲染的字符（汉字/符号），最多 16 个" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const chars = [...params.chars].slice(0, 16);
				if (!chars.length) throw new Error("chars 为空");
				const cm = loadCharmap();
				const fontBuf = fs.readFileSync(FONT_BIN);
				const budget = imageBudget(chars.length, ctx); // 按计划张数预估（保守：未命中码表的字也会计入）
				const remain = Math.max(0, IMAGE_BUDGET - budget.count);
				fs.mkdirSync(TMP_DIR, { recursive: true });
				const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
				const lines: string[] = [];
				let rendered = 0, attached = 0;
				for (const ch of chars) {
					const entry = cm.find((e) => e.value === ch);
					if (!entry) { lines.push(`${ch}: 码表中未找到`); continue; }
					let png: Buffer;
					try {
						png = encodeGridPNG(glyph11(fontBuf, entry.code), 11, 11, 10);
					} catch (e) {
						lines.push(`${ch} (0x${entry.code.toString(16)}): 字模解码失败 — ${e instanceof Error ? e.message : e}`);
						continue;
					}
					rendered++;
					const gid = `字模 #${(fixHi(entry.code >> 8) * 0xf7 + (entry.code & 0xff)) >>> 0}`;
					const gfile = `glyph-${ch.charCodeAt(0).toString(16)}-${entry.code.toString(16)}.png`;
					fs.writeFileSync(path.join(TMP_DIR, gfile), png);
					if (attached < remain) {
						lines.push(`${ch} → 码 0x${entry.code.toString(16)} → ${gid}`);
						content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
						attached++;
					} else {
						lines.push(`${ch} → 码 0x${entry.code.toString(16)} → ${gid}（图片预算已满，未附图，已存 tmp/${gfile}）`);
					}
				}
				if (!rendered) throw new Error("没有任何字符渲染成功");
				if (!process.env.PI_SESSION_FILE) imagesEmittedHere += attached; // 无会话文件时用兜底计数（有文件时下次扫描自然统计）
				const notes: string[] = [];
				if (budget.note) notes.push(budget.note);
				if (attached < rendered) notes.push(`本次渲染 ${rendered} 字仅附 ${attached} 图（图片预算限制）；未附图已存 tmp/，或执行 /compact 后用相同参数重渲染。`);
				content.unshift({ type: "text", text: `字模渲染（11x11 原始点阵，白=空/黑=墨）:\n${lines.join("\n")}${notes.length ? "\n" + notes.join("\n") : ""}` });
				return { content, details: { imageCount: budget.count + attached, attached, degraded: attached < rendered } };
			} catch (e) { return fail(e); }
		},
	}));

	/* ========== text_* 翻译工程工具 ========== */
	// 底层脚本: .pi/skills/gba-text-translate/scripts/{validate,insert-strings}.js --project <目录>

	const TSCRIPT = (n: string) => firstExisting(path.join(BASE, "scripts", n), path.join(ROOT, ".pi", "skills", "gba-text-translate", "scripts", n));
	const runScript = (script: string, args: string[], timeoutMs = 600000) => {
		const r = spawnSync(process.execPath, [script, ...args], { cwd: BASE, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
		const output = ((r.stdout || "") + (r.stderr ? "\n[stderr] " + r.stderr : "")).trim();
		return { ok: r.status === 0, output: output.length > 12000 ? output.slice(0, 12000) + "…[截]" : output };
	};

// 翻译工程解析：显式指定 → workDir[/projects]/name；未指定 → 自动发现（0/1/多 分支处理）
	function resolveProjectDir(ctx, name) {
		const base = workDir(ctx);
		const bases = [base, path.join(base, "projects")];
		if (name) {
			if (String(name).includes("..") || path.isAbsolute(String(name))) throw new Error("非法工程名: " + name);
			for (const b of bases) {
				const dir = path.join(b, name);
				if (fs.existsSync(path.join(dir, "project.json"))) return dir;
			}
			throw new Error("工程不存在: " + name + "（在 " + base + " 及其 projects/ 下均无；用 gba-text-translate skill 的 export-strings init 创建，工程名与 ROM 绑定由 agent/用户指定）");
		}
		const found = [];
		for (const b of bases) {
			let entries = [];
			try { entries = fs.readdirSync(b, { withFileTypes: true }); } catch { continue; }
			for (const e of entries) {
				if (!e.isDirectory()) continue;
				const dir = path.join(b, e.name);
				if (fs.existsSync(path.join(dir, "project.json")) && !found.includes(dir)) found.push(dir);
			}
		}
		if (found.length === 1) return found[0];
		if (!found.length) throw new Error("尚无翻译工程（在 " + base + " 或其 projects/ 下；用 gba-text-translate skill 的 export-strings init 创建，工程名与 ROM 绑定由 agent/用户指定）");
		throw new Error("存在多个翻译工程，请指定 project 参数：" + found.map((d) => path.basename(d)).join(", "));
	}
	pi.registerTool(defineTool({
		name: "text_validate",
		label: "校验翻译工程",
		description: "运行 gba-text-translate 的 validate：检查译文编码可行性、控制码完整性、超长统计、乱码。回填前必须先通过校验。",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "翻译工程目录名（工作区或其 projects/ 下含 project.json 的目录）。工程与 ROM 绑定；不确定时省略，单工程自动选用，多工程会列出候选" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const dir = resolveProjectDir(ctx, params.project);
				const r = runScript(TSCRIPT("validate.js"), ["--project", dir]);
				return { content: text((r.ok ? "校验完成:\n" : "校验失败:\n") + r.output), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	pi.registerTool(defineTool({
		name: "text_insert",
		label: "回填 ROM",
		description: "运行 insert-strings 回填：原地覆盖或扩容重指向。超长串自动指针扫描。⚠️ 会写 out_rom；先确保已 validate 通过，必要时先备份 ROM。",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "翻译工程目录名。不确定时省略，单工程自动选用，多工程会列出候选" })),
			allowMt: Type.Boolean({ description: "允许 machine-translated 状态导入（true=批量导入未人审译文）" }),
			dryRun: Type.Optional(Type.Boolean({ description: "只演练不写盘，默认 false" })),
			scene: Type.Optional(Type.String({ description: "只处理指定 scene" })),
			only: Type.Optional(Type.String({ description: "只处理指定字符串 ID" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const dir = resolveProjectDir(ctx, params.project);
				const argv = ["--project", dir];
				if (params.allowMt) argv.push("--allow-mt");
				if (params.dryRun) argv.push("--dry-run");
				if (params.scene) argv.push("--scene", params.scene);
				if (params.only) argv.push("--only", params.only);
				const r = runScript(TSCRIPT("insert-strings.js"), argv, 1800000);
				event({ kind: "insert", project: path.basename(dir), dryRun: !!params.dryRun });
				updateWidget(ctx);
				return { content: text((r.ok ? "回填完成:\n" : "回填失败:\n") + r.output), details: {} };
			} catch (e) { return fail(e); }
		},
	}));

	/* 内部常量：hook 预设地址（与 romctl.js PRESETS 保持一致） */
	const HOOK_PRESETS: Record<string, Record<string, number>> = {
		rs: { GetGlyphWidth: 0x080048e8, GetStringWidth: 0x08004bcc, DrawGlyphTiles: 0x08006874 },
		emerald: { GetStringWidth: 0x08005ed8, GetGlyphWidth_Normal: 0x08006908, GetGlyphWidth_Small: 0x08006540, DecompressGlyphTile: 0x08004c10 },
	};
}
