'use strict';
/**
 * mtfix.js — 机翻后置校验与自动修复（P0-②，源自红龙传说会话复盘）
 *
 * 在 translate-batch apply / mt-polish 中对机翻译文做三层自动处理：
 *   1) 码表外字符映射：内置常见错用字符替换（⟦⟧→「」等），剩余 unknown 报告
 *   2) 控制码 token 对齐：译文中多余 token 删除；缺失 token 按原文位置比例回插
 *      （排版码 [/n][/l][/p] 不参与对比——由 wrapText 自动重排）
 *   3) 质量门槛检测（不可自动修复，只标记 retry）：
 *      - 译文中无中文（LLM 返回原文）
 *      - 残留英文未翻译（与原文共有 ≥4 字母词）
 *
 * 项目级开关：project.json "mtAutoFix": true（默认开）；CLI --no-auto-fix 关闭。
 */
const { encode, normalizeText, describeUnknown } = require('./charmap');

/** 内置字符修复表：机翻高频错用 → 码表内安全字符 */
const DEFAULT_CHAR_FIX = {
	'⟦': '「', '⟧': '」',
	'⟪': '《', '⟫': '》',
	'〖': '「', '〗': '」',
	'『': '「', '』': '」',
	'—': '-', '–': '-', '−': '-',
	'…': '..', '⋯': '..',
	'　': ' ',   // 全角空格
	'银': '银',
};

const LAYOUT = new Set(['[/n]', '[/l]', '[/p]']);
const TOKEN_RE = /\[[^\]]*\]|\{[^}]*\}/g;

function extractTokens(text) {
	return (text || '').match(TOKEN_RE) || [];
}
function sigTokens(text) {
	return extractTokens(text).filter(x => !LAYOUT.has(x)).sort().join('|');
}

/** 带位置提取 token：[{ token, frac }]（frac = 在原文中的相对位置 0~1） */
function tokensWithPos(text) {
	const out = [];
	let idx = 0;
	for (const m of String(text || '').matchAll(TOKEN_RE)) {
		const before = m.input.slice(0, m.index);
		// 位置按"非 token 字符流"计算，避免 token 长度干扰
		const cleanBefore = before.replace(TOKEN_RE, '');
		idx = cleanBefore.length;
		const total = text.replace(TOKEN_RE, '').length || 1;
		out.push({ token: m[0], frac: Math.min(1, idx / total) });
	}
	return out;
}

function stripTokens(text) {
	return (text || '').replace(TOKEN_RE, '');
}

/** 多重集差：a 有 b 无（按计数） */
function multisetDiff(a, b) {
	const cnt = new Map();
	for (const x of a) cnt.set(x, (cnt.get(x) || 0) + 1);
	for (const x of b) cnt.set(x, (cnt.get(x) || 0) - 1);
	const out = [];
	for (const [x, n] of cnt) for (let i = 0; i < n; i++) out.push(x);
	return out;
}

/** 按位置比例把缺失 token 插回译文（保持原文 token 顺序） */
function insertMissing(zh, en) {
	const enTok = tokensWithPos(en).filter(t => !LAYOUT.has(t.token));
	const zhTok = extractTokens(zh).filter(t => !LAYOUT.has(t));
	const missing = multisetDiff(enTok.map(t => t.token), zhTok);
	if (!missing.length) return { text: zh, inserted: 0 };
	// 按原文出现顺序逐个插回
	const ordered = [];
	const pool = new Map();
	for (const t of missing) pool.set(t, (pool.get(t) || 0) + 1);
	for (const { token, frac } of enTok) {
		const n = pool.get(token) || 0;
		for (let i = 0; i < n; i++) ordered.push({ token, frac });
		pool.delete(token);
	}
	let text = zh;
	for (const { token, frac } of ordered) {
		const clean = stripTokens(text);
		const pos = Math.max(0, Math.min(clean.length, Math.round(frac * clean.length)));
		// 在干净文本上找插入点，再映射回原文位置（逐段跳过 token）
		let rawPos = 0, cleanIdx = 0, last = 0;
		for (const m of String(text).matchAll(TOKEN_RE)) {
			const seg = text.slice(last, m.index);
			if (cleanIdx + seg.length >= pos) { rawPos = last + (pos - cleanIdx); break; }
			cleanIdx += seg.length; last = m.index + m[0].length;
			rawPos = m.index + m[0].length;
		}
		if (cleanIdx < pos) rawPos = last + (pos - cleanIdx);
		text = text.slice(0, rawPos) + token + text.slice(rawPos);
	}
	return { text, inserted: ordered.length };
}

