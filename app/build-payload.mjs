#!/usr/bin/env node
/**
 * build-payload.mjs — 组装 Tauri 客户端 payload（src-tauri/payload/）
 *
 * 内容（对应目标：打包后自带 skill/扩展/md，安装路径含初始 workspace）：
 *   payload/pi-web/            pi-web 运行时（.next 生产构建 + 精简 node_modules + public + 配置）
 *   payload/gba/               GBA 引擎（romctl.js + js + assets + scripts + translation-er + roms + work）
 *   payload/runtime/node.exe   独立 node 运行时（自 E:\Program Files\nodejs 复制）
 *   payload/workspace-template/ 安装首启复制的 workspace（AGENTS.md + .pi/skills + .pi/extensions + roms/）
 *   payload/agent-template/    agent 数据目录骨架（settings.json 预置 GBA 默认模型指引）
 *
 * 用法: node build-payload.mjs [--skip-prune]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");            // gba-font-cracker-js/
// 火山方舟 plan 模型目录（agent-template/models.json 预置用；key 不入库，用户自行配置）
const ARK_CATALOG = JSON.parse(fs.readFileSync(path.join(here, "ark-catalog.json"), "utf8"));
const PIWEB = path.join(ROOT, "pi-web");
// payload 落在短路径（NSIS 对 >260 字符的源路径会失败；默认仓库内路径太长）
// 并以 junction（指向 <REAL>/payload）挂回 src-tauri/payload；resources 用相对路径 payload/**/*
// ⚠️ 绝对路径 resources 会被 Tauri 安装到 _root_/<盘符路径> 嵌套布局，bootstrap 探测不到（2026-09-08 教训）
const PAYLOAD_REAL = path.resolve(process.env.GBA_PAYLOAD_DIR || "D:/gbfp"); // 正斜杠避免转义问题；path.resolve 规范化为盘符路径
const DEST = path.join(PAYLOAD_REAL, "payload");
const NODE_SRC = "E:/Program Files/nodejs/node.exe";

const log = (...a) => console.log("[payload]", ...a);
const fail = (m) => { console.error("[payload] ✘", m); process.exit(1); };
const io = { read: (p) => fs.readFileSync(p, "utf8"), write: (p, c) => fs.writeFileSync(p, c) };
const cp = (src, dst, opts = {}) => {
    fs.cpSync(src, dst, { recursive: true, dereference: false, verbatimSymlinks: false, ...opts });
};
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

/* 0. 前置检查 */
if (!fs.existsSync(path.join(PIWEB, ".next", "BUILD_ID"))) {
    fail("pi-web/.next 缺生产构建 — 先在 pi-web 目录执行 `npx next build`");
}
if (!fs.existsSync(NODE_SRC)) fail(`node.exe 不存在: ${NODE_SRC}`);

/* 1. 清空重建 */
log("清空", DEST);
rm(DEST);
fs.mkdirSync(DEST, { recursive: true });

/* 2. pi-web 运行时 */
const SKIP_NM = process.argv.includes("--skip-node-modules"); // 复用 payload 内已 prune 的 node_modules
const SKIP_NEXT = process.argv.includes("--skip-next-build"); // 复用已有 .next
log("复制 pi-web 源 + .next + public …");
const pw = path.join(DEST, "pi-web");
fs.mkdirSync(pw, { recursive: true });
for (const f of ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "instrumentation.ts", "lib", "app", "components", "hooks", "bin"]) {
    const src = path.join(PIWEB, f);
    if (fs.existsSync(src)) cp(src, path.join(pw, f));
}
if (!SKIP_NEXT) {
    if (!fs.existsSync(path.join(PIWEB, ".next", "BUILD_ID"))) fail("pi-web/.next 缺生产构建 — 先在 pi-web 目录执行 `npx next build`");
    cp(path.join(PIWEB, ".next"), path.join(pw, ".next"));
} else {
    // ⚠ --skip-next-build 只表示复用 pi-web/.next 现有构建、省掉 next build 这一步（见 scripts/build-desktop.mjs）；
    // .next 仍必须复制进 payload —— DEST 已清空重建，跳过复制会得到缺 .next 的残废包，
    // 安装后 next start 报 "Could not find a production build"（2026-09-10 教训）
    if (!fs.existsSync(path.join(PIWEB, ".next", "BUILD_ID"))) fail("pi-web/.next 缺生产构建 — 先在 pi-web 目录执行 `npx next build`，或去掉 --skip-next");
    log("复用已有 pi-web/.next，照常复制进 payload …");
    cp(path.join(PIWEB, ".next"), path.join(pw, ".next"));
}
// .next 内的 dev 残留/cache 不进安装包（NSIS 对超长路径会失败）
for (const junk of [".next/dev", ".next/cache"]) rm(path.join(pw, junk));
cp(path.join(PIWEB, "public"), path.join(pw, "public"));

