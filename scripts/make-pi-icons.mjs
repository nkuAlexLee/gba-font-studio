#!/usr/bin/env node
/**
 * make-pi-icons.mjs — 生成 Pi Web 图标（艺术字 Π + 卡其色圆角底）
 *
 * 设计：512 画布，卡其色渐变圆角方块，深咖色 Π（圆头笔触，印刷式错位阴影）。
 * Π 为自定义路径（两竖一横，圆头端点），不依赖系统字体，跨机器渲染一致。
 *
 * 产物：
 *   pi-web/public/icons/icon-512.png          PWA 512（圆角、四角透明）
 *   pi-web/public/icons/icon-192.png          PWA 192（同上，缩放）
 *   pi-web/public/icons/apple-touch-icon.png  180 全出血方角（iOS 合成不透明）
 *   pi-web/public/icons/favicon.ico           512 PNG（沿用仓库既有 PNG-as-ico 约定；layout.tsx 显式声明）
 *   app-pure/src-tauri/icons/icon.ico         真·多尺寸 ICO（PNG 内嵌：16/32/48/64/128/256）
 *
 * 用法：node scripts/make-pi-icons.mjs [--out预览目录]（默认直接写上述位置）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIWEB = path.join(ROOT, "pi-web");
const require = createRequire(path.join(PIWEB, "package.json"));
const sharp = require("sharp");

/* ---------- 调色板（卡其色系） ---------- */
const KHAKI_TOP = "#cfbf94";   // 卡其（亮）
const KHAKI_BOT = "#b7a47a";   // 卡其（深）
const KHAKI_SHADOW = "#a5916a"; // 卡其（阴影/错位印）
const INK = "#3a2f22";          // 深咖（Π 主色）

/* ---------- SVG：艺术字 π（小写） ---------- */
// 单笔连写 π（stroke=60 圆头，微斜切）：左腿 → 顶横 → 右腿 → 小回钩。
// 两腿都下探至近基线（右腿略长带小钩），横杠加宽 —— 避免误读为音符。
function piSvg({ rounded = true, size = 512 } = {}) {
	const rx = rounded ? 104 : 0;
	const stroke = 56;
	const letter = (fill) => `
	<g fill="none" stroke="${fill}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
	<path d="M 104 344 Q 120 356 130 296 Q 136 220 129 162 Q 200 150 256 158 Q 330 168 384 154 Q 392 258 380 358" />
	</g>`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${KHAKI_TOP}"/>
			<stop offset="1" stop-color="${KHAKI_BOT}"/>
		</linearGradient>
		<clipPath id="bgclip"><rect x="0" y="0" width="512" height="512" rx="${rx}" ry="${rx}"/></clipPath>
	</defs>
	<rect x="0" y="0" width="512" height="512" rx="${rx}" ry="${rx}" fill="url(#bg)"/>
	<g clip-path="url(#bgclip)">
		<!-- 印刷式错位阴影 -->
		<g transform="translate(10 12)">${letter(KHAKI_SHADOW)}</g>
		<!-- 主体 π -->
		${letter(INK)}
	</g>
</svg>`;
}

/* ---------- 渲染 ---------- */
const MASTER = 1024;
const masterRounded = Buffer.from(piSvg({ rounded: true, size: 512 }));
const masterSquare = Buffer.from(piSvg({ rounded: false, size: 512 }));
const pngRounded = await sharp(masterRounded, { density: 72 * (MASTER / 512) }).png().toBuffer();
const pngSquare = await sharp(masterSquare, { density: 72 * (MASTER / 512) }).png().toBuffer();

const resize = async (buf, n) => await sharp(buf).resize(n, n, { kernel: "lanczos3" }).png().toBuffer();

/* ---------- ICO 组装（全 DIB/BMP 条目） ---------- */
// ⚠ 目录项必须连续紧随 6 字节头之后，随后才是图像数据（曾踩坑：目录项与数据交错 → 结构损坏）。
// ⚠ 条目用 DIB（BITMAPINFOHEADER+XOR+AND）而非 PNG 内嵌 —— tauri-build 经 RC.EXE 嵌入资源，
//    RC.EXE 不支持 PNG 压缩条目（报 Failed to compile resource file）。
function buildIco(dibs) {
	// dibs: [{ size, data }]，data = 完整 DIB（40 字节头 + XOR + AND）
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
const outPreview = process.argv.includes("--preview");
const targets = outPreview
	? [{ p: path.join(ROOT, "tmp", "icon-preview"), files: ["icon-512.png", "icon-192.png", "apple-touch-icon.png", "icon.ico"] }]
	: null;

const writeTargets = async () => {
	const png512 = await resize(pngRounded, 512);
	const png192 = await resize(pngRounded, 192);
	const png180 = await resize(pngSquare, 180); // apple-touch：全出血方角、不透明

	const icoSizes = [16, 24, 32, 48, 64, 128, 256];
	const icoPngs = [];
	for (const n of icoSizes) {
		// 小尺寸直接从矢量按目标密度渲染更锐利；>=128 用母版缩放
		const png = n >= 128
			? await resize(pngRounded, n)
			: await sharp(masterRounded, { density: 72 * (n / 512) }).resize(n, n, { kernel: "lanczos3" }).png().toBuffer();
		const raw = await sharp(png).ensureAlpha().raw().toBuffer();
		icoPngs.push({ size: n, data: rgbaToDib(raw, n) });
	}
	const ico = buildIco(icoPngs);

	const files = {
		"icon-512.png": png512,
		"icon-192.png": png192,
		"apple-touch-icon.png": png180,
		"icon.ico": ico,
	};
	if (outPreview) {
		fs.mkdirSync(targets[0].p, { recursive: true });
		for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(targets[0].p, name), data);
		console.log("[make-pi-icons] 预览输出 →", targets[0].p);
		return;
	}
	fs.writeFileSync(path.join(PIWEB, "public", "icons", "icon-512.png"), png512);
	fs.writeFileSync(path.join(PIWEB, "public", "icons", "icon-192.png"), png192);
	fs.writeFileSync(path.join(PIWEB, "public", "icons", "apple-touch-icon.png"), png180);
	fs.writeFileSync(path.join(PIWEB, "public", "icons", "favicon.ico"), png512); // 沿用仓库 PNG-as-ico 约定
	fs.writeFileSync(path.join(ROOT, "app-pure", "src-tauri", "icons", "icon.ico"), ico);
	console.log("[make-pi-icons] 已写入：public/icons/{icon-512,icon-192,apple-touch-icon}.png、public/icons/favicon.ico、app-pure/src-tauri/icons/icon.ico");
};
await writeTargets();
