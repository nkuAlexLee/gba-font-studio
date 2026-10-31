// 回归测试：HTML 文件预览的服务端内联（lib/html-preview.ts）。
//
// 背景：预览 iframe 是 sandbox="allow-scripts" 的 srcdoc → 不透明源，页面自己发起的相对
// 子资源请求属跨源 no-cors，被 Chromium ORB 拦掉（样式表下载了却不生效）。所以预览文档
// 必须由服务端组装成「零子资源请求」的形态。这些断言锁的就是该形状 + 安全边界。
//
// 浏览器层（真的在不透明源 iframe 里生效）在 test/html-preview-test.mjs。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// html-preview.ts 经由 "@/…" 别名导入，Next.js 之外需要显式声明别名 jiti 才能加载。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": ROOT }, moduleCache: false });
const { MAX_HTML_PREVIEW_BYTES, renderHtmlPreview } = await jiti.import("./html-preview.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;

const scratch = mkdtempSync(path.join(tmpdir(), "piweb-html-preview-"));
// 夹具创建可能失败：注册退出兜底，避免残留临时目录
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch { /* ignore */ }
});
/** 允许浏览的根（模拟会话 cwd）与故意不放行的兄弟目录。 */
const allowed = path.join(scratch, "site");
const outside = path.join(scratch, "outside");
mkdirSync(allowed, { recursive: true });
mkdirSync(outside, { recursive: true });
allowFileRoot(allowed);

after(() => rmSync(scratch, { recursive: true, force: true }));

const write = (base, name, content) => {
  const target = path.join(base, name);
  writeFileSync(target, content);
  return target;
};

write(allowed, "pixel.png", PNG);
write(allowed, "bg.png", PNG);
write(allowed, "nested.css", ".nested { color: rgb(9, 9, 9); }");
write(allowed, "style.css", [
  '@import "nested.css";',
  "body { background-color: rgb(1, 2, 3); }",
  '.bgi { background-image: url("bg.png"); }',
].join("\n"));
write(allowed, "app.js", [
  'document.title = "js ran";',
  'window.__markup = \'<img src="pixel.png">\';',
  'window.__link = \'<link rel="stylesheet" href="missing.css">\';',
].join("\n"));
write(outside, "secret.css", "body { color: rgb(6, 6, 6); }");
write(outside, "secret.png", PNG);

let htmlSeq = 0;
/** 把给定 HTML 落到允许根内再渲染（预览入口是「文件 + 内容」）。 */
async function render(html) {
  const file = write(allowed, `page-${++htmlSeq}.html`, html);
  return renderHtmlPreview(file, html);
}

test("内联本地样式表/脚本/图片，预览文档不再需要任何子资源请求", async () => {
  const out = await render([
    "<!doctype html><html><head>",
    '<link rel="stylesheet" href="style.css">',
    "</head><body class=\"bgi\">",
    '<img id="i" src="pixel.png">',
    '<script src="app.js"></script>',
    "</body></html>",
  ].join("\n"));

  assert.match(out, /<style data-preview-inlined="style\.css">/);
  assert.match(out, /body \{ background-color: rgb\(1, 2, 3\); \}/);
  assert.match(out, /background-image: url\("data:image\/png;base64,/);
  assert.match(out, /<img id="i" src="data:image\/png;base64,[^"]+"/);
  assert.ok(out.includes(PNG_URI), "data: URI 应是该图片的 base64");
  assert.match(out, /<script>document\.title = "js ran";/, "外链脚本应内联为行内 <script>");
  assert.ok(!/<script[^>]*\bsrc=/i.test(out), "不应残留 <script src>");
});

test("展开本地 @import，否则预览里仍是网络请求", async () => {
  const out = await render('<link rel="stylesheet" href="style.css">');

  assert.ok(!/@import\s+["']nested\.css/.test(out), "@import 应已展开");
  assert.match(out, /\.nested \{ color: rgb\(9, 9, 9\); \}/);
});

test("绝不改写 <script>/<style>/注释的正文", async () => {
  const out = await render([
    '<script src="app.js"></script>',
    '<!-- <img src="pixel.png"> -->',
    "<style>body { color: red }</style>",
  ].join("\n"));

  // JS 里拼标签的字面量必须原样（按标签正则重写整篇会毁掉这类脚本）
  assert.ok(out.includes(`window.__markup = '<img src="pixel.png">';`));
  assert.ok(out.includes(`window.__link = '<link rel="stylesheet" href="missing.css">';`));
  assert.ok(out.includes('<!-- <img src="pixel.png"> -->'), "注释内的引用不应被内联");
  assert.ok(out.includes("<style>body { color: red }</style>"));
});

test("远端地址、协议相对、根相对、锚点与读不到的引用一律保持原样", async () => {
  const out = await render([
    '<img src="https://cdn.example.com/a.png">',
    '<img src="//cdn.example.com/b.png">',
    '<img src="/root.png">',
    '<a href="#top">x</a>',
    '<img src="missing.png">',
    '<script src="https://cdn.example.com/x.js"></script>',
  ].join("\n"));

  for (const ref of [
    "https://cdn.example.com/a.png",
    "//cdn.example.com/b.png",
    "/root.png",
    "#top",
    "missing.png",
    "https://cdn.example.com/x.js",
  ]) {
    assert.ok(out.includes(ref), `应原样保留 ${ref}`);
  }
  assert.ok(!out.includes("data:image"));
});

test("允许根之外的资源不得被内联（本地文件读取边界）", async () => {
  const out = await render([
    '<link rel="stylesheet" href="../outside/secret.css">',
    '<img src="../outside/secret.png">',
  ].join("\n"));

  assert.ok(out.includes('href="../outside/secret.css"'));
  assert.ok(out.includes('src="../outside/secret.png"'));
  assert.ok(!out.includes("rgb(6, 6, 6)"));
  assert.ok(!out.includes("data:image"));
});

test("超过单资源上限（6MB）的资源跳过而不是拖垮预览", async () => {
  write(allowed, "huge.css", `/*${"x".repeat(6 * 1024 * 1024)}*/`);

  const out = await render('<link rel="stylesheet" href="huge.css">');

  assert.ok(out.includes('href="huge.css"'));
  assert.ok(!out.includes("<style"));
});

test("未闭合的 <script>/<style>/注释之后不再扫描（保守不破坏）", async () => {
  const out = await render('<style>body{color:red}<img src="pixel.png">');
  assert.ok(!out.includes("data:image"), "未闭合 <style> 之后的内容应原样保留");

  const out2 = await render('<img src="pixel.png"><script src="app.js">');
  assert.match(out2, /<img src="data:image\/png;base64,/);
  assert.ok(out2.endsWith('<script src="app.js">'), "未闭合 <script> 不应被内联");
});

test("预览源码上限与路由 413 判定一致（4MB）", () => {
  assert.equal(MAX_HTML_PREVIEW_BYTES, 4 * 1024 * 1024);
});