function removeExtra(zh, en) {
	const extra = multisetDiff(extractTokens(zh).filter(t => !LAYOUT.has(t)),
		extractTokens(en).filter(t => !LAYOUT.has(t)));
	if (!extra.length) return { text: zh, removed: 0 };
	let text = zh;
	for (const t of extra) {
		const i = text.indexOf(t);
		if (i >= 0) text = text.slice(0, i) + text.slice(i + t.length);
	}
	return { text, removed: extra.length };
}

/** 残留英文检测（与 validate H5 / apply 门禁同规则） */
function leftoverEnglish(en, zh, keepEn) {
	const strip = t => {
		let s = (t || '').replace(TOKEN_RE, ' ');
		for (const k of keepEn || []) s = s.split(k).join(' ');
		return s;
	};
	const enWords = new Set((strip(en).match(/[A-Za-z]{4,}/g) || []).map(w => w.toLowerCase()));
	const zhWords = new Set((strip(zh).match(/[A-Za-z]{4,}/g) || []).map(w => w.toLowerCase()));
	return [...zhWords].filter(w => enWords.has(w));
}

/**
 * 自动修复单条译文。
 * @returns {{ text, fixes: string[], retry: string[], errs: string[] }}
 *   text    修复后译文（retry 类不改动文本）
 *   fixes   已应用的自动修复描述
 *   retry   需要重新机翻的原因（不可自动修复）
 *   errs    修复后仍存在的硬错误（交给调用方门禁）
 */
function autoFixText(en, zh, opts = {}) {
	const { charmap, encOpts, subst, keepEn, charFix } = opts;
	const fixes = [], retry = [];
	let text = String(zh || '');

	// 1) 字符映射修复
	if (charmap) {
		const map = Object.assign({}, DEFAULT_CHAR_FIX, charFix || {});
		let hit = 0;
		for (const [bad, good] of Object.entries(map)) {
			if (text.includes(bad)) {
				// 仅当目标字符可编码时替换（否则换汤不换药）
				const probe = encode(good, charmap, encOpts || {});
				if (!probe.unknown.length) {
					hit += text.split(bad).length - 1;
					text = text.split(bad).join(good);
				}
			}
		}
		if (hit) fixes.push(`字符映射 ×${hit}`);
	}

	// 2) token 对齐：先删多余，再按位置插回缺失
	const r = removeExtra(text, en);
	if (r.removed) { text = r.text; fixes.push(`删除多余 token ×${r.removed}`); }
	const ins = insertMissing(text, en);
	if (ins.inserted) { text = ins.text; fixes.push(`回插缺失 token ×${ins.inserted}`); }

	// 3) 质量门槛（不可自动修复 → retry）
	const hasEnglishWords = /[A-Za-z]{2,}/.test((en || '').replace(TOKEN_RE, ''));
	const zhChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
	if (hasEnglishWords && zhChars === 0) retry.push('译文中无中文（疑似返回原文）');
	const leftover = leftoverEnglish(en, text, keepEn);
	if (leftover.length) retry.push('残留英文未翻译: ' + leftover.join(' '));
	if (retry.length) text = String(zh || ''); // retry 时不采用修复结果，保留原译供重翻参考

	// 4) 修复后残余硬错误（码表外字符等 → 门禁处理）
	const errs = [];
	if (charmap) {
		const { text: norm } = normalizeText(text, charmap, subst);
		const { unknown } = encode(norm, charmap, encOpts || {});
		if (unknown.length) errs.push('码表外内容: ' + describeUnknown(unknown));
	}
	if (sigTokens(text) !== sigTokens(en)) errs.push(`token 不一致 原[${sigTokens(en)}] 译[${sigTokens(text)}]`);
	return { text, fixes, retry, errs };
}

module.exports = { DEFAULT_CHAR_FIX, autoFixText, extractTokens, sigTokens, insertMissing, removeExtra, leftoverEnglish };