/* 2b. node_modules：先整树复制再 npm prune --omit=dev（不动开发仓库本体） */
if (SKIP_NM && fs.existsSync(path.join(pw, "node_modules"))) {
    log("复用 payload 内已有 node_modules（--skip-node-modules）");
} else {
log("复制 node_modules（1.2GB，需 1-3 分钟）…");
cp(path.join(PIWEB, "node_modules"), path.join(pw, "node_modules"));
if (!process.argv.includes("--skip-prune")) {
    log("npm prune --omit=dev（剔除 devDependencies）…");
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const r = spawnSync(npmBin, ["prune", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd: pw, stdio: "inherit", shell: process.platform === "win32",
    });
    if (r.error) fail("npm prune 启动失败: " + r.error.message);
    if (r.status !== 0) fail("npm prune 失败（exit " + r.status + "）");
} else {
    log("跳过 prune");
}
}
// 深路径瘦身：d.ts/类型包/sourcemap 不参与运行时，且长路径会让 NSIS 打包失败
log("深路径瘦身（剔除 dist-types/*.d.ts/*.map，移除 .next/node_modules）…");
{
    const slim = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === "dist-types") { rm(fp); continue; }
                slim(fp);
            } else if (/\.(d\.ts|d\.ts\.map|ts\.map)$/.test(e.name) || (e.name.endsWith(".map") && fp.includes("node_modules"))) {
                fs.rmSync(fp, { force: true });
            }
        }
    };
    slim(pw);
    // 注意：.next/node_modules 不能整删 —— Turbopack 的外部模块 shim（undici-<hash> 等）在其中，
    // 运行时必须可解析；瘦身已剔除其中的 dist-types/*.d.ts（NSIS 长路径来源）
    // 最长路径断言（NSIS 限制 ~260）
    let longest = "";
    const scan = (dir) => {
        let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of es) { const fp = path.join(dir, e.name); if (e.isDirectory()) scan(fp); else if (fp.length > longest.length) longest = fp; }
    };
    scan(DEST);
    if (longest.length > 240) fail("存在超长路径(" + longest.length + "): " + longest);
    log("最长路径 " + longest.length + " 字符 ✓");
}

// prune 后自检：next 与 pi-coding-agent 必须还在
for (const must of ["node_modules/next/dist/bin/next", "node_modules/@earendil-works/pi-coding-agent/package.json", "node_modules/node-pty"]) {
    if (!fs.existsSync(path.join(pw, must))) fail(`prune 后缺失关键依赖: ${must}`);
}
// gba 引擎由 pi-web instrumentation 以 GBA_STUDIO_DIR 指向 payload/gba（见 3）

/* 3. gba 引擎（自包含） */
log("复制 gba 引擎（~200MB）…");
cp(path.join(PIWEB, "gba"), path.join(DEST, "gba"), { filter: (src) => {
	const rel = path.relative(path.join(PIWEB, "gba"), src);
	const top = rel.split(path.sep)[0];
	return !["translation-er", "roms", "work", "tmp", "data"].includes(top);
} });
// 清理运行残留（状态/日志不进安装包）
for (const junk of ["tmp", "data"]) rm(path.join(DEST, "gba", junk));

/* 4. node 运行时 */
log("复制 node.exe …");
fs.mkdirSync(path.join(DEST, "runtime"), { recursive: true });
fs.copyFileSync(NODE_SRC, path.join(DEST, "runtime", "node.exe"));

