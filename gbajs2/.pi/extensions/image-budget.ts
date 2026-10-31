/**
 * image-budget — 请求期图片预算守门（pi 扩展，通用，不依赖 GBA 领域）
 *
 * 背景（2026-10-02 实机定位）：上游火山方舟网关对单次请求体有 ~64 MiB 硬限，
 * 超限直接返回 `413 {"code":"EntryTooBig","message":"Entry too big"...}`，整轮失败且
 * 重试必失败。典型触发：会话里累积几百张 inline base64 截图，实测
 * `544 msgs, inbound=65.7MiB, outbound=64.9MiB` → 413（≤63.3MiB 的请求全部成功）。
 *
 * pi 自身只限制**单张**图（dist/utils/image-resize-core.js：2000px / 4.5MB base64），
 * 不限制总量；GBA 扩展的 GBA_IMAGE_KEEP 只按**张数**虚拟化，几张 4K 原图仍能顶穿
 * 字节上限。本扩展补这一层总量守门。
 *
 * 策略（代价从低到高，够用即停）：
 *   1. 估算本轮请求字节（图片 base64 + 文本/工具参数）；未超预算 → 原样放行（零成本）。
 *   2. 图片张数 > maxCount → 丢弃最旧的（最新 keep 张受保护）。
 *   3. 仍超预算 → 用 sharp 把最大的可压缩图缩到 ≤ shrinkMaxKb（默认 JPEG，
 *      带 alpha 保持 PNG），按节约量从大到小直到进入预算。
 *   4. 仍超预算 → 最旧的图替换为文本占位（会话文件仍保留原图，同 GBA 虚拟化思路）。
 * 压缩结果按内容哈希缓存（不逐轮重复编码）；只有真的动手才写日志。
 *
 * 配置（推荐写在 pi 的 settings.json）：全局 <agentDir>/settings.json 与项目
 * <cwd>/.pi/settings.json 的 `extensionSettings["image-budget"]` 段，项目级字段级覆盖全局：
 *   {
 *     "extensionSettings": {
 *       "image-budget": {
 *         "off": false,            // 关闭本扩展
 *         "mib": 48,               // 请求体预算（MiB）
 *         "keep": 6,               // 最新 N 张图永不改动
 *         "maxCount": 30,          // 张数上限（0=不限；渠道有 30 图硬限）
 *         "shrink": true,          // false=关闭压缩，超预算直接丢最旧
 *         "shrinkMaxEdge": 1280,   // 压缩后最长边
 *         "shrinkMaxKb": 256,      // 单图压缩目标 KB
 *         "shrinkQuality": 70,     // JPEG 起始质量 1-100
 *         "debug": false
 *       }
 *     }
 *   }
 *   优先级：env（显式设置时覆盖）> settings.json > 内置默认。
 *   环境变量名：PI_IMAGE_BUDGET_OFF / _MIB / _DEBUG / _LOG，PI_IMAGE_KEEP /
 *              _MAX_COUNT / _SHRINK / _SHRINK_MAX_EDGE / _SHRINK_MAX_KB / _SHRINK_QUALITY。
 *   logPath 可选：省略=默认 <agentDir>/logs/image-budget.log；空串=不写日志（env 同理）。
 *
 * 命令：/image-budget  显示当前配置与最近一次请求的处理结果
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MIB = 1024 * 1024;

/* ---------------- 配置 ---------------- */

export interface BudgetConfig {
	off: boolean;
	budget: number;
	keep: number;
	maxCount: number;
	shrink: boolean;
	shrinkEdge: number;
	shrinkKb: number;
	shrinkQuality: number;
	logPath: string;
	debug: boolean;
}

function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env && env.trim()) return env;
	return path.join(os.homedir(), ".pi", "agent");
}

/* ---------------- settings.json 配置源 ---------------- */

export const EXT_KEY = "image-budget";

type Json = Record<string, unknown>;

function readJsonObject(file: string): Json {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
	} catch {
		return {};
	}
}

