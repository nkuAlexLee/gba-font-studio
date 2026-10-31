#!/usr/bin/env node
/**
 * make-gba-icons.mjs — 生成 GBA Font Studio 客户端图标（精灵球风：圆角矩形红白球）
 *
 * 设计：512 画布，圆角矩形（rx 118）整块即球体 —— 上半红、下半白、
 * 中间深色分割带 + 中央按钮。纯矢量绘制，不依赖字体/位图，小尺寸可直接按密度重渲染。
 *
 * 产物（对应 pi-web 侧：NEXT_PUBLIC_GBA_STUDIO !== "0" 时选用 /icons/gba/*）：
 *   app/src-tauri/icons/icon.ico                  真·多尺寸 ICO（DIB：16/24/32/48/64/128/256）
 *   pi-web/public/icons/gba/icon-512.png          PWA 512（圆角、四角透明）
 *   pi-web/public/icons/gba/icon-192.png          PWA 192（同上，缩放）
 *   pi-web/public/icons/gba/apple-touch-icon.png  180 全出血方角（iOS 合成不透明）
 *   pi-web/public/icons/gba/favicon.ico           512 PNG（沿用仓库既有 PNG-as-ico 约定）
 *
 * 用法：
 *   node scripts/make-gba-icons.mjs             # 直接写入上述位置
 *   node scripts/make-gba-icons.mjs --preview   # 只输出预览到 tmp/icon-preview/
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIWEB = path.join(ROOT, "pi-web");
const require = createRequire(path.join(PIWEB, "package.json"));
const sharp = require("sharp");

/* ---------- 调色板 ---------- */
const RED_TOP = "#ff6f5e";
const RED_MID = "#e63a2c";
const RED_BOT = "#bf1f16";
const WHITE_TOP = "#ffffff";
const WHITE_BOT = "#d9dde3";
const BAND_TOP = "#3d4046";
const BAND_BOT = "#16171b";

/* ---------- SVG：圆角矩形精灵球 ---------- */
// 坐标：512 画布，tile 16..496（480 见方，rx 118）；球心 (256, 256)。
const BAND_Y = 232;
const BAND_H = 48;