/* 5. workspace 模板（首启复制到安装路径 data/workspace）*/
log("组装 workspace-template（AGENTS.md + .pi/skills + .pi/extensions + roms）…");
const ws = path.join(DEST, "workspace-template");
fs.mkdirSync(path.join(ws, ".pi", "skills"), { recursive: true });
fs.mkdirSync(path.join(ws, ".pi", "extensions"), { recursive: true });
fs.mkdirSync(path.join(ws, "roms"), { recursive: true });
// AGENTS.md：面向新用户的领域指引（pi-web 仓库那份面向开发者，重新精简一份）
fs.writeFileSync(path.join(ws, "AGENTS.md"), `# GBA Font Studio 工作区

你是 GBA 宝可梦改版 ROM 中文字库/翻译工程师（pi agent），运行在 GBA Font Studio 客户端内。

## 能力（pi 扩展自动加载，优先使用结构化工具而非手拼命令）
| 工具组 | 工具 |
|--------|------|
| 模拟器 | rom_status rom_load rom_run rom_key rom_screenshot rom_memread rom_memwrite rom_disasm rom_hookadd rom_hookevents rom_snap |
| 流水线 | pipeline_stage pipeline_status pipeline_report |
| 字库 | font_charmap_query font_glyph_render |
| 翻译 | text_validate text_insert |

## 流程纪律
- 标准阶段：engine→font→charmap→export→translate→layout→insert→verify；每个里程碑调 \`pipeline_stage\` 带证据。
- 回填前必须 \`text_validate\` 通过；写操作前先 \`rom_snap save\`。
- 会话图片有预算：渠道对单请求图片数硬上限（30），扩展在阈值 25 自动降级为存盘路径+摘要；收到降级提示先 /compact 释放配额再继续。
- 截图/字模以图片返回，可直接看图判断。

## 运行环境（Windows）
- bash 工具 = 客户端捆绑的 Git Bash（payload/runtime/gitbash），**不是** WSL；PATH 已前置 /usr/bin，
  ls/grep/sed/awk/head/tail/find 可用。注意：无 xxd，二进制查看用 od -A x -t x1z 或 node -e。
- 二进制/文本处理优先 node -e（node 在 PATH）；批处理脚本先写入文件再执行（heredoc 转义易错）。
- PowerShell 可经 \`powershell.exe -NoProfile -Command "...\` 调用。

## 路径
- 引擎与数据：\`gba/\`（romctl、assets、scripts、translation-er、work）
- 用户 ROM：工作区 \`roms/\` 或任意路径（Studio「📂 打开 ROM」或 rom_load）
- 详细配方：.pi/skills/gba-font-crack 与 gba-text-translate 的 SKILL.md
`);
// skills + extensions（来自 pi-web/.pi）
cp(path.join(PIWEB, ".pi", "skills"), path.join(ws, ".pi", "skills"));
cp(path.join(PIWEB, ".pi", "extensions"), path.join(ws, ".pi", "extensions"));
// 预置 ROM（小卡即开即玩；大 ROM 用户自备）
const romSrc = path.join(PIWEB, "gba", "roms");
for (const r of ["pker.gba", "pker.sav"]) {
    const f = path.join(romSrc, r);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(ws, "roms", r));
}
fs.writeFileSync(path.join(ws, "roms", "README.md"),
    "# ROM 目录\n\n把改版 ROM（.gba）放这里，然后对 agent 说「加载 roms/xxx.gba」。\n也可以用工作台「📂 打开 ROM」选择任意位置的 ROM。\n");
fs.mkdirSync(path.join(ws, "projects"), { recursive: true });
fs.writeFileSync(path.join(ws, "projects", "README.md"),
    "# 翻译工程目录\n\n翻译工程与具体 ROM 绑定，由 agent 按需创建（export-strings init --project projects/<工程名>）。\n一个 ROM 对应一个工程目录（如 projects/translation-redragon/）。\n");
fs.mkdirSync(path.join(ws, "work"), { recursive: true });
fs.writeFileSync(path.join(ws, "work", "README.md"),
    "# 流水线运行产物\n\npipeline.json（阶段状态，agent 的 pipeline_stage 工具维护）、报告、回填日志。\n");

/* 5b. 模板指纹（.pi/.template-id）：lib.rs 升级时据此自动刷新工作区 .pi/ 与未改动的 AGENTS.md。
 *     agentsMd = FNV-1a64（手写，与 lib.rs fnv1a64 同算法）；pi 指纹只需确定性即可（Rust 端仅比对，不重算）。 */
{
	const fold = (h, buf) => { for (const b of buf) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } return h; };
	const SEED = 0xcbf29ce484222325n;
	const files = [];
	const walk = (dir, rel) => {
		for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
			const fp = path.join(dir, f.name), rp = rel ? rel + "/" + f.name : f.name;
			if (f.isDirectory()) walk(fp, rp);
			else files.push({ rp, fp });
		}
	};
	walk(path.join(ws, ".pi"), "");
	files.sort((a, b) => (a.rp < b.rp ? -1 : 1));
	let h = SEED;
	for (const { rp, fp } of files) { h = fold(h, Buffer.from(rp, "utf8")); h = fold(h, Buffer.from([0])); h = fold(h, fs.readFileSync(fp)); }
	fs.writeFileSync(path.join(ws, ".pi", ".template-id"), JSON.stringify({
		built: new Date().toISOString(),
		pi: h.toString(16).padStart(16, "0"),
		agentsMd: fold(SEED, fs.readFileSync(path.join(ws, "AGENTS.md"))).toString(16).padStart(16, "0"),
	}, null, "\t"));
}