/** 扩展配置段：全局 <agentDir>/settings.json → 项目 <cwd>/.pi/settings.json 字段级覆盖 */
export function jsonSettings(cwd: string, name: string = EXT_KEY): Json {
	const pick = (file: string): Json => {
		const all = readJsonObject(file)["extensionSettings"];
		if (!all || typeof all !== "object" || Array.isArray(all)) return {};
		const section = (all as Json)[name];
		return section && typeof section === "object" && !Array.isArray(section) ? (section as Json) : {};
	};
	return {
		...pick(path.join(agentDir(), "settings.json")),
		...pick(path.join(cwd || process.cwd(), ".pi", "settings.json")),
	};
}

/* 取值优先级：env（显式设置时覆盖）> settings.json > 内置默认 */

/** 数字 */
function nOf(env: string | undefined, j: Json, key: string, dflt: number): number {
	if (env !== undefined && env.trim() !== "") {
		const v = Number(env);
		if (Number.isFinite(v)) return v;
	}
	const v = j[key];
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return dflt;
}

/** 布尔：给 "0"/"false"/false 即关闭（用于默认开的开关） */
function bOf(env: string | undefined, j: Json, key: string, dflt: boolean): boolean {
	if (env !== undefined) return env !== "0" && env !== "false";
	const v = j[key];
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v !== "0" && v !== "false";
	return dflt;
}

/** 布尔：只有 "1"/"true"/true 才算开（用于默认关的开关，如 off/debug） */
function tOf(env: string | undefined, j: Json, key: string, dflt: boolean): boolean {
	if (env !== undefined) return env === "1" || env === "true";
	const v = j[key];
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v === "1" || v === "true";
	return dflt;
}

/** 路径：省略=默认路径，显式空串=关闭（与 env 语义一致） */
function pathOf(env: string | undefined, j: Json, key: string, dflt: string): string {
	if (env !== undefined) return env === "" ? "" : env;
	const v = j[key];
	if (typeof v === "string") return v === "" ? "" : v;
	return dflt;
}

/** 当前生效的 env 覆盖（仅用于 /image-budget status 提示） */
const ENV_KEYS = [
	"PI_IMAGE_BUDGET_OFF",
	"PI_IMAGE_BUDGET_MIB",
	"PI_IMAGE_KEEP",
	"PI_IMAGE_MAX_COUNT",
	"PI_IMAGE_SHRINK",
	"PI_IMAGE_SHRINK_MAX_EDGE",
	"PI_IMAGE_SHRINK_MAX_KB",
	"PI_IMAGE_SHRINK_QUALITY",
	"PI_IMAGE_BUDGET_LOG",
	"PI_IMAGE_BUDGET_DEBUG",
];

function activeEnvKeys(): string[] {
	return ENV_KEYS.filter((k) => process.env[k] !== undefined);
}

export function readConfig(cwd: string = process.cwd()): BudgetConfig {
	const j = jsonSettings(cwd);
	return {
		off: tOf(process.env.PI_IMAGE_BUDGET_OFF, j, "off", false),
		budget: Math.max(1, nOf(process.env.PI_IMAGE_BUDGET_MIB, j, "mib", 48)) * MIB,
		keep: Math.max(1, Math.floor(nOf(process.env.PI_IMAGE_KEEP, j, "keep", 6))),
		maxCount: Math.max(0, Math.floor(nOf(process.env.PI_IMAGE_MAX_COUNT, j, "maxCount", 30))),
		shrink: bOf(process.env.PI_IMAGE_SHRINK, j, "shrink", true),
		shrinkEdge: Math.floor(Math.max(1, nOf(process.env.PI_IMAGE_SHRINK_MAX_EDGE, j, "shrinkMaxEdge", 1280))),
		shrinkKb: Math.floor(Math.max(1, nOf(process.env.PI_IMAGE_SHRINK_MAX_KB, j, "shrinkMaxKb", 256))),
		shrinkQuality: Math.min(95, Math.max(20, Math.floor(nOf(process.env.PI_IMAGE_SHRINK_QUALITY, j, "shrinkQuality", 70)))),
		logPath: pathOf(process.env.PI_IMAGE_BUDGET_LOG, j, "logPath", path.join(agentDir(), "logs", "image-budget.log")),
		debug: tOf(process.env.PI_IMAGE_BUDGET_DEBUG, j, "debug", false),
	};
}

/* ---------------- 纯逻辑（可单测） ---------------- */