function ballSvg({ size = 512, rounded = true, bleed = false } = {}) {
	// bleed：整块铺满画布（apple-touch 用，避免透明边被 iOS 合成成黑边）
	const x = bleed ? 0 : 16;
	const side = bleed ? 512 : 480;
	const rx = rounded ? 118 : 0;
	const bandY = BAND_Y;
	const bandBottom = BAND_Y + BAND_H;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
	<defs>
		<clipPath id="tile"><rect x="${x}" y="${x}" width="${side}" height="${side}" rx="${rx}" ry="${rx}"/></clipPath>
		<linearGradient id="red" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${RED_TOP}"/>
			<stop offset="0.55" stop-color="${RED_MID}"/>
			<stop offset="1" stop-color="${RED_BOT}"/>
		</linearGradient>
		<linearGradient id="white" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${WHITE_TOP}"/>
			<stop offset="1" stop-color="${WHITE_BOT}"/>
		</linearGradient>
		<linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${BAND_TOP}"/>
			<stop offset="1" stop-color="${BAND_BOT}"/>
		</linearGradient>
		<linearGradient id="btn" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#ffffff"/>
			<stop offset="1" stop-color="#e2e5ea"/>
		</linearGradient>
		<radialGradient id="gloss" cx="0.3" cy="0.16" r="0.62">
			<stop offset="0" stop-color="#ffffff" stop-opacity="0.45"/>
			<stop offset="0.6" stop-color="#ffffff" stop-opacity="0.08"/>
			<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
		</radialGradient>
	</defs>
	<g clip-path="url(#tile)">
		<!-- 上半：红 -->
		<rect x="${x}" y="${x}" width="${side}" height="${bandY - x}" fill="url(#red)"/>
		<!-- 下半：白 -->
		<rect x="${x}" y="${bandBottom}" width="${side}" height="${x + side - bandBottom}" fill="url(#white)"/>
		<!-- 分割带 -->
		<rect x="${x}" y="${bandY}" width="${side}" height="${BAND_H}" fill="url(#band)"/>
		<!-- 红面高光 -->
		<ellipse cx="200" cy="130" rx="200" ry="150" fill="url(#gloss)"/>
		<!-- 中央按钮：深色外环 → 白面 → 细灰圈 -->
		<circle cx="256" cy="256" r="66" fill="url(#band)"/>
		<circle cx="256" cy="256" r="50" fill="url(#btn)"/>
		<circle cx="256" cy="256" r="50" fill="none" stroke="#b9bec6" stroke-width="4"/>
		<circle cx="256" cy="256" r="30" fill="none" stroke="#e1e4e9" stroke-width="4"/>
	</g>
	<!-- 外描边（内外各一条，保证浅底上也立得住） -->
	<rect x="${x}" y="${x}" width="${side}" height="${side}" rx="${rx}" ry="${rx}" fill="none" stroke="#000000" stroke-opacity="0.22" stroke-width="10"/>
	${bleed ? "" : `<rect x="21" y="21" width="470" height="470" rx="113" ry="113" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="4"/>`}
</svg>`;
}

/* ---------- 渲染 ---------- */
const MASTER = 1024;
const master = Buffer.from(ballSvg({ size: 512 }));
const pngMaster = await sharp(master, { density: 72 * (MASTER / 512) }).png().toBuffer();
const resize = async (buf, n) => await sharp(buf).resize(n, n, { kernel: "lanczos3" }).png().toBuffer();

/* ---------- ICO 组装（全 DIB/BMP 条目） ---------- */
// ⚠ 目录项必须连续紧随 6 字节头之后，随后才是图像数据（曾踩坑：目录项与数据交错 → 结构损坏）。
// ⚠ 条目用 DIB（BITMAPINFOHEADER+XOR+AND）而非 PNG 内嵌 —— tauri-build 经 RC.EXE 嵌入资源，
//   RC.EXE 不支持 PNG 压缩条目（报 Failed to compile resource file）。
function buildIco(dibs) {
	const count = dibs.length;
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(count, 4);
	const dir = [];
	const datas = [];
	let offset = 6 + 16 * count;
	for (const { size, data } of dibs) {
		const e = Buffer.alloc(16);
		e.writeUInt8(size >= 256 ? 0 : size, 0);
		e.writeUInt8(size >= 256 ? 0 : size, 1);
		e.writeUInt8(0, 2); // palette
		e.writeUInt8(0, 3); // reserved
		e.writeUInt16LE(1, 4); // planes
		e.writeUInt16LE(32, 6); // bpp
		e.writeUInt32LE(data.length, 8);
		e.writeUInt32LE(offset, 12);
		dir.push(e);
		datas.push(data);
		offset += data.length;
	}
	return Buffer.concat([header, ...dir, ...datas]);
}

// RGBA(top-down) → ICO DIB 条目：BITMAPINFOHEADER(40) + XOR(BGRA 自下而上) + AND(1bpp 自下而上)
function rgbaToDib(raw, n) {
	const xorStride = n * 4;
	const andStride = Math.ceil(n / 32) * 4; // 1bpp 行按 32bit 对齐
	const xorSize = xorStride * n;
	const andSize = andStride * n;
	const dib = Buffer.alloc(40 + xorSize + andSize);
	dib.writeUInt32LE(40, 0); // biSize
	dib.writeInt32LE(n, 4); // biWidth
	dib.writeInt32LE(n * 2, 8); // biHeight = XOR+AND 两倍高
	dib.writeUInt16LE(1, 12); // biPlanes
	dib.writeUInt16LE(32, 14); // biBitCount
	dib.writeUInt32LE(0, 16); // biCompression = BI_RGB
	dib.writeUInt32LE(xorSize + andSize, 20); // biSizeImage
	for (let row = 0; row < n; row++) {
		const srcY = n - 1 - row; // 自下而上
		for (let x = 0; x < n; x++) {
			const s = (srcY * n + x) * 4;
			const d = 40 + row * xorStride + x * 4;
			dib[d] = raw[s + 2]; // B
			dib[d + 1] = raw[s + 1]; // G
			dib[d + 2] = raw[s]; // R
			dib[d + 3] = raw[s + 3]; // A
			// AND 掩码：alpha=0 → 1（透明）；MSB = 最左像素
			if (raw[s + 3] === 0) {
				const byte = 40 + xorSize + row * andStride + (x >> 3);
				dib[byte] |= 0x80 >> (x & 7);
			}
		}
	}
	return dib;
}

/* ---------- 输出 ---------- */
const preview = process.argv.includes("--preview");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const buildIcoFile = async () => {
	const entries = [];
	for (const n of ICO_SIZES) {
		// 小尺寸直接从矢量按目标密度渲染更锐利；>=128 用母版缩放
		const png = n >= 128
			? await resize(pngMaster, n)
			: await sharp(master, { density: 72 * (n / 512) }).resize(n, n, { kernel: "lanczos3" }).png().toBuffer();
		const raw = await sharp(png).ensureAlpha().raw().toBuffer();
		entries.push({ size: n, data: rgbaToDib(raw, n) });
	}
	return buildIco(entries);
};

const ico = await buildIcoFile();
const png512 = await resize(pngMaster, 512);

// 全出血母版（apple-touch-icon）：iOS 会自己裁圆角，透明边会被合成成黑/白边
const bleedMaster = Buffer.from(ballSvg({ size: 512, rounded: false, bleed: true }));
const pngBleedMaster = await sharp(bleedMaster, { density: 72 * (MASTER / 512) }).png().toBuffer();

const WEB_DIR = path.join(PIWEB, "public", "icons", "gba");

if (preview) {
	const dir = path.join(ROOT, "tmp", "icon-preview");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "gba-icon-512.png"), png512);
	fs.writeFileSync(path.join(dir, "gba-icon.ico"), ico);
	fs.writeFileSync(path.join(dir, "gba-apple-touch-180.png"), await resize(pngBleedMaster, 180));
	for (const n of [16, 32, 48]) {
		const png = await sharp(master, { density: 72 * (n / 512) }).resize(n, n, { kernel: "lanczos3" }).png().toBuffer();
		fs.writeFileSync(path.join(dir, `gba-icon-${n}.png`), png);
	}
	console.log("[make-gba-icons] 预览输出 →", dir);
} else {
	fs.writeFileSync(path.join(ROOT, "app", "src-tauri", "icons", "icon.ico"), ico);
	console.log("[make-gba-icons] 已写入：app/src-tauri/icons/icon.ico（" + ICO_SIZES.join("/") + " DIB 条目）");

	fs.mkdirSync(WEB_DIR, { recursive: true });
	fs.writeFileSync(path.join(WEB_DIR, "icon-512.png"), png512);
	fs.writeFileSync(path.join(WEB_DIR, "icon-192.png"), await resize(pngMaster, 192));
	fs.writeFileSync(path.join(WEB_DIR, "apple-touch-icon.png"), await resize(pngBleedMaster, 180));
	// 仓库既有约定：favicon.ico 内容就是 512 PNG（浏览器按 magic 识别）
	fs.writeFileSync(path.join(WEB_DIR, "favicon.ico"), png512);
	console.log("[make-gba-icons] 已写入：pi-web/public/icons/gba/{icon-512,icon-192,apple-touch-icon}.png + favicon.ico");
}
