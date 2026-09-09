/**
 * pi-web 集成端到端测试：单命令启动（next dev 自动拉起 romctl serve）→
 * GBA 工作台面板 → 主题注入 → ROM 浏览对话框实际加载。
 * 用法: node test/piweb-integration-test.mjs
 * 依赖: playwright（自动探测 npx 缓存）、pi-web 依赖已安装。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PIWEB = ROOT; // 测试已归属 pi-web 仓库
const WEB_PORT = 30141, GBA_PORT = 8645;

let failures = 0;
const check = (name, cond, extra) => {
	console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  — " + String(extra).slice(0, 120) : ""));
	if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 起 next dev（会经 instrumentation 自动拉起 romctl serve :8645） */
const dev = spawn(process.execPath, [path.join(PIWEB, "node_modules", "next", "dist", "bin", "next"), "dev", "-H", "127.0.0.1", "-p", String(WEB_PORT)], {
	cwd: PIWEB, stdio: ["ignore", "pipe", "pipe"],
	env: { ...process.env, GBA_SERVE_PORT: String(GBA_PORT) },
});
let devLog = "";
dev.stdout.on("data", (d) => { devLog += d; });
dev.stderr.on("data", (d) => { devLog += d; });

try {
	const t0 = Date.now();
	for (;;) {
		const webUp = await fetch(`http://127.0.0.1:${WEB_PORT}/`).then((r) => r.ok).catch(() => false);
		const gbaUp = await fetch(`http://127.0.0.1:${GBA_PORT}/status`).then((r) => r.ok).catch(() => false);
		if (webUp && gbaUp) break;
		if (Date.now() - t0 > 60000) throw new Error("启动超时 web=" + webUp + " gba=" + gbaUp + "\n" + devLog.slice(-500));
		await sleep(1000);
	}
	check("单命令启动：next dev 拉起 romctl serve", true, devLog.match(/\[gba\].*/)?.[0]);

	const { chromium } = await import("file:///C:/Users/nkualexlee/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs");
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
	await page.waitForSelector('button[aria-label="GBA 工作台"]', { timeout: 30000 });
	// 冷编译时 hydration 可能未完成，点击无效 → 重试直到 iframe 出现
	for (let i = 0; i < 12; i++) {
		await page.click('button[aria-label="GBA 工作台"]').catch(() => {});
		try { await page.waitForSelector('iframe[title="GBA Font Studio"]', { timeout: 5000 }); break; } catch { /* 重试 */ }
	}
	await page.waitForSelector('iframe[title="GBA Font Studio"]', { timeout: 30000 });
	await sleep(3500); // 等 iframe 加载 + 主题注入

	const frame = page.frameLocator('iframe[title="GBA Font Studio"]');
	const studioFrame = page.frames().find((f) => f.url().includes("/gba-studio/index.html"));
	// 1) 主题注入：iframe 内 html 的 --bg 应与宿主一致
	const hostBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
	const frameBg = studioFrame ? await studioFrame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()) : "";
	check("主题对齐：iframe --bg == 宿主 --bg", hostBg.length > 0 && hostBg === frameBg, `${hostBg} vs ${frameBg}`);
	check("studio 五标签渲染", (await frame.locator("#tabs .tab").count()) === 5);

	// 2) ROM 对话框：工作台顶栏「📂 打开 ROM」（iframe 内唯一入口）→ 弹窗 → 逐级进 roms → 加载
	await frame.locator("#openRomBtn").click();
	await frame.locator("#romModal:not([hidden])").waitFor({ timeout: 10000 });
	await frame.locator(".rom-row").first().waitFor({ timeout: 10000 });
	check("ROM 对话框弹出（盘符列表）", (await frame.locator(".rom-row").count()) > 0);
	// 接受 confirm
	page.on("dialog", (d) => void d.accept());
	// 逐级导航到 pi-web/gba/roms（首屏是盘符）
	for (const seg of ["D:", "vibecoding", "gba-font-cracker-js", "pi-web", "gba", "roms"]) {
		await frame.locator(`.rom-row:has-text("${seg}")`).first().click();
		await sleep(700);
	}
	await frame.locator(".rom-load").first().click(); // 触发 confirm（自动接受）
	await sleep(4000);
	const studioStatus = await frame.locator("#statusLine").textContent().catch(() => "");
	check("对话框加载 ROM 生效（工作台顶栏更新）", /\.gba/i.test(studioStatus || ""), studioStatus);
	check("对话框已关闭", await frame.locator("#romModal[hidden]").count() === 1);

	// 3) agent 身份感知（rom_status 结构化输出）在 tool-exec-test 覆盖；这里核对 serve 状态含 rom
	const st = await (await fetch(`http://127.0.0.1:${GBA_PORT}/status`)).json();
	check("serve /status 含 ROM 身份", typeof st.rom === "string" && st.rom.endsWith(".gba"), st.rom);

	check("无页面 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));
	await page.screenshot({ path: path.join(ROOT, "docs", "piweb-集成截图.png") });
	await browser.close();
} catch (e) {
	console.error("FATAL:", e);
	failures++;
} finally {
	dev.kill();
	await sleep(500);
	try {
		const cp = await import("node:child_process");
		cp.execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \'Name=\'\'node.exe\'\'\' | Where-Object { $_.CommandLine -like \''*romctl*serve*8645*'\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', { stdio: "ignore" });
	} catch { /* ignore */ }
}
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