export interface Slot {
	msgIndex: number;
	blockIndex: number;
	content: unknown[];
	block: Record<string, unknown>;
	/** 直接承载 base64 的对象（可能是 block 本体，也可能是 block.source） */
	holder: { data: string };
	/** mimeType/mediaType 所在对象与键名 */
	mimeHolder: Record<string, unknown> | null;
	mimeKey: string;
	base64: string;
	mimeType: string;
	bytes: number;
}

/** 按时间顺序（旧→新）收集所有 inline 图片块；两种 pi 块形态都兼容 */
export function collectImages(messages: unknown[]): Slot[] {
	const out: Slot[] = [];
	for (let mi = 0; mi < messages.length; mi++) {
		const content = (messages[mi] as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) continue;
		for (let bi = 0; bi < content.length; bi++) {
			const block = content[bi] as Record<string, unknown> | undefined;
			if (!block || block.type !== "image") continue;
			const source = block.source as Record<string, unknown> | undefined;
			let holder: { data: string } | null = null;
			let mimeHolder: Record<string, unknown> | null = null;
			let mimeKey = "mimeType";
			if (source && typeof source.data === "string") {
				holder = source as { data: string };
				mimeHolder = source;
				mimeKey = typeof source.mediaType === "string" ? "mediaType" : "mimeType";
			} else if (typeof block.data === "string") {
				holder = block as { data: string };
				mimeHolder = block;
			}
			if (!holder) continue;
			const rawMime = (source?.mediaType ?? block.mimeType ?? "image/png") as unknown;
			out.push({
				msgIndex: mi,
				blockIndex: bi,
				content,
				block,
				holder,
				mimeHolder,
				mimeKey,
				base64: holder.data,
				mimeType: typeof rawMime === "string" ? rawMime : "image/png",
				bytes: holder.data.length,
			});
		}
	}
	return out;
}

/** 非图片内容字节数（文本 + 工具调用参数）；图片 base64 由调用方另计 */
export function textBytes(messages: unknown[]): number {
	let n = 0;
	for (const m of messages) {
		const content = (m as { content?: unknown } | undefined)?.content;
		if (typeof content === "string") {
			n += Buffer.byteLength(content, "utf8");
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const b of content) {
			const block = b as { type?: string; text?: string; arguments?: unknown };
			if (block?.type === "text" && typeof block.text === "string") {
				n += Buffer.byteLength(block.text, "utf8");
			} else if (block?.type === "toolCall" && block.arguments !== undefined) {
				try {
					n += Buffer.byteLength(JSON.stringify(block.arguments), "utf8");
				} catch {
					n += 1024;
				}
			}
		}
	}
	return n;
}

export interface PlanInput {
	/** 各图当前 base64 字节数，时间顺序（旧→新） */
	sizes: number[];
	/** 压缩后的目标字节数估计（>= sizes[i] 视为不可压缩） */
	shrinkTo: number[];
	/** 非图片内容字节数 */
	otherBytes: number;
	budget: number;
	/** 最新 N 张不动（保底） */
	keep: number;
	/** 张数上限，0 = 不限 */
	maxCount: number;
}

export interface Plan {
	/** 建议压缩的下标（从最大的可压缩图开始） */
	shrink: number[];
	/** 建议丢弃（替换为文本占位）的下标，最旧的优先 */
	drop: number[];
	/** 按估算得到的请求体字节数（可能仍 > budget：没有可动的图了） */
	estBytes: number;
}

/**
 * 预算规划：张数上限 → 压缩最大的（受保护图除外）→ 丢最旧的。
 * 纯函数，便于单测；真实压缩结果可能偏差，调用方需用实际尺寸再压实一次。
 */
