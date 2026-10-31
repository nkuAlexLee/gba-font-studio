#!/usr/bin/env node
/**
 * build-payload.mjs — 组装 Pi Web 桌面端（纯净版）payload（src-tauri/payload/）
 *
 * 纯净版 = 同仓库 GBA Font Studio 客户端去掉 GBA 部分：
 *   ✗ 不含 payload/gba/ 引擎（romctl/模拟器/翻译流水线，~200MB）
 *   ✗ 不含 workspace-template 的 .pi/（gba-font-crack / gba-text-translate skill 与 gba-fontpatch 扩展）
 *   ✗ 不含 roms/ 预置 ROM；public/gba-studio 前端资源也不进包
 *   ✓ pi-web 运行时（.next 生产构建 + 精简 node_modules + public + 配置）
 *   ✓ payload/runtime/node.exe + 捆绑 Git Bash（bash 工具在新机器可用，与 GBA 无关）
 *   ✓ agent-template（settings.json + models.json 预置 ark plan 供应商）
 *   ✓ workspace-template：通用 AGENTS.md + projects/ + work/
 *
 * 构建期配套（见 scripts/build-desktop.mjs --pure 与根目录 AGENTS.md）：
 *   - pi-web 用 NEXT_PUBLIC_GBA_STUDIO=0 构建 → UI 不渲染 GBA 工作台入口
 *   - pi-web 用 NEXT_DIST_DIR=.next-pure 构建 → 与 GBA 产品 .next 互不覆盖
 *   - 运行时 lib.rs 置 GBA_STUDIO=0 → instrumentation 彻底跳过 romctl 自动拉起
 *
 * payload 落短路径 D:/gbfp-pure（NSIS 对 >260 字符的源路径会失败），junction 挂回
 * app-pure/src-tauri/payload；resources 用相对路径通配 payload 目录全量。
 *
 * 用法: node build-payload.mjs [--skip-prune] [--skip-node-modules] [--skip-next-build]
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
// ⚠️ 绝对路径 resources 会被 Tauri 安装到 _root_/<盘符路径> 嵌套布局，bootstrap 探测不到（GBA 版 2026-09-08 教训）
// ⚠️ 与 GBA 产品的 D:/gbfp 完全分离，两变体 payload 互不覆盖（双写者纪律：同一 payload 目录
//     同时只允许一个组装/打包过程写入）
const PAYLOAD_REAL = path.resolve(process.env.PIWEB_PAYLOAD_DIR || process.env.GBA_PAYLOAD_DIR || "D:/gbfp-pure");
const DEST = path.join(PAYLOAD_REAL, "payload");
const NODE_SRC = "E:/Program Files/nodejs/node.exe";
// pi-web 构建产物目录（纯净版构建走 NEXT_DIST_DIR=.next-pure，与 GBA 产品 .next 分离）
const NEXT_DIST = process.env.NEXT_DIST_DIR || ".next-pure";

const log = (...a) => console.log("[payload-pure]", ...a);
const fail = (m) => { console.error("[payload-pure] ✘", m); process.exit(1); };
const io = { read: (p) => fs.readFileSync(p, "utf8"), write: (p, c) => fs.writeFileSync(p, c) };
const cp = (src, dst, opts = {}) => {
    fs.cpSync(src, dst, { recursive: true, dereference: false, verbatimSymlinks: false, ...opts });
};
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

/* 0. 前置检查 */
if (!fs.existsSync(path.join(PIWEB, NEXT_DIST, "BUILD_ID"))) {
    fail(`pi-web/${NEXT_DIST} 缺生产构建 — 用 scripts/build-desktop.mjs --pure 或：\n` +
         `      NEXT_PUBLIC_GBA_STUDIO=0 NEXT_DIST_DIR=${NEXT_DIST} npx next build（pi-web 目录）`);
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
if (!fs.existsSync(path.join(PIWEB, NEXT_DIST, "BUILD_ID"))) fail(`pi-web/${NEXT_DIST} 缺生产构建`);
cp(path.join(PIWEB, NEXT_DIST), path.join(pw, ".next"));
// .next 内的 dev 残留/cache 不进安装包（NSIS 对超长路径会失败）
for (const junk of [".next/dev", ".next/cache"]) rm(path.join(pw, junk));
// public：剔除 gba-studio 前端资源（纯净版无 GBA 工作台）
cp(path.join(PIWEB, "public"), path.join(pw, "public"), { filter: (src) => {
    const rel = path.relative(path.join(PIWEB, "public"), src);
    const top = rel.split(path.sep)[0];
    return top !== "gba-studio";
} });
rm(path.join(pw, "public", "gba-studio"));

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
log("深路径瘦身（剔除 dist-types/*.d.ts/*.map）…");
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

/* 2c. 缩短 Turbopack 外部包 shim 目录名 + 全局改写引用（纯净版特有，解决 NSIS MAX_PATH）
 *     .next/node_modules/<pkg>-<16hash>/ 是整包镜像（pi-coding-agent 达 366MB），内部深层依赖
 *     （如 @smithy/core/dist-cjs/submodules/.../*.js）经 junction 读到的完整路径达 261 字符，
 *     超过 makensis 的 MAX_PATH 限制（本仓库 app-pure 路径已 60 字符前缀；GBA 版 55 前缀
 *     侥幸通过）。方案：把 shim 改名为短别名（xp1…），并替换 .next 内全部文本引用
 *     （server chunks / nft.json 清单中的 require/import/路径字符串）。分辨率不受影响：
 *     Node 沿父目录链查 node_modules，.next/node_modules/xp1 一样可达；子路径导入
 *     （xp1/rpc-entry）仅替换名称前缀，保留子路径。 */
log("缩短 .next shim 目录名并改写引用 …");
{
	const nmDir = path.join(pw, ".next", "node_modules");
	const renames = []; // [oldFullName, newAlias]
	if (fs.existsSync(nmDir)) {
		let aliasIdx = 0;
		const entries = fs.readdirSync(nmDir, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			if (e.name.startsWith("@")) {
				// 作用域包：<scope>/<pkg>-<hash> → 整体迁出作用域目录
				for (const sub of fs.readdirSync(path.join(nmDir, e.name), { withFileTypes: true })) {
					if (sub.isDirectory() && /-[0-9a-f]{16}$/.test(sub.name)) {
						aliasIdx += 1;
						const oldFullName = `${e.name}/${sub.name}`;
						const alias = `xp${aliasIdx}`;
						fs.renameSync(path.join(nmDir, e.name, sub.name), path.join(nmDir, alias));
						renames.push([oldFullName, alias]);
					}
				}
			} else if (/-[0-9a-f]{16}$/.test(e.name)) {
				aliasIdx += 1;
				const alias = `xp${aliasIdx}`;
				fs.renameSync(path.join(nmDir, e.name), path.join(nmDir, alias));
				renames.push([e.name, alias]);
			}
		}
		// 作用域目录空则删
		for (const e of entries) {
			if (e.name.startsWith("@")) {
				const sp = path.join(nmDir, e.name);
				if (fs.existsSync(sp) && fs.readdirSync(sp).length === 0) fs.rmdirSync(sp);
			}
		}
	}
	if (renames.length) {
		log("  shim 重命名: " + renames.map(([o, n]) => `${o} → ${n}`).join(", "));
		// 全局替换 .next 内文本引用（跳过 shim 自身内容与 cache/dev）
		const skipDirs = new Set(renames.map(([, a]) => path.join(nmDir, a)));
		const exts = new Set([".js", ".mjs", ".cjs", ".json"]);
		let filesChanged = 0;
		const rewrite = (dir) => {
			let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const e of es) {
				const fp = path.join(dir, e.name);
				if (e.isDirectory()) {
					if (skipDirs.has(fp) || e.name === "cache" || e.name === "dev") continue;
					rewrite(fp);
				} else if (exts.has(path.extname(e.name))) {
					let st; try { st = fs.statSync(fp); } catch { continue; }
					if (st.size > 64 * 1024 * 1024) continue;
					let text; try { text = fs.readFileSync(fp, "utf8"); } catch { continue; } // 二进制 → 跳过
					let changed = false;
					for (const [oldName, alias] of renames) {
						if (text.includes(oldName)) { text = text.split(oldName).join(alias); changed = true; }
					}
					if (changed) { fs.writeFileSync(fp, text); filesChanged += 1; }
				}
			}
		};
		rewrite(path.join(pw, ".next"));
		log(`  引用改写完成（${filesChanged} 个文件）`);
		// 自检：.next 内不应再出现旧名
		for (const [oldName] of renames) {
			let found = false;
			const scan = (dir) => {
				if (found) return;
				let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
				for (const e of es) {
					const fp = path.join(dir, e.name);
					if (e.isDirectory()) { if (!skipDirs.has(fp)) scan(fp); }
					else if (exts.has(path.extname(e.name))) {
						try { if (fs.readFileSync(fp, "utf8").includes(oldName)) { found = true; console.error("    仍引用旧名: " + fp); } } catch { /* ignore */ }
					}
				}
			};
			scan(path.join(pw, ".next"));
			if (found) fail(".next 内仍存在旧 shim 名引用: " + oldName);
		}
	}
}

