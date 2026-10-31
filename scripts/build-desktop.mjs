#!/usr/bin/env node
/**
 * build-desktop.mjs — GBA Font Studio 桌面端一键构建
 *
 * 链路（顺序固定，见根 AGENTS.md 约定 1；任一步失败立即终止并完整透传输出——
 * 构建输出勿用管道吞错，踩坑见约定 6）：
 *   1) pi-web 依赖安装（缺 node_modules 时自动 npm install）
 *   2) pi-web 生产构建 next build（Turbopack 默认；--webpack 会 OOM，勿改）
 *   3) app 依赖安装（缺 node_modules 时自动 npm install）
 *   4) app/build-payload.mjs 组装 payload（→ D:\gbfp，junction 挂回 src-tauri/payload）
 *   5) tauri build --bundles nsis → app/src-tauri/target/release/bundle/nsis/*-setup.exe
 *
 * 用法（仓库根执行，或任意目录）：
 *   npm run build:desktop            # 全量
 *   --with-test     先跑测试基线（gbajs2 三项 + pi-web 两项），失败不打包
 *   --skip-next     复用 pi-web/.next（须已有生产构建）
 *   --skip-payload  复用已有 payload（junction 必须已存在）
 *   --skip-tauri    只组装 payload，不打安装包
 *   --skip-install  不自动补装依赖
 *
 * 前置：Windows + node + Rust(tauri)；node.exe 源 / Git Bash 源 / GBA_PAYLOAD_DIR
 * 等环境变量见 app/build-payload.mjs 顶部说明。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GBAJS2 = path.join(ROOT, "gbajs2");
const PIWEB = path.join(ROOT, "pi-web");
const APP = path.join(ROOT, "app");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

// 全部经 process.execPath 调 JS 入口，绕开 .cmd 垫片：
// 新版 Node 出于安全（CVE-2024-27980）禁止 shell:false 直接 spawn .cmd/.bat（报 spawnSync EINVAL）
const NODEDIR = path.dirname(process.execPath);
const NPMCLI = path.join(NODEDIR, "node_modules", "npm", "bin", "npm-cli.js");
const NEXTCLI = path.join(PIWEB, "node_modules", "next", "dist", "bin", "next");
const TAURIJS = path.join(APP, "node_modules", "@tauri-apps", "cli", "tauri.js");

const log = (...a) => console.log("[build-desktop]", ...a);
const die = (m) => { console.error("[build-desktop] ✘", m); process.exit(1); };

function run(cmd, cmdArgs, cwd) {
    log("▶", cmd, cmdArgs.join(" "), `（cwd=${path.relative(ROOT, cwd) || "."}）`);
    const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: false });
    if (r.error) die(`${cmd} 启动失败: ${r.error.message}`);
    if (r.status !== 0) die(`上一步失败（exit ${r.status}）——已停止，完整输出见上`);
}

const t0 = Date.now();

/* 0) 前置检查 */
for (const f of ["pi-web/package.json", "app/build-payload.mjs", "app/src-tauri/tauri.conf.json"]) {
    if (!fs.existsSync(path.join(ROOT, f))) die(`缺少 ${f} — 请在 GBA Font Studio 仓库内运行`);
}
if (!fs.existsSync(NPMCLI)) die(`缺 npm-cli: ${NPMCLI} — 需官方 node 安装布局（<node目录>/node_modules/npm）`);
if (!fs.existsSync(NEXTCLI)) die(`缺 next CLI: ${NEXTCLI} — 先在 pi-web 执行 npm install`);
if (!fs.existsSync(TAURIJS)) die(`缺 tauri CLI: ${TAURIJS} — 先在 app 执行 npm install`);

/* 1) pi-web 依赖 */
if (!has("--skip-install") && !fs.existsSync(path.join(PIWEB, "node_modules"))) {
    log("pi-web 缺 node_modules，自动安装…");
    run(process.execPath, [NPMCLI, "install", "--no-audit", "--no-fund"], PIWEB);
}

/* 1b) 测试基线（可选） */
if (has("--with-test")) {
    for (const t of ["test/extension-test.mjs", "test/tool-exec-test.mjs", "test/studio-test.mjs"]) {
        run(process.execPath, [t], GBAJS2);
    }
    run(process.execPath, [NPMCLI, "run", "test"], PIWEB);
    log("测试基线通过 ✓");
}

/* 2) pi-web 生产构建 */
const buildId = path.join(PIWEB, ".next", "BUILD_ID");
if (has("--skip-next")) {
    if (!fs.existsSync(buildId)) die("pi-web/.next 无生产构建（缺 BUILD_ID）— 去掉 --skip-next 全量构建");
    log("复用已有 pi-web/.next");
} else {
    run(process.execPath, [NEXTCLI, "build"], PIWEB);
    if (!fs.existsSync(buildId)) die("next build 结束但缺 .next/BUILD_ID — 检查上方完整输出");
}

/* 3) app 依赖 */
if (!has("--skip-install") && !fs.existsSync(path.join(APP, "node_modules"))) {
    log("app 缺 node_modules，自动安装…");
    run(process.execPath, [NPMCLI, "install", "--no-audit", "--no-fund"], APP);
}

/* 4) payload 组装 */
if (has("--skip-payload")) {
    log("跳过 payload 组装（复用已有 src-tauri/payload）");
} else {
    const payloadArgs = ["build-payload.mjs"];
    if (has("--skip-next")) payloadArgs.push("--skip-next-build");
    run(process.execPath, payloadArgs, APP);
}

/* 5) tauri 打包 */
if (!has("--skip-tauri")) {
    run(process.execPath, [TAURIJS, "build", "--bundles", "nsis"], APP);
    const bundleDir = path.join(APP, "src-tauri", "target", "release", "bundle", "nsis");
    if (fs.existsSync(bundleDir)) {
        const exes = fs.readdirSync(bundleDir).filter((f) => f.endsWith(".exe"));
        if (exes.length) log("✅ 产物:\n   " + exes.map((f) => path.join(bundleDir, f)).join("\n   "));
    }
} else {
    log("跳过 tauri build");
}

log(`✅ 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