export function planImageBudget(input: PlanInput): Plan {
	const { sizes, shrinkTo, otherBytes, budget, keep, maxCount } = input;
	const n = sizes.length;
	const protectedFrom = Math.max(0, n - Math.max(0, keep));
	let est = otherBytes + sizes.reduce((a, b) => a + b, 0);
	const shrink: number[] = [];
	const drop: number[] = [];
	const handled = new Set<number>();

	// A. 张数上限：先丢最旧的非保护图，极端情况才动保护图
	if (maxCount > 0 && n > maxCount) {
		let must = n - maxCount;
		for (let i = 0; i < n && must > 0; i++) {
			if (i >= protectedFrom || handled.has(i)) continue;
			drop.push(i);
			handled.add(i);
			est -= sizes[i];
			must--;
		}
		for (let i = 0; i < n && must > 0; i++) {
			if (handled.has(i)) continue;
			drop.push(i);
			handled.add(i);
			est -= sizes[i];
			must--;
		}
	}

	// B. 字节预算：压缩收益最大的非保护图（每次只处理一张，循环到进入预算）
	while (est > budget) {
		let best = -1;
		for (let i = 0; i < protectedFrom; i++) {
			if (handled.has(i)) continue;
			if (!(shrinkTo[i] < sizes[i])) continue;
			if (best < 0 || sizes[i] > sizes[best]) best = i;
		}
		if (best < 0) break;
		shrink.push(best);
		handled.add(best);
		est -= sizes[best] - shrinkTo[best];
	}

	// C. 仍超预算：从最旧开始丢（含保护图，最后手段）
	for (let i = 0; i < n && est > budget; i++) {
		if (handled.has(i)) continue;
		drop.push(i);
		handled.add(i);
		est -= sizes[i];
	}

	return { shrink, drop, estBytes: Math.max(0, est) };
}

/* ---------------- 图片压缩（sharp，缺失则降级为丢弃） ---------------- */

interface ShrinkResult {
	data: string;
	mimeType: string;
	bytes: number;
}

interface SharpLike {
	(input: Buffer, options?: Record<string, unknown>): {
		rotate(): SharpLikeInstance;
		metadata(): Promise<Record<string, unknown>>;
	};
}

interface SharpLikeInstance {
	resize(options: Record<string, unknown>): SharpLikeInstance;
	jpeg(options: Record<string, unknown>): SharpLikeInstance;
	png(options: Record<string, unknown>): SharpLikeInstance;
	metadata(): Promise<Record<string, unknown>>;
	toBuffer(): Promise<Buffer>;
}

let sharpState: { mod: unknown; tried: boolean } = { mod: null, tried: false };
const shrinkCache = new Map<string, ShrinkResult>();
const SHRINK_CACHE_MAX = 400;

async function loadSharp(): Promise<SharpLike | null> {
	if (sharpState.tried) return sharpState.mod as SharpLike | null;
	sharpState.tried = true;
	const dir = agentDir();
	const candidates = [
		path.join(dir, "npm", "node_modules", "sharp"), // billion-context 的 optionalDependencies
		path.join(dir, "node_modules", "sharp"),
	];
	try {
		const mod = (await import("sharp")) as { default?: unknown };
		sharpState.mod = mod.default ?? mod;
	} catch {
		/* 从 agent 目录裸导入通常失败，下面用绝对路径兜底 */
	}
	if (!sharpState.mod) {
		for (const c of candidates) {
			try {
				const req = createRequire(path.join(dir, "image-budget-resolve.cjs"));
				sharpState.mod = req(c);
				break;
			} catch {
				/* 试下一个候选 */
			}
		}
	}
	return sharpState.mod as SharpLike | null;
}

/** 压缩单图；返回 null 表示压不动/无收益（调用方应改为丢弃） */
export async function shrinkImage(base64: string, mimeType: string, cfg: BudgetConfig): Promise<ShrinkResult | null> {
	const key = `${crypto.createHash("sha1").update(base64).digest("hex")}:${cfg.shrinkEdge}:${cfg.shrinkKb}:${cfg.shrinkQuality}`;
	const cached = shrinkCache.get(key);
	if (cached) return cached;

	const sharp = await loadSharp();
	if (!sharp) return null;
	try {
		const input = Buffer.from(base64, "base64");
		const meta = (await (sharp(input, { failOn: "none" }) as unknown as SharpLikeInstance).metadata()) || {};
		const hasAlpha = meta.hasAlpha === true;
		const target = cfg.shrinkKb * 1024;
		let edge = cfg.shrinkEdge;
		for (let attempt = 0; attempt < 3; attempt++) {
			const pipeline = (sharp(input, { failOn: "none" }) as unknown as SharpLikeInstance)
				.rotate()
				.resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
			const buf = hasAlpha
				? await pipeline.png({ compressionLevel: 9, palette: true }).toBuffer()
				: await pipeline.jpeg({ quality: Math.max(35, cfg.shrinkQuality - attempt * 15), mozjpeg: true }).toBuffer();
			const data = buf.toString("base64");
			if (data.length >= base64.length) return null; // 没省下来 → 交给丢弃逻辑
			if (data.length <= target || attempt === 2) {
				const res: ShrinkResult = { data, mimeType: hasAlpha ? "image/png" : "image/jpeg", bytes: data.length };
				if (shrinkCache.size >= SHRINK_CACHE_MAX) shrinkCache.clear();
				shrinkCache.set(key, res);
				return res;
			}
			edge = Math.max(320, Math.floor(edge * 0.75));
		}
	} catch {
		return null;
	}
	return null;
}

