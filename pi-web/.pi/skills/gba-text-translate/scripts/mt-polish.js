'use strict';
/**
 * mt-polish.js — 机翻后置校验与自动修复（独立 CLI，与 translate-batch apply 内置逻辑同源）
 *
 *   # 修 report/translations.json（apply 前，就地修复 + 产出重翻清单）
 *     node mt-polish.js --project <目录> --in report/translations.json --write
 *
 *   # 修工程 strings/*.csv 的 mt 列（machine-translated 行）
 *     node mt-polish.js --project <目录> --csv --write
 *
 *   # 只读检查（不写盘）
 *     node mt-polish.js --project <目录> [--in ... | --csv]
 *
 * 修复项:
 *   A1 字符映射（⟦⟧→「」等内置表 + project.json subst.json 合并）
 *   A2 token 对齐（删多余 / 缺失按原文位置比例回插；排版码不参与）
 *   R1 译文中无中文 → 标记 retry（不可自动修复）
 *   R2 残留英文未翻译 → 标记 retry
 *
 * 输出: report/mt-polish-latest.json
 *   { fixed: [{id, fixes}], retry: [{id, reasons}], unfixable: [{id, errs}] }
 *   retry 清单同时写 report/mt-retry.json（[{id, reasons}]，供 agent 定向重翻）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadCharmap, loadSubst } = require('./lib/charmap');
const { autoFixText } = require('./lib/mtfix');
const csv = require('./lib/csv');

function parseArgv(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
			else args[key] = true;
		} else args._.push(a);
	}
	return args;
}

function loadProject(root) {
	const config = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
	for (const k of ['charmap', 'glossary', 'rom']) {
		if (config[k] && !path.isAbsolute(config[k])) config[k] = path.resolve(root, config[k]);
	}
	config.stringsDir = path.join(root, 'strings');
	config.reportDir = path.join(root, 'report');
	return { root, config };
}

function main() {
	const args = parseArgv(process.argv.slice(2));
	const { root, config } = loadProject(args.project || 'translation');
	const charmap = loadCharmap(config.charmap);
	const encOpts = config.encOpts || (config.escPrefix ? { escPrefix: config.escPrefix } : {});
	const subst = loadSubst(path.join(root, 'subst.json'));
	const charFix = Object.assign({}, config.char_fix || {});
	const keepEn = config.keep_en || [];
	const write = !!args.write;

	const fixed = [], retry = [], unfixable = [];
	const seen = new Set();
	const polishOne = (id, en, zh) => {
		if (!zh || seen.has(id)) return null;
		seen.add(id);
		const r = autoFixText(en, zh, { charmap, encOpts, subst, keepEn, charFix });
		if (r.retry.length) { retry.push({ id, reasons: r.retry }); return { zh, noWrite: true }; }
		if (!r.fixes.length && !r.errs.length) return null;
		if (r.errs.length) { unfixable.push({ id, errs: r.errs, afterFixes: r.fixes }); return { zh, noWrite: true }; }
		fixed.push({ id, fixes: r.fixes });
		return { zh: r.text };
	};

	if (args.in) {
		// 模式 A：修 translations.json（apply 前预修）
		const inPath = path.resolve(args.in);
		const arr = JSON.parse(fs.readFileSync(inPath, 'utf8'));
		// codes 回查（与 translate-batch apply 同源），用于后续 apply 的占位符还原
		let dirty = false;
		for (const t of arr) {
			const row = polishOne(t.id, t.en || '', typeof t === 'string' ? t : t.zh);
			if (row && !row.noWrite && row.zh !== t.zh) { t.zh = row.zh; dirty = true; }
		}
		if (write && dirty) fs.writeFileSync(inPath, JSON.stringify(arr, null, 2));
		console.log(`[mt-polish] translations.json: 可修 ${fixed.length} | 需重翻 ${retry.length} | 不可修 ${unfixable.length}${dirty ? '（已写回）' : '（--write 写回）'}`);
	} else {
		// 模式 B：修 strings/*.csv 的 mt 列（machine-translated 行）
		const files = args.scene
			? [path.join(config.stringsDir, args.scene + '.csv')]
			: fs.readdirSync(config.stringsDir).filter(f => f.endsWith('.csv')).map(f => path.join(config.stringsDir, f));
		for (const f of files) {
			if (!fs.existsSync(f)) continue;
			const rows = csv.readObjects(f);
			let dirty = false;
			for (const row of rows) {
				if (row.status !== 'machine-translated' || !row.mt) continue;
				const r = polishOne(row.id, row.en, row.mt);
				if (r && !r.noWrite && r.zh !== row.mt) { row.mt = r.zh; dirty = true; }
			}
			if (write && dirty) csv.writeObjects(f, rows, []);
		}
		console.log(`[mt-polish] strings/*.csv: 可修 ${fixed.length} | 需重翻 ${retry.length} | 不可修 ${unfixable.length}${write ? '（已写回）' : '（--write 写回）'}`);
	}

	const report = { fixed, retry, unfixable };
	fs.mkdirSync(config.reportDir, { recursive: true });
	fs.writeFileSync(path.join(config.reportDir, 'mt-polish-latest.json'), JSON.stringify(report, null, 2));
	fs.writeFileSync(path.join(config.reportDir, 'mt-retry.json'), JSON.stringify(retry, null, 2));
	if (fixed.length) fixed.slice(0, 8).forEach(f => console.log(`  ✔ ${f.id}: ${f.fixes.join('; ')}`));
	if (retry.length) {
		console.log(`  ↻ 需重翻 ${retry.length} 条（原因），清单 → report/mt-retry.json`);
		retry.slice(0, 5).forEach(r => console.log(`    ${r.id}: ${r.reasons.join('; ')}`));
	}
	if (unfixable.length) {
		console.log(`  ✘ 不可自动修 ${unfixable.length} 条`);
		unfixable.slice(0, 5).forEach(u => console.log(`    ${u.id}: ${u.errs.join('; ')}`));
	}
	console.log('下一步: ' + (retry.length
		? '按 report/mt-retry.json 定向重翻后重跑 apply；'
		: '') + '其余条目可直接 translate-batch apply / insert-strings');
}

main();
