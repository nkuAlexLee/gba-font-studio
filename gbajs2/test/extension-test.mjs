/**
 * 扩展加载测试：用全局安装的 pi SDK 验证 .pi/extensions/gba-fontpatch.ts
 * 能被发现并注册全部 rom / pipeline / font / text 四组工具。
 * 用法: node test/extension-test.mjs
 */
import { createAgentSession, SessionManager } from "file:///C:/Users/nkualexlee/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(here, "..");

const EXPECTED = [
	"rom_status", "rom_load", "rom_run", "rom_key", "rom_screenshot", "rom_memread",
	"rom_memwrite", "rom_disasm", "rom_hookadd", "rom_hookevents", "rom_snap",
	"pipeline_stage", "pipeline_status", "pipeline_report",
	"font_charmap_query", "font_glyph_render",
	"text_validate", "text_insert",
];

let failures = 0;
const check = (name, cond, extra) => {
	console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  — " + extra : ""));
	if (!cond) failures++;
};

try {
	const { session, diagnostics } = await createAgentSession({
		cwd,
		agentDir: path.join(process.env.HOME || process.env.USERPROFILE, ".pi", "agent"),
		sessionManager: SessionManager.inMemory(cwd),
	});
	await session.bindExtensions({});
	const toolNames = session.getAllTools().map((t) => t.name);
	for (const name of EXPECTED) check("工具 " + name, toolNames.includes(name));
	const missing = EXPECTED.filter((n) => !toolNames.includes(n));
	check("全部 18 个域工具注册", missing.length === 0, missing.length ? "缺失: " + missing.join(",") : "");
	const extErrs = (diagnostics?.extensions?.errors) || [];
	check("扩展无加载错误", extErrs.length === 0, extErrs.map((e) => String(e.message || e)).join("; ").slice(0, 500));
	session.dispose();
} catch (e) {
	console.error("FATAL", e);
	failures++;
}

process.exit(failures ? 1 : 0);
