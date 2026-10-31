/**
 * HTML 文件预览端到端回归（常驻；与 gba-workbench-test / piweb-integration-test 并列手跑）。
 *
 * 为什么需要浏览器层：预览 iframe 是 sandbox="allow-scripts" 的 srcdoc，文档处于不透明源，
 * 相对子资源请求会被 Chromium ORB 拦掉（样式表下载成功但永不生效 —— net::ERR_BLOCKED_BY_ORB）。
 * 只看 HTTP 状态码发现不了，所以这里把预览 HTML 塞进同款沙箱 iframe，断言 CSS 真的生效、
 * 脚本真的执行、图片真的解码，且预览文档没有发起任何子资源请求。
 * 纯逻辑与安全边界（允许根、上限、块感知）在 lib/html-preview.test.mjs。
 *
 * 用法: node test/html-preview-test.mjs     端口可覆盖：HTML_PREVIEW_TEST_PORT（默认 30341）
 * 依赖: playwright（pi-web/node_modules）、pi-web 依赖已安装。
 *
 * 隔离：本用例用自己的 NEXT_DIST_DIR（.next-html-preview-test，已 gitignore）+ GBA_STUDIO=0，
 * 因此可以与开发态的 dev server 并存，也不会污染 .next/。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PORT = Number(process.env.HTML_PREVIEW_TEST_PORT || 30341);
// 隔离用的 distDir（Turbopack 的开发缓存会涨到几百 MB，默认用完即删）
const DIST_DIR = process.env.NEXT_DIST_DIR || ".next-html-preview-test";
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra !== undefined ? "  — " + String(extra).slice(0, 140) : ""));
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiPath = (p) => path.resolve(p).split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join("/");

/* ---------- 夹具：允许根内的站点 + 会话（会话 cwd 决定 allowed roots） ---------- */
const scratch = mkdtempSync(path.join(tmpdir(), "piweb-html-preview-e2e-"));
// 夹具创建发生在 try 之前：即使中途抛错也要清掉临时目录
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch { /* ignore */ }
});
const site = path.join(scratch, "site");
const agentDir = path.join(scratch, "agent");
mkdirSync(site, { recursive: true });
mkdirSync(path.join(agentDir, "sessions", "preview-project"), { recursive: true });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
writeFileSync(path.join(site, "pixel.png"), PNG);
writeFileSync(path.join(site, "bg.png"), PNG);
writeFileSync(path.join(site, "style.css"), [
  "body { background-color: rgb(1, 2, 3); }",
  ".bgi { background-image: url(\"bg.png\"); }",
].join("\n"));
writeFileSync(path.join(site, "app.js"), [
  "document.title = \"js ran\";",
  "document.getElementById(\"t\").textContent = \"script inlined\";",
  "window.__markup = '<img src=\"pixel.png\">';",
].join("\n"));
writeFileSync(path.join(site, "page.html"), [
  "<!doctype html>",
  "<html><head><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"style.css\"></head>",
  "<body class=\"bgi\">",
  "<h1 id=\"t\">placeholder</h1>",
  "<img id=\"i\" src=\"pixel.png\" width=\"4\" height=\"4\">",
  "<script src=\"app.js\"></script>",
  "</body></html>",
].join("\n"));
// 超过预览上限（4MB）的源文件 → 413
writeFileSync(path.join(site, "big.html"), `<!doctype html><body><!--${"x".repeat(4 * 1024 * 1024 + 1024)}--></body>`);
// 让 site 成为允许根：与真实使用一致，来自某个会话的 cwd
writeFileSync(
  path.join(agentDir, "sessions", "preview-project", "2026-01-01T00-00-00-000Z_preview-session.jsonl"),
  `${JSON.stringify({ type: "session", version: 3, id: "preview-session", timestamp: new Date().toISOString(), cwd: site })}\n`,
);

const pageHtml = path.join(site, "page.html");
const previewUrl = `${BASE}/api/files-html-preview/${apiPath(pageHtml)}`;

/* ---------- 起独立 dev 实例（GBA_STUDIO=0：不碰 romctl，避免与已装客户端抢 8645） ---------- */
const pre = await fetch(`${BASE}/api/sessions`).then((r) => r.ok).catch(() => false);
if (pre) {
  console.error(`端口 ${PORT} 已被占用，请关闭占用进程或设置 HTML_PREVIEW_TEST_PORT`);
  process.exit(1);
}

const dev = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "-H", "127.0.0.1", "-p", String(PORT)],
  {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // 不碰 romctl（避免与已装客户端抢 8645），并用独立 distDir 避开 .next/dev/lock 争用
      GBA_STUDIO: "0",
      NEXT_DIST_DIR: DIST_DIR,
      PI_CODING_AGENT_DIR: agentDir,
    },
  },
);
let devLog = "";
dev.stdout.on("data", (d) => { devLog += d; });
dev.stderr.on("data", (d) => { devLog += d; });

function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