/* ---------------- 占位文本 ---------------- */

function nearbyPath(content: unknown[]): string | undefined {
	for (const b of content) {
		const block = b as { type?: string; text?: string } | undefined;
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		const m = block.text.match(/[^\s"'<>]+\.(?:png|bmp|jpe?g|webp|gif)/i);
		if (m) return m[0];
	}
	return undefined;
}

export function placeholderText(slot: Slot): string {
	const p = nearbyPath(slot.content);
	const where = p ? `→ ${p}；` : "";
	return `[旧截图已按图片预算省略（会话文件仍保留原图）${where}agent 当时已直接查看并分析]`;
}

/* ---------------- 扩展主体 ---------------- */

interface Stats {
	requests: number;
	pruned: number;
	lastBefore: number;
	lastAfter: number;
	lastShrunk: number;
	lastDropped: number;
	notified: boolean;
	lastError: string;
}

const fmt = (n: number) => `${(n / MIB).toFixed(1)}MiB`;

export default function imageBudget(pi: ExtensionAPI): void {
	const stats: Stats = { requests: 0, pruned: 0, lastBefore: 0, lastAfter: 0, lastShrunk: 0, lastDropped: 0, notified: false, lastError: "" };

	function log(cfg: BudgetConfig, text: string): void {
		if (!cfg.logPath) return;
		try {
			fs.mkdirSync(path.dirname(cfg.logPath), { recursive: true });
			fs.appendFileSync(cfg.logPath, `${new Date().toISOString()} [image-budget] ${text}\n`);
		} catch {
			/* 日志失败不影响主流程 */
		}
	}

	function reset(): void {
		stats.lastBefore = 0;
		stats.lastAfter = 0;
		stats.lastShrunk = 0;
		stats.lastDropped = 0;
		stats.notified = false;
	}

	try {
		pi.on("session_start", async () => reset());
		pi.on("session_compact", async () => reset());
	} catch {
		/* 老版本 pi 没有这些事件：忽略 */
	}

	pi.on("context", async (ev, ctx) => {
		try {
			const cfg = readConfig(cwdOf(ctx));
			if (cfg.off) return undefined;
			const messages = (ev as unknown as { messages?: unknown })?.messages;
			if (!Array.isArray(messages) || messages.length === 0) return undefined;

			const slots = collectImages(messages);
			if (slots.length === 0) return undefined;

			const otherBytes = textBytes(messages);
			let total = otherBytes + slots.reduce((n, s) => n + s.bytes, 0);
			const overCount = cfg.maxCount > 0 && slots.length > cfg.maxCount;
			if (total <= cfg.budget && !overCount) return undefined;

			stats.requests++;
			stats.lastBefore = total;

			const plan = planImageBudget({
				sizes: slots.map((s) => s.bytes),
				shrinkTo: slots.map((s) => (cfg.shrink ? Math.min(s.bytes, cfg.shrinkKb * 1024) : s.bytes)),
				otherBytes,
				budget: cfg.budget,
				keep: cfg.keep,
				maxCount: cfg.maxCount,
			});

			const dropped = new Set<number>(plan.drop);
			const shrunkIdx = new Set<number>(plan.shrink);
			let shrunk = 0;

			for (const i of plan.shrink) {
				const res = await shrinkImage(slots[i].base64, slots[i].mimeType, cfg);
				if (res && res.bytes < slots[i].bytes) {
					slots[i].holder.data = res.data;
					slots[i].base64 = res.data;
					slots[i].bytes = res.bytes;
					slots[i].mimeType = res.mimeType;
					if (slots[i].mimeHolder) slots[i].mimeHolder[slots[i].mimeKey] = res.mimeType;
					shrunk++;
				} else {
					shrunkIdx.delete(i);
					dropped.add(i); // 压不动 → 退回丢弃，保证能进预算
				}
			}

			// 用真实尺寸压实（估算偏差 / 压缩失败兜底）：先丢没压过的（省得最多），再从最旧开始丢
			let real = otherBytes;
			for (let i = 0; i < slots.length; i++) if (!dropped.has(i)) real += slots[i].bytes;
			for (const preferUnshrunk of [true, false]) {
				for (let i = 0; i < slots.length && real > cfg.budget; i++) {
					if (dropped.has(i)) continue;
					if (preferUnshrunk === shrunkIdx.has(i)) continue; // 第一轮跳过已压缩的（别白花 CPU）
					dropped.add(i);
					shrunkIdx.delete(i);
					real -= slots[i].bytes;
				}
			}

			for (const i of dropped) {
				const slot = slots[i];
				slot.content[slot.blockIndex] = { type: "text", text: placeholderText(slot) };
			}

			total = real;
			stats.pruned++;
			stats.lastAfter = total;
			stats.lastShrunk = shrunk;
			stats.lastDropped = dropped.size;

			const line = `sess=${safeSessionId(ctx)} images=${slots.length} ${fmt(stats.lastBefore)} → ${fmt(total)} | shrunk=${shrunk} dropped=${dropped.size} (budget=${fmt(cfg.budget)})`;
			if (cfg.debug || dropped.size > 0) log(cfg, line);

			if (ctx?.ui && !stats.notified && dropped.size > 0) {
				stats.notified = true;
				try {
					ctx.ui.notify(`图片预算守门：本轮省略 ${dropped.size} 张旧截图（${fmt(stats.lastBefore)} → ${fmt(total)}，上游 64MiB 硬限）。会话文件仍保留原图，需要时可重新读取。`, "info");
				} catch {
					/* UI 不可用则跳过 */
				}
			}

			return { messages };
		} catch (err) {
			// 任何异常都放行原始消息（宁可 413 也不能弄坏上下文）
			try {
				const cfg = readConfig(cwdOf(ctx));
				stats.lastError = err instanceof Error ? err.message : String(err);
				log(cfg, `ERROR ${stats.lastError}`);
			} catch {
				/* ignore */
			}
			return undefined;
		}
	});

	try {
		pi.registerCommand("image-budget", {
			description: "显示图片预算守门配置与最近一次请求的处理结果",
			handler: async (_args: unknown, ctx: ExtensionContext) => {
				const cfg = readConfig(cwdOf(ctx));
				const parts = [
					`开关=${cfg.off ? "off" : "on"}`,
					`预算=${fmt(cfg.budget)}`,
					`保留最新=${cfg.keep}`,
					`张数上限=${cfg.maxCount || "不限"}`,
					`压缩=${cfg.shrink ? `${cfg.shrinkEdge}px/${cfg.shrinkKb}KB/q${cfg.shrinkQuality}` : "off"}`,
					`最近请求=${stats.requests} 次（${fmt(stats.lastBefore)} → ${fmt(stats.lastAfter)}，压缩 ${stats.lastShrunk} 张，省略 ${stats.lastDropped} 张）`,
					`配置=${Object.keys(jsonSettings(cwdOf(ctx))).length ? "extensionSettings 已设" : "extensionSettings 未设（用内置默认）"}${activeEnvKeys().length ? `，env 覆盖 ${activeEnvKeys().join(",")}` : ""}`,
					`日志=${cfg.logPath || "off"}`,
				];
				if (stats.lastError) parts.push(`最近错误=${stats.lastError}`);
				try {
					ctx?.ui?.notify(parts.join(" | "), "info");
				} catch {
					/* ignore */
				}
			},
		});
	} catch {
		/* 命令注册失败不影响守门 */
	}
}

function cwdOf(ctx: ExtensionContext | undefined): string {
	try {
		const cwd = ctx?.cwd;
		return typeof cwd === "string" && cwd ? cwd : process.cwd();
	} catch {
		return process.cwd();
	}
}

function safeSessionId(ctx: ExtensionContext | undefined): string {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? id.slice(0, 8) : "-";
	} catch {
		return "-";
	}
}
