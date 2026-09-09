/**
 * 工具级执行测试：通过 pi SDK（createAgentSession + getToolDefinition）
 * 真实调用 gba-fontpatch 扩展工具的 execute，验证行为。
 * 用法: node test/tool-exec-test.mjs
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createAgentSession, SessionManager } from "file:///C:/Users/nkualexlee/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

let failures = 0;
const check = (name, cond, extra) => {
	console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  — " + String(extra).slice(0, 160) : ""));
	if (!cond) failures++;
};

const cwd = ROOT;
const { session } = await createAgentSession({
	cwd,
	agentDir: path.join(os.homedir(), ".pi", "agent"),
	sessionManager: SessionManager.inMemory(cwd),
});
await session.bindExtensions({});
const getTool = (name) => {
	const t = session.getToolDefinition(name);
	if (!t) throw new Error("工具未注册: " + name);
	return t;
};
const names = ["rom_status", "rom_load", "rom_run", "rom_key", "rom_screenshot", "rom_memread", "rom_memwrite", "rom_disasm", "rom_hookadd", "rom_hookevents", "rom_snap", "pipeline_stage", "pipeline_status", "pipeline_report", "font_charmap_query", "font_glyph_render", "text_validate", "text_insert"];
check("18 个工具均可取到定义", names.every((n) => !!session.getToolDefinition(n)));

async function callTool(name, params) {
	return getTool(name).execute("test", params, undefined, undefined, { hasUI: false, ui: { setWidget() { } } });
}
const firstText = (r) => r.content.find((c) => c.type === "text")?.text || "";

/* 1. pipeline_stage → work/pipeline.json 落盘 */
{
	const r = await callTool("pipeline_stage", { id: "engine", name: "定位渲染引擎", status: "done", evidence: ["tmp/probe.png"], notes: "测试" });
	check("pipeline_stage 执行成功", !r.isError, firstText(r));
	const p = JSON.parse(fs.readFileSync(path.join(ROOT, "work", "pipeline.json"), "utf8"));
	const st = p.stages.find((s) => s.id === "engine");
	check("pipeline.json 落盘 stage", st && st.status === "done" && st.evidence.includes("tmp/probe.png"));
	const r2 = await callTool("pipeline_status", {});
	check("pipeline_status 可读回", !r2.isError && firstText(r2).includes("engine"), firstText(r2).split("\n")[1]);
	const r3 = await callTool("pipeline_report", {});
	check("pipeline_report 生成文件", !r3.isError && firstText(r3).includes("work/report-"), firstText(r3).split("\n")[0]);
}

/* 2. font_charmap_query / font_glyph_render */
{
	const r = await callTool("font_charmap_query", { query: "皮卡" });
	check("charmap 按字查询命中皮卡", firstText(r).includes("皮"), firstText(r).split("\n")[1]);
	const r2 = await callTool("font_charmap_query", { query: "0100" });
	check("charmap 按码前缀查询", !r2.isError && firstText(r2).includes("0x0100"), firstText(r2).split("\n")[1]);
	const r3 = await callTool("font_glyph_render", { chars: "草电" });
	const imgs = r3.content.filter((c) => c.type === "image");
	check("glyph_render 返回 2 张 PNG", imgs.length === 2, `${imgs.length} 张`);
	const pngSig = (b64) => Buffer.from(b64, "base64").subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	check("字模 PNG 签名有效", imgs.every((i) => pngSig(i.data)));
	const r4 = await callTool("font_glyph_render", { chars: "\uE000" });
	check("glyph_render 未收录字符不崩溃", r4.isError || firstText(r4).includes("未找到"), firstText(r4).slice(0, 80));
}

/* 3. rom_status（serve 未运行时走 CLI info 降级） */
{
	const r = await callTool("rom_status", {});
	check("rom_status 可执行（无 serve 时降级）", !r.isError && firstText(r).length > 0, firstText(r).slice(0, 80));
}

/* 4. text_validate 对临时工程 */
{
	const proj = path.join(ROOT, "tmp", "tool-test-project");
	fs.rmSync(proj, { recursive: true, force: true });
	fs.mkdirSync(path.join(proj, "strings"), { recursive: true });
	fs.writeFileSync(path.join(proj, "project.json"), JSON.stringify({ name: "t", rom: path.join(ROOT, "roms", "pker.gba"), out_rom: "out/x.gba", charmap: path.join(ROOT, ".pi", "skills", "gba-text-translate", "assets", "charmap-base.txt") }));
	fs.writeFileSync(path.join(proj, "strings", "s.csv"),
		"\uFEFFid,addr_gba,scene,context,max_bytes,max_chars,en,mt,final,status,notes\r\n" +
		"00BB0001,0x8BB0001,s,,30,10,Hello,你好,,machine-translated,\r\n");
	const r = await callTool("text_validate", { project: "tmp/tool-test-project" });
	check("text_validate 可执行并输出统计", !r.isError && (firstText(r).includes("machine-translated") || firstText(r).includes("状态") || firstText(r).includes("untranslated")), firstText(r).split("\n").slice(0, 2).join(" | ").slice(0, 150));
	fs.rmSync(proj, { recursive: true, force: true });
}

/* 恢复 pipeline seed（测试写入了 engine=done） */
fs.writeFileSync(path.join(ROOT, "work", "pipeline.json"), JSON.stringify({
	rom: "", base: "", updated: "",
	stages: ["engine", "font", "charmap", "export", "translate", "layout", "insert", "verify"].map((id) => ({ id, status: "pending" })),
}, null, "\t"));
// 清理测试生成的报告
for (const f of fs.readdirSync(path.join(ROOT, "work"))) if (/^report-\d+\.md$/.test(f)) fs.rmSync(path.join(ROOT, "work", f));

session.dispose();
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