let browser = null;
try {
  const t0 = Date.now();
  for (;;) {
    const up = await fetch(`${BASE}/`, { redirect: "manual" }).then((r) => r.status < 500).catch(() => false);
    if (up) break;
    if (Date.now() - t0 > 120000) throw new Error(`next dev 启动超时\n${devLog.slice(-600)}`);
    await sleep(1000);
  }

  /* ---------- 1) 内联结果（HTTP） ---------- */
  const res = await fetch(previewUrl);
  const html = await res.text();
  check("预览接口 200 + text/html", res.status === 200 && /^text\/html/.test(res.headers.get("content-type") || ""), `${res.status} ${res.headers.get("content-type")}`);
  check("样式表内联为 <style>（CSS url() 转 data:）", /<style data-preview-inlined="style\.css">/.test(html) && /background-image: url\("data:image\/png;base64,/.test(html));
  check("外链脚本内联，无 <script src> 残留", html.includes("window.__markup") && !/<script[^>]*\bsrc=/i.test(html));
  check("脚本正文未被标签重写（字面量原样）", html.includes(`window.__markup = '<img src="pixel.png">';`));

  const tags = [...html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").matchAll(/<(?:link|script|img|source|video|audio|input)\b[^>]*>/gi)].map((m) => m[0]);
  const relativeRefs = tags.flatMap((tag) => [...tag.matchAll(/[\s"'](src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)].map((a) => a[2] ?? a[3] ?? a[4] ?? ""))
    .filter((v) => v && !/^(?:data:|https?:|\/\/|#)/i.test(v));
  check("预览文档内无相对子资源引用", relativeRefs.length === 0, relativeRefs.join(", "));
  check("图片引用转 data: URI", [...html.matchAll(/<img\b[^>]*>/gi)].some((m) => /id="i"/.test(m[0]) && /src="data:image\/png;base64,/.test(m[0])));

  /* ---------- 2) 边界与相邻路由 ---------- */
  check("目录 → 400", (await fetch(`${BASE}/api/files-html-preview/${apiPath(site)}`)).status === 400);
  const outside = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hostname";
  check("允许根之外 → 403", (await fetch(`${BASE}/api/files-html-preview/${apiPath(outside)}`)).status === 403);
  check("不存在 → 404", (await fetch(`${BASE}/api/files-html-preview/${apiPath(path.join(site, "nope.html"))}`)).status === 404);
  check("超过 4MB → 413", (await fetch(`${BASE}/api/files-html-preview/${apiPath(path.join(site, "big.html"))}`)).status === 413);

  const raw = await fetch(`${BASE}/api/files-raw/${apiPath(path.join(site, "style.css"))}`);
  check("/api/files-raw 回退资源：200 + text/css + nosniff", raw.status === 200 && /^text\/css/.test(raw.headers.get("content-type") || "") && raw.headers.get("x-content-type-options") === "nosniff");
  const mainJson = await (await fetch(`${BASE}/api/files/${apiPath(pageHtml)}?type=read`)).json().catch(() => ({}));
  check("/api/files?type=read 仍返回 JSON（streamFile 抽取未回归）", typeof mainJson.content === "string" && mainJson.content.includes("<h1 id=\"t\">"));
  const png = await fetch(`${BASE}/api/files/${apiPath(path.join(site, "pixel.png"))}?type=read`);
  check("/api/files 图片仍走流式 + image/png", png.status === 200 && png.headers.get("content-type") === "image/png");

  /* ---------- 3) 在真实沙箱里生效（浏览器） ---------- */
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });

  // 与 FileViewer 同路径：应用源内 fetch 预览接口 → 塞进 sandbox srcdoc
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.evaluate(async ({ url }) => {
    const res = await fetch(url);
    const frame = document.createElement("iframe");
    frame.id = "preview";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = await res.text();
    document.body.appendChild(frame);
  }, { url: previewUrl });

  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame.waitForSelector("#t", { timeout: 20000 });
  await frame.waitForFunction(
    () => getComputedStyle(document.body).backgroundColor === "rgb(1, 2, 3)",
    null,
    { timeout: 10000 },
  ).catch(() => {});
  const bg = await frame.$eval("body", (b) => getComputedStyle(b).backgroundColor);
  check("内联 CSS 在不透明源文档里生效", bg === "rgb(1, 2, 3)", bg);
  const bgImage = await frame.$eval("body", (b) => getComputedStyle(b).backgroundImage);
  check("CSS 内 url() 的 data: URI 生效", bgImage.startsWith('url("data:image'), bgImage.slice(0, 40));
  check("内联脚本真的执行（document.title）", (await frame.title()) === "js ran", await frame.title());
  check("内联脚本可改 DOM", (await frame.$eval("#t", (el) => el.textContent)) === "script inlined");
  check("相对图片 data: URI 解码成功", await frame.$eval("#i", (i) => i.complete && i.naturalWidth > 0));
  check("脚本正文未被重写（浏览器里校验）", (await frame.evaluate(() => window.__markup)) === '<img src="pixel.png">');

  const leaked = requests.filter((u) => /pixel|\.css|app\.js|files-raw|files-html-preview/.test(u) && !u.includes("/api/files-html-preview/"));
  check("预览文档未发起子资源请求（ORB 回归即在此失败）", leaked.length === 0, leaked[0]);
} catch (e) {
  console.error("FATAL:", e);
  failures++;
} finally {
  if (browser) await browser.close().catch(() => {});
  killTree(dev);
  for (let i = 0; i < 20; i++) {
    const still = await fetch(`${BASE}/api/sessions`).then(() => true).catch(() => false);
    if (!still) break;
    await sleep(500);
  }
  rmSync(scratch, { recursive: true, force: true });
  // 保留缓存可加快后续调试（HTML_PREVIEW_TEST_KEEP_DIST=1）
  if (!process.env.HTML_PREVIEW_TEST_KEEP_DIST) {
    try {
      rmSync(path.join(ROOT, DIST_DIR), { recursive: true, force: true });
    } catch { /* Windows 上偶发占用：留着下次覆盖 */ }
  }
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
