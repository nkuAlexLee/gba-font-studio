/**
 * Studio 集成测试：起 romctl serve（临时端口）→ 依次验证新增端点与共享解码器。
 * 用法: node test/studio-test.mjs
 * 依赖: roms/ 下有 ROM（取第一个 .gba）；不修改任何工程数据（审校回写用临时工程）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PORT = 8651;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, cond, extra) => {
	console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  — " + extra : ""));
	if (!cond) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitServe(timeoutMs = 30000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		try {
			const r = await fetch(BASE + "/status");
			if (r.ok) return await r.json();
		} catch { /* not up yet */ }
		await sleep(400);
	}
	throw new Error("serve 未在期限内就绪");
}
async function jget(p) {
	const r = await fetch(BASE + p);
	const j = await r.json().catch(() => ({}));
	return { status: r.status, j };
}

/* ---------- 0. 字模解码器（共享 js/glyph-format.js） ---------- */
const glyphMod = await import(
	new URL("file:///" + path.join(ROOT, "js", "glyph-format.js").replace(/\\/g, "/")).href
);
const GlyphFormat = glyphMod.default ?? glyphMod;
const fontBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, ".pi", "skills", "gba-font-crack", "assets", "gba_chs_font_11x11.bin")));
check("字库大小 = 6763 字模 × 16B", fontBytes.length === 6763 * 16, String(fontBytes.length));
{
	// fixHi 修正语义：0x01..0x05 → -1；0x07..0x1A → -2；0x1C..0x1E → -3；0x06/0x1B 报错
	check("fixHi(0x01)=0", GlyphFormat.fixHi(0x01) === 0);
	check("fixHi(0x07)=5", GlyphFormat.fixHi(0x07) === 5);
	check("fixHi(0x1C)=0x19", GlyphFormat.fixHi(0x1c) === 0x19);
	let threw = false;
	try { GlyphFormat.fixHi(0x06); } catch { threw = true; }
	check("fixHi(0x06) 抛错（控制字节）", threw);
	// 解码非空字形（码表中第一个汉字码位应有墨迹）
	const g = GlyphFormat.decodeGlyph(fontBytes, 0x0100);
	const ink = g.data.reduce((a, b) => a + b, 0);
	check("码 0x0100 字形有墨迹", ink > 10, `ink=${ink}`);
	// 全零槽位 → 全空
	const empty = GlyphFormat.decodeGlyph(fontBytes, 0x1ff0);
	check("末尾槽位解码不越界", empty.data.length === 121);
}

