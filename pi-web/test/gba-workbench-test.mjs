/**
 * GBA 工作台浏览器冒烟测试（playwright chromium，headless）：
 * 自起轻量静态服务器（托管 public/gba-studio，模拟 pi-web 部署形态）+
 * romctl serve（gba/ 引擎，跨源 API）→ 五面板逐一切换断言。
 * 用法: node test/gba-workbench-test.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");          // pi-web
const GBA = path.join(ROOT, "gba");             // 自包含引擎目录
const PORT = 8657, STATIC_PORT = 8658;
const BASE = `http://127.0.0.1:${STATIC_PORT}`;
const API = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, cond, extra) => {
	console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  — " + String(extra).slice(0, 120) : ""));
	if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 轻量静态服务器：托管 public/（模拟 pi-web 的 /gba-studio 路径） */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".bin": "application/octet-stream", ".txt": "text/plain; charset=utf-8" };
const staticServer = createServer((req, res) => {
	const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
	const fp = path.join(ROOT, "public", p === "/" ? "/gba-studio/index.html" : p);
	if (!fp.startsWith(path.join(ROOT, "public")) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
		res.writeHead(404); res.end("nf"); return;
	}
	res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
	res.end(fs.readFileSync(fp));
});

const serve = spawn(process.execPath, [path.join(GBA, "romctl.js"), "serve", String(PORT)], { cwd: GBA, stdio: ["ignore", "ignore", "pipe"] });
serve.stderr.on("data", () => {});

try {
	staticServer.listen(STATIC_PORT);
	const t0 = Date.now();
	for (;;) {
		try { const r = await fetch(API + "/status"); if (r.ok) break; } catch { /* wait */ }
		if (Date.now() - t0 > 30000) throw new Error("serve 未就绪");
		await sleep(400);
	}
	// 冷启动无状态 → 先加载测试 ROM（真实使用时由用户对话框/agent 完成）
	const load = await fetch(API + "/load?rom=" + encodeURIComponent(path.join(GBA, "roms", "pker.gba")));
	if (!load.ok) throw new Error("/load 失败: " + (await load.text()).slice(0, 200));

	const { chromium } = await import("playwright");
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

	// 帧流经 WS 持续推送（60fps），networkidle 永不满足 → 用 domcontentloaded + 显式等待
	await page.goto(BASE + "/gba-studio/index.html?api=" + API, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("#screen", { timeout: 15000 });
	await sleep(2500); // 等首轮 pollStatus 与 WS 建连
	check("studio 页面加载（pi-web public 托管形态）", true);
	check("顶栏状态行存在（内容已移至 pi-web 连接行，行本身设计为空）", (await page.$("#statusLine")) !== null);

	// 面板 1: 模拟器（WS 跨源推帧 + 截图）
	await page.click("#shotBtn");
	await sleep(1500);
	const painted = await page.evaluate(() => {
		const ctx = document.getElementById("screen").getContext("2d");
		return ctx.getImageData(0, 0, 10, 10).data.some((v) => v !== 0);
	});
	check("模拟器画面已绘制（非全黑，跨源 WS/API）", painted);
	// 画面居中（flex 主轴居中）
	const centered = await page.evaluate(() => getComputedStyle(document.querySelector(".screen-wrap")).alignItems === "center");
	check("画面在工作台居中", centered);

	// ★ 重新加载按钮 + ROM 文件夹记忆
	const reloadOn = await page.$eval("#reloadRomBtn", (b) => !b.disabled);
	check("重新加载按钮随 ROM 加载启用", reloadOn);
	page.once("dialog", (d) => { void d.accept(); });
	const st0 = await (await fetch(API + "/status")).json();
	await page.click("#reloadRomBtn");
	await sleep(1500);
	const st1 = await (await fetch(API + "/status")).json();
	check("重新加载重置帧计数", st1.ok && st1.frames <= st0.frames, `前 ${st0.frames} 后 ${st1.frames}`);
	// 目录记忆：进一个盘 → 关闭 → 重开应回到该盘（而非盘符根）
	await page.click("#openRomBtn");
	await sleep(500);
	await page.locator(".rom-row[data-dir]").first().click();
	await sleep(500);
	const dirShown = (await page.textContent("#romCurDir")).trim();
	await page.click("#romCloseBtn");
	await page.click("#openRomBtn");
	await sleep(500);
	const dirReopen = (await page.textContent("#romCurDir")).trim();
	check("ROM 对话框记住上次文件夹", dirReopen === dirShown && dirReopen !== "（选择盘符）", `${dirShown} → ${dirReopen}`);
	await page.click("#romCloseBtn");

	// 面板 2: 流水线
	await page.click('[data-tab="pipeline"]');
	await page.waitForSelector(".stage-card", { timeout: 15000 });
	check("流水线看板渲染阶段卡片", (await page.locator(".stage-card").count()) >= 8);

	// 面板 3: 回放（入口暂隐藏 —— tab 不可见时整段跳过且不记 FAIL）
	const replayVisible = await page.locator('[data-tab="replay"]').isVisible().catch(() => false);
	if (!replayVisible) {
		console.log('SKIP  会话回放（入口已隐藏）');
	}
	if (replayVisible) await page.click('[data-tab="replay"]');
	if (replayVisible) try {
		await page.locator(".session-item").first().waitFor({ timeout: 15000 });
		check("会话列表渲染", (await page.locator(".session-item").count()) > 0);
		await page.locator(".session-item").first().click();
		await page.locator(".tl-entry").first().waitFor({ timeout: 20000 });
		check("回放时间线渲染", (await page.locator(".tl-entry").count()) > 0);
	} catch (e) {
		check("会话列表渲染", false, String(e).slice(0, 100));
		check("回放时间线渲染", false, "跳过");
	}

	// 面板 4: 码表/字模（同源 assets）
	await page.click('[data-tab="charmap"]');
	try {
		await page.locator(".cm-row").first().waitFor({ timeout: 15000 });
		check("码表行渲染", (await page.locator(".cm-row").count()) > 100);
		await page.locator(".cm-row").first().click();
		await sleep(500);
		const glyphInk = await page.evaluate(() => {
			const d = document.getElementById("glyphCanvas").getContext("2d").getImageData(0, 0, 180, 180).data;
			return d.some((v, i) => i % 4 !== 3 && v < 100);
		});
		check("字模画布有墨迹", glyphInk);
	} catch (e) {
		check("码表行渲染", false, String(e).slice(0, 100));
		check("字模画布有墨迹", false, "跳过");
	}

	// 面板 5: 审校（gba/translation-er；行结构为 div.rl-row —— 非旧版 table/tbody）
	await page.click('[data-tab="review"]');
	try {
		await page.locator("#reviewTable .rl-row").first().waitFor({ timeout: 20000 });
		check("审校表渲染", (await page.locator("#reviewTable .rl-row").count()) > 0);
	} catch (e) {
		check("审校表渲染", false, String(e).slice(0, 100));
	}

	check("无页面 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));
	await browser.close();
} catch (e) {
	console.error("FATAL:", e);
	failures++;
} finally {
	serve.kill();
	staticServer.close();
	await sleep(300);
}
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