// prune 后自检：next 与 pi-coding-agent 必须还在（shim 别名化后真身仍在顶层 node_modules）
for (const must of ["node_modules/next/dist/bin/next", "node_modules/@earendil-works/pi-coding-agent/package.json", "node_modules/node-pty"]) {
    if (!fs.existsSync(path.join(pw, must))) fail(`prune 后缺失关键依赖: ${must}`);
}

/* 2c. 纯净版自检：payload 内不允许出现 GBA 引擎/前端资源 */
for (const banned of ["gba", "pi-web/public/gba-studio", "workspace-template/roms", "workspace-template/.pi"]) {
    if (fs.existsSync(path.join(DEST, banned))) fail(`纯净版 payload 不应包含: ${banned}`);
}
log("纯净版自检通过（无 GBA 引擎/前端/预置 ROM/GBA skill 扩展）✓");

/* 3. node 运行时 */
log("复制 node.exe …");
fs.mkdirSync(path.join(DEST, "runtime"), { recursive: true });
fs.copyFileSync(NODE_SRC, path.join(DEST, "runtime", "node.exe"));

/* 4. workspace 模板（首启复制到安装路径 data/workspace）*/
log("组装 workspace-template（通用 AGENTS.md + projects + work）…");
const ws = path.join(DEST, "workspace-template");
fs.mkdirSync(path.join(ws, "projects"), { recursive: true });
fs.mkdirSync(path.join(ws, "work"), { recursive: true });
fs.writeFileSync(path.join(ws, "AGENTS.md"), `# Pi Web 工作区

你是 pi coding agent，运行在 Pi Web 桌面客户端内，工作目录为本工作区。

## 环境与约定
- 本工作区是你的默认 cwd：新建文件/工程默认放在这里（projects/、work/ 或按需创建子目录）。
- Windows 环境：bash 工具 = 客户端捆绑的 Git Bash（payload/runtime/gitbash），**不是** WSL；
  PATH 已前置 /usr/bin，ls/grep/sed/awk/head/tail/find 可用。无 xxd，二进制查看用
  od -A x -t x1z 或 node -e。
- 二进制/文本处理优先 node -e（node 在 PATH）；批处理脚本先写入文件再执行（heredoc 转义易错）。
- PowerShell 可经 \`powershell.exe -NoProfile -Command "...\` 调用。

## 能力
- 全部 pi 原生工具（读写文件、bash、子代理、skills 等）照常可用。
- 用户可在工作台 设置 → Skills / Plugins 面板自行安装扩展与技能。
`);
fs.writeFileSync(path.join(ws, "projects", "README.md"),
    "# 工程目录\n\n按项目/主题建子目录组织产出；agent 会按需创建。\n");