/* ---------- 1. 起 serve ---------- */
console.log("— 启动 romctl serve :" + PORT);
const serve = spawn(process.execPath, [path.join(ROOT, "romctl.js"), "serve", String(PORT)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
serve.stdout.on("data", () => {});
serve.stderr.on("data", (d) => console.error("[serve stderr]", String(d).slice(0, 200)));
try {
	await waitServe();
	check("serve 启动", true);

	/* ---------- 2. 加载 ROM + 状态 ---------- */
	const roms = fs.readdirSync(path.join(ROOT, "roms")).filter((f) => f.endsWith(".gba") && !f.includes("backup"));
	const rom = path.join(ROOT, "roms", roms[0]);
	const load = await jget("/load?rom=" + encodeURIComponent(rom));
	check("/load", load.j.ok === true, load.j.rom ? path.basename(load.j.rom) : JSON.stringify(load.j).slice(0, 120));
	const run = await jget("/run?frames=10");
	check("/run 10 帧推进", run.j.ok && run.j.frames >= 10, "frames=" + run.j.frames);

	/* ---------- 3. PNG 截图 ---------- */
	const shot = await fetch(BASE + "/shot.png?frames=1");
	const shotBuf = Buffer.from(await shot.arrayBuffer());
	check("/shot.png 返回 PNG 签名", shot.ok && shotBuf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
	// IHDR 尺寸 = 240x160
	const w = shotBuf.readUInt32BE(16), h = shotBuf.readUInt32BE(20);
	check("PNG 尺寸 240x160", w === 240 && h === 160, `${w}x${h}`);
	// IDAT 可解压
	const idatIdx = shotBuf.indexOf(Buffer.from("IDAT"));
	const idatLen = shotBuf.readUInt32BE(idatIdx - 4);
	const raw = zlib.inflateSync(shotBuf.subarray(idatIdx + 4, idatIdx + 4 + idatLen));
	check("IDAT 解压尺寸 = (240*3+1)*160", raw.length === (240 * 3 + 1) * 160, String(raw.length));

	/* ---------- 4. 流水线端点 ---------- */
	const pipe = await jget("/pipeline");
	check("/pipeline 返回 seed 数据", pipe.j.ok && Array.isArray(pipe.j.pipeline?.stages) && pipe.j.pipeline.stages.length >= 8,
		pipe.j.pipeline ? `${pipe.j.pipeline.stages.length} 阶段` : JSON.stringify(pipe.j).slice(0, 120));
	const work = await jget("/work");
	check("/work 列出产物", work.j.ok && work.j.files.some((f) => f.name === "pipeline.json"));

	/* ---------- 5. tmpfile 安全访问 ---------- */
	fs.writeFileSync(path.join(ROOT, "tmp", "studio-test.txt"), "hello");
	const tf = await fetch(BASE + "/tmpfile?name=studio-test.txt");
	check("/tmpfile 读取 tmp 文件", tf.ok && (await tf.text()) === "hello");
	const tfBad = await fetch(BASE + "/tmpfile?name=..%2FAGENTS.md");
	check("/tmpfile 拒绝路径穿越", !tfBad.ok || tfBad.status === 500, "status=" + tfBad.status);

	/* ---------- 6. 会话列表与解析 ---------- */
	const sess = await jget("/sessions");
	check("/sessions 列表", sess.j.ok && Array.isArray(sess.j.sessions));
	if (sess.j.sessions.length) {
		const s1 = await jget("/pisession?file=" + encodeURIComponent(sess.j.sessions[0].file));
		check("/session 解析条目", s1.j.ok && s1.j.entries.length > 0, `${s1.j.entries?.length} 条`);
		const hasMsg = s1.j.entries.some((e) => e.kind === "message");
		check("会话含 message 条目", hasMsg);
		const sessBad = await fetch(BASE + "/pisession?file=..%2F..%2Fpackage.json");
		check("/session 拒绝路径穿越", sessBad.status === 500);
	} else {
		check("/sessions 列表（空目录跳过深检）", true);
	}

	/* ---------- 7. 审校读/写回环（临时工程，不动 translation-er） ---------- */
	const testProj = path.join(ROOT, "tmp", "review-test-project");
	fs.mkdirSync(path.join(testProj, "strings"), { recursive: true });
	fs.writeFileSync(path.join(testProj, "project.json"), JSON.stringify({ name: "test", rom: "roms/pker.gba", out_rom: "out/x.gba" }));
	fs.writeFileSync(path.join(testProj, "strings", "main.csv"),
		"\uFEFFid,addr_gba,scene,context,max_bytes,max_chars,en,mt,final,status,notes\r\n" +
		"00AA0001,0x8AA0001,main,,21,10,Hello world,你好,,machine-translated,\r\n" +
		"00AA0002,0x8AA0002,main,,9,4,PokéNav,宝可梦导航,,machine-translated,\r\n");
	const rv = await jget("/review?project=" + encodeURIComponent(path.relative(ROOT, testProj)));
	check("/review 读临时工程", rv.j.ok && rv.j.scenes.main && rv.j.scenes.main.total === 2, JSON.stringify(rv.j.scenes?.main?.counts || {}));
	const rvPost = await fetch(BASE + "/review", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ project: path.relative(ROOT, testProj), scene: "main", updates: [{ id: "00aa0001", final: "你好世界", status: "human-reviewed" }] }),
	});
	const rvPostJ = await rvPost.json();
	check("/review POST 回写", rvPostJ.ok && rvPostJ.applied === 1);
	const rvVerify = await jget("/review?project=" + encodeURIComponent(path.relative(ROOT, testProj)));
	const row1 = rvVerify.j.scenes.main.rows.find((r) => r.id === "00AA0001");
	check("回写落盘 final+status", row1.final === "你好世界" && row1.status === "human-reviewed", JSON.stringify(row1));
	// 工程名白名单
	const rvBad = await fetch(BASE + "/review?project=" + encodeURIComponent("../translation-er"));
	check("/review 拒绝 '..' 工程名", rvBad.status === 500);

	/* ---------- 9. /browse 目录浏览（ROM 加载对话框数据源） ---------- */
	const br = await jget("/browse");
	check("/browse 列盘符/根", br.j.ok && Array.isArray(br.j.entries) && br.j.entries.length > 0,
		br.j.entries?.slice(0, 3).map((e) => e.name).join(","));
	const romsDir = path.join(ROOT, "roms");
	const br2 = await jget("/browse?dir=" + encodeURIComponent(romsDir));
	const gbaCount = (br2.j.entries || []).filter((e) => e.type === "gba").length;
	check("/browse 列出 roms 下 .gba 文件", br2.j.ok && gbaCount > 0, gbaCount + " 个 ROM");
	check("/browse 提供 parent 回退", br2.j.parent !== null && br2.j.parent !== undefined, br2.j.parent);
	const brBad = await fetch(BASE + "/browse?dir=" + encodeURIComponent("D:/__nonexistent_dir_xyz__"));
	check("/browse 拒绝不存在目录", brBad.status === 500);

	/* ---------- 10. /workfile ---------- */
	fs.writeFileSync(path.join(ROOT, "work", "studio-test.md"), "# t");
	const wf = await fetch(BASE + "/workfile?name=studio-test.md");
	check("/workfile 读取 work 文件", wf.ok && (await wf.text()) === "# t");

	/* ---------- 11. /insert 后台任务（临时工程 dry-run，快速验证任务链） ---------- */
	fs.writeFileSync(path.join(testProj, "project.json"), JSON.stringify({ name: "test", rom: path.join(ROOT, "roms", "pker.gba"), out_rom: "out/x.gba" }));
	const ins = await fetch(BASE + "/insert", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ project: path.relative(ROOT, testProj), dryRun: true }),
	});
	const insJ = await ins.json();
	check("/insert 启动后台任务", insJ.ok && typeof insJ.pid === "number", JSON.stringify(insJ).slice(0, 100));
	await sleep(4000); // 等 spawn 的 insert-strings.js 退出并写日志
	const insLog = fs.existsSync(path.join(ROOT, "work", "insert-latest.log"))
		? fs.readFileSync(path.join(ROOT, "work", "insert-latest.log"), "utf8") : "";
	check("/insert 产生日志（含退出码）", insLog.length > 0 && /\[exit \d+\]/.test(insLog), insLog.split("\n").slice(-2).join(" | ").slice(0, 120));
} catch (e) {
	console.error("FATAL:", e);
	failures++;
} finally {
	serve.kill();
	await sleep(300);
	try { fs.rmSync(path.join(ROOT, "tmp", "review-test-project"), { recursive: true, force: true }); } catch { /* ignore */ }
	try { fs.rmSync(path.join(ROOT, "work", "studio-test.md"), { force: true }); } catch { /* ignore */ }
	try { fs.rmSync(path.join(ROOT, "tmp", "studio-test.txt"), { force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