/* 6. agent 模板（PI_CODING_AGENT_DIR 骨架）*/
log("组装 agent-template …");
const at = path.join(DEST, "agent-template");
fs.mkdirSync(path.join(at, "sessions"), { recursive: true });
fs.writeFileSync(path.join(at, "settings.json"), JSON.stringify({
    // 新用户默认：主题跟随系统；模型/凭证由 UI 设置面板写入
    theme: "auto",
}, null, 2));
// models.json：预置火山方舟两个 plan 供应商（完整模型目录；**不带 key** —— 凭据由
// 用户在 Models 面板输入，落 agent 目录 auth.json / env）。同名覆盖 pi-ai 内置项，
// 即使未来 pi-ai 补丁被升级重置，本文件仍完整可用。
fs.writeFileSync(path.join(at, "models.json"), JSON.stringify({
    providers: {
        "ark-agent-plan": { api: "openai-completions", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", models: ARK_CATALOG.agent },
        "ark-coding-plan": { api: "openai-completions", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", models: ARK_CATALOG.coding },
    },
}, null, 2));

/* 6b. 捆绑 Git Bash（bash 工具用；全新用户机器无 Git/WSL，pi 的 bash 会命中 System32 桩失败）
 *     来源：GBA_GITBASH_SRC 或本机 Git for Windows（GPLv2，允许再分发）。仅取 usr/bin。 */
log("捆绑 Git Bash usr/bin …");
const GIT_SRC = process.env.GBA_GITBASH_SRC || "D:/Program Files/Git";
const gitBinSrc = path.join(GIT_SRC, "usr", "bin");
if (fs.existsSync(path.join(gitBinSrc, "bash.exe")) && fs.existsSync(path.join(gitBinSrc, "msys-2.0.dll"))) {
	cp(gitBinSrc, path.join(DEST, "runtime", "gitbash", "usr", "bin"));
	// Git for Windows 的 bash.exe 启动时检查 <gitbash根>/tmp 目录（与 TMP/TEMP 环境变量无关），
	// 缺失则 agent 每次 spawn bash 都打印 "bash.exe: warning: could not find /tmp, please create!"。
	// 完整安装版自带该目录；此处只拷了 usr/bin → 必须手动创建。
	// NSIS resources 通配只匹配文件、不打包空目录 → 放占位文件保证目录进安装包。
	const gitbashTmp = path.join(DEST, "runtime", "gitbash", "tmp");
	fs.mkdirSync(gitbashTmp, { recursive: true });
	fs.writeFileSync(path.join(gitbashTmp, ".keep"), "");
	log(`Git Bash usr/bin → ${path.join(DEST, "runtime", "gitbash", "usr", "bin")}（${fs.readdirSync(path.join(gitBinSrc)).length} 个文件）`);
} else {
	log(`⚠ 未找到 Git Bash（${gitBinSrc}），跳过捆绑——bash 工具在新机器将不可用`);
}

/* 6c. 第三方许可声明（分发改件随附；BSD-3 要求二进制分发附带版权声明，GPL 组件提示见文件内） */
const notices = path.join(ROOT, "THIRD-PARTY-NOTICES.md");
if (fs.existsSync(notices)) {
	fs.copyFileSync(notices, path.join(DEST, "THIRD-PARTY-NOTICES.md"));
	log("THIRD-PARTY-NOTICES.md → payload 根（随安装包分发）");
}

/* 7. 生成 resources 清单（此 tauri-build 版本不通配，逐文件列出）*/
log("生成 resources 清单 …");
const list = [];
const walk = (dir, rel) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const relNext = rel ? rel + "/" + f.name : f.name;
        if (f.isDirectory()) walk(path.join(dir, f.name), relNext);
        else list.push(relNext);
    }
};
walk(DEST, "");
console.log(`[payload] 完成：${list.length} 个文件（${DEST}）`);

// 3. junction 挂回 src-tauri/payload（存在 junction → 先摘除；真实目录 → 报错让人工处理）
const link = path.join(here, "src-tauri", "payload");
try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() || st.isJunction?.()) fs.rmSync(link);
    else fail(`src-tauri/payload 是真实目录，请手动迁移后重试：${link}`);
} catch (e) { if (e.code !== "ENOENT") { if (!String(e).includes("真实目录")) { /* ENOENT → 直接创建 */ } else throw e; } }
const payloadReal = path.join(PAYLOAD_REAL, "payload");
try { fs.symlinkSync(payloadReal, link, "junction"); log(`junction ${link} → ${payloadReal}`); }
catch (e) { log(`junction 创建失败（忽略，resources 用相对路径）: ${e.message}`); }

// 4. tauri.conf.json resources → 相对路径通配（安装布局 <install>/payload/**）
const confPath = path.join(here, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(io.read(confPath));
conf.bundle.resources = ["payload/**/*"];
io.write(confPath, JSON.stringify(conf, null, 2));
log("tauri.conf.json resources → " + conf.bundle.resources[0]);