fs.writeFileSync(path.join(ws, "work", "README.md"),
    "# 运行产物\n\n脚手架脚本、日志、临时产物等。\n");

/* 5. agent 模板（PI_CODING_AGENT_DIR 骨架）*/
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

/* 5b. 捆绑 Git Bash（bash 工具用；全新用户机器无 Git/WSL，pi 的 bash 会命中 System32 桩失败）
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

/* 6. 第三方许可声明（分发改件随附；BSD-3 要求二进制分发附带版权声明，GPL 组件提示见文件内） */
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
console.log(`[payload-pure] 完成：${list.length} 个文件（${DEST}）`);

// 8. junction 挂回 app-pure/src-tauri/payload（存在 junction → 先摘除；真实目录 → 报错让人工处理）
const link = path.join(here, "src-tauri", "payload");
try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() || st.isJunction?.()) fs.rmSync(link);
    else fail(`src-tauri/payload 是真实目录，请手动迁移后重试：${link}`);
} catch (e) { if (e.code !== "ENOENT") { if (!String(e).includes("真实目录")) { /* ENOENT → 直接创建 */ } else throw e; } }
const payloadReal = path.join(PAYLOAD_REAL, "payload");
try { fs.symlinkSync(payloadReal, link, "junction"); log(`junction ${link} → ${payloadReal}`); }
catch (e) { log(`junction 创建失败（忽略，resources 用相对路径）: ${e.message}`); }

// 9. tauri.conf.json resources → 相对路径字符串形式（安装布局 <install>/payload/**）。
//    ⚠️ 曾试验 map 形式（绝对短路径源 → 显式 target）—— tauri 2.12 会把每个匹配文件压平为
//    target/<basename>，31k 文件互相覆盖，产物全毁；字符串形式的深层文件已由 2c 步骤
//    （shim 目录别名化）缩短到 MAX_PATH 内，junction 正常挂回 src-tauri/payload。
const confPath = path.join(here, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(io.read(confPath));
conf.bundle.resources = ["payload/**/*"];
io.write(confPath, JSON.stringify(conf, null, 2));
log("tauri.conf.json resources → " + conf.bundle.resources[0]);
