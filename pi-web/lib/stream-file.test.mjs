// 源码断言：文件流式响应（/api/files 与 /api/files-raw 共用的 lib/stream-file.ts）
// 必须带这些安全头。原测试位于 app/api/files/stream-route.test.mjs —— streamFile 已抽到本模块，
// 测试随实现一起搬家，否则会把「实现位置」当成不变量。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./stream-file.ts", import.meta.url), "utf8");
const start = source.indexOf("function streamFile");
assert.notEqual(start, -1, "streamFile not found");
// streamFile 在文件末尾，切片到 EOF 即可覆盖全部返回分支
const streamBlock = source.slice(start);

test("streamed responses are not content-type sniffable", () => {
  assert.match(streamBlock, /"X-Content-Type-Options": "nosniff"/);
});

test("inline SVG is served with a script-blocking content security policy", () => {
  // SVG is the only inline preview type a browser executes as a document, so
  // it must never be able to run script in the Pi Web origin.
  assert.match(streamBlock, /contentType === "image\/svg\+xml"/);
  assert.match(streamBlock, /Content-Security-Policy/);
  assert.match(streamBlock, /default-src 'none'/);
  assert.match(streamBlock, /style-src 'unsafe-inline'/);
  assert.match(streamBlock, /frame-ancestors 'self'/);
});

test("the restrictive headers are applied to every streamFile response shape", () => {
  // The header object is shared by the full-body, 416, and 206 paths.
  const headerObject = streamBlock.indexOf("const headers");
  const firstReturn = streamBlock.indexOf("createFileBodyStream", headerObject);
  assert.ok(headerObject !== -1 && firstReturn > headerObject, "headers must be built before any response");
});
