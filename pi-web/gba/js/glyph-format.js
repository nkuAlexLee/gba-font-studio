/* glyph-format.js — 11x11 中文字模解码（pokeE 官方索引，单源双端）
 * 浏览器: <script src> → window.GlyphFormat
 * Node:   require() → module.exports
 * 索引公式与字模格式移植自 skill 的 patch-xtreme-chs.js（实证于 EliteRedux/XTREME 注入）：
 *   glyphId = fixHi(hi)*0xF7 + lo（不是 ×256！）
 *   11x11 点阵：16B/字，每行 11bit 顺序打包（MSB first）
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.GlyphFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	/** pokeE 码位高字节修正（0x06/0x1B 为控制字节，非法） */
	function fixHi(hi) {
		if (hi >= 0x01 && hi <= 0x05) return hi - 1;
		if (hi >= 0x07 && hi <= 0x1A) return hi - 2;
		if (hi >= 0x1C && hi <= 0x1E) return hi - 3;
		if (hi === 0x06 || hi === 0x1B) throw new Error('码表码含控制字节 0x' + hi.toString(16));
		return hi;
	}

	/** 码 → 字模序号 */
	function glyphId(code) { return (fixHi(code >> 8) * 0xF7 + (code & 0xFF)) >>> 0; }

	/** 解码 11x11 点阵。fontBytes: Uint8Array；返回 {w:11,h:11,data:Uint8Array}（1=墨 0=空） */
	function decodeGlyph(fontBytes, code) {
		var base = glyphId(code) * 16;
		var g = new Uint8Array(11 * 11);
		for (var r = 0; r < 11; r++) {
			for (var c = 0; c < 11; c++) {
				var bit = r * 11 + c;
				var byte = fontBytes[base + (bit >> 3)] || 0;
				g[r * 11 + c] = (byte >> (7 - (bit & 7))) & 1;
			}
		}
		return { w: 11, h: 11, data: g };
	}

	/** 字库槽位占用（1=有字模 0=空）。返回 Uint8Array，长度 = floor(size/16) */
	function occupancy(fontBytes) {
		var n = Math.floor(fontBytes.length / 16);
		var out = new Uint8Array(n);
		for (var i = 0; i < n; i++) {
			var any = 0;
			for (var j = 0; j < 16; j++) if (fontBytes[i * 16 + j]) { any = 1; break; }
			out[i] = any;
		}
		return out;
	}

	/** 点阵 → 16x16 游戏网格（11x11 居中 row2-12，右下 1px 影=2），返回 16x16 数组的数组 */
	function toGameGrid(mat) {
		var grid = [];
		for (var y = 0; y < 16; y++) grid.push(new Array(16).fill(0));
		for (var r = 0; r < 11; r++) for (var c = 0; c < 11; c++) {
			if (mat[r * 11 + c]) {
				grid[r + 2][c] = 1;
				if (grid[r + 3][c + 1] === 0) grid[r + 3][c + 1] = 2;
			}
		}
		return grid;
	}

	return { fixHi: fixHi, glyphId: glyphId, decodeGlyph: decodeGlyph, occupancy: occupancy, toGameGrid: toGameGrid };
});
