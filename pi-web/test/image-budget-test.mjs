/**
 * image-budget 扩展单测：只测纯逻辑（预算规划 / 图片收集 / 字节估算 / 压缩降级），
 * 不依赖 pi 运行时，也不修改任何会话文件。
 *
 * 运行：cd pi-web && node --experimental-strip-types --test test/image-budget-test.mjs
 */
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { collectImages, placeholderText, planImageBudget, shrinkImage, textBytes } from "../.pi/extensions/image-budget.ts";

// 单测跑时不许写进真实 agent 目录（默认日志路径在那里）
process.env.PI_IMAGE_BUDGET_LOG = "";

const KiB = 1024;
const MiB = 1024 * 1024;

function budget(over = {}) {
	return {
		off: false,
		budget: 48 * MiB,
		keep: 6,
		maxCount: 30,
		shrink: true,
		shrinkEdge: 1280,
		shrinkKb: 256,
		shrinkQuality: 70,
		logPath: "",
		debug: false,
		...over,
	};
}

test("未超预算且张数未超限 → 啥也不做", () => {
	const plan = planImageBudget({
		sizes: [2 * MiB, 2 * MiB],
		shrinkTo: [256 * KiB, 256 * KiB],
		otherBytes: 1 * MiB,
		budget: 48 * MiB,
		keep: 6,
		maxCount: 30,
	});
	assert.deepEqual(plan.shrink, []);
	assert.deepEqual(plan.drop, []);
	assert.equal(plan.estBytes, 5 * MiB);
});

test("张数超限 → 丢最旧、保护最新 keep 张", () => {
	const sizes = Array.from({ length: 10 }, () => 10 * KiB);
	const plan = planImageBudget({ sizes, shrinkTo: sizes.map(() => 1 * KiB), otherBytes: 0, budget: 48 * MiB, keep: 2, maxCount: 4 });
	assert.deepEqual(plan.drop, [0, 1, 2, 3, 4, 5]);
	assert.deepEqual(plan.shrink, [], "张数超限时不应再压缩");
	assert.equal(plan.estBytes, 4 * 10 * KiB);
});

test("字节超预算 → 先压缩最大的非保护图，不动受保护的最新图", () => {
	const sizes = [5 * MiB, 5 * MiB, 5 * MiB];
	const plan = planImageBudget({ sizes, shrinkTo: sizes.map(() => 256 * KiB), otherBytes: 0, budget: 12 * MiB, keep: 1, maxCount: 0 });
	assert.deepEqual(plan.shrink, [0], "只压收益最大的一张即可进入预算");
	assert.deepEqual(plan.drop, []);
	assert.ok(plan.estBytes <= 12 * MiB);
});

test("全部图受保护且仍超预算 → 只能丢最旧（最后手段）", () => {
	const sizes = [5 * MiB, 5 * MiB, 5 * MiB];
	const plan = planImageBudget({ sizes, shrinkTo: sizes.map(() => 256 * KiB), otherBytes: 0, budget: 12 * MiB, keep: 3, maxCount: 0 });
	assert.deepEqual(plan.shrink, []);
	assert.deepEqual(plan.drop, [0]);
	assert.ok(plan.estBytes <= 12 * MiB);
});

test("压缩无收益的图（shrinkTo >= size）不会被选中", () => {
	const sizes = [5 * MiB, 5 * MiB];
	const plan = planImageBudget({ sizes, shrinkTo: [5 * MiB, 5 * MiB], otherBytes: 0, budget: 6 * MiB, keep: 1, maxCount: 0 });
	assert.deepEqual(plan.shrink, [], "没有可压缩收益，不应产生压缩动作");
	assert.deepEqual(plan.drop, [0], "无法压缩时退回丢最旧");
});

test("collectImages 兼容两种图片块形态并给出正确顺序", () => {
	const messages = [
		{ content: [{ type: "text", text: "看 /tmp/first.png" }, { type: "image", data: "AAA", mimeType: "image/png" }] },
		{ content: [{ type: "image", source: { type: "base64", data: "BBB", mediaType: "image/jpeg" } }] },
		{ content: "plain" },
	];
	const slots = collectImages(messages);
	assert.equal(slots.length, 2);
	assert.equal(slots[0].msgIndex, 0);
	assert.equal(slots[0].blockIndex, 1);
	assert.equal(slots[0].bytes, 3);
	assert.equal(slots[1].mimeType, "image/jpeg");
	assert.equal(slots[1].mimeHolder.mediaType, "image/jpeg");
});

test("占位文本带上邻近文件路径", () => {
	const messages = [{ content: [{ type: "text", text: "截图路径 D:/tmp/shot-01.png 已保存" }, { type: "image", data: "AAA", mimeType: "image/png" }] }];
	const slot = collectImages(messages)[0];
	const text = placeholderText(slot);
	assert.ok(text.includes("D:/tmp/shot-01.png"));
	assert.ok(text.includes("会话文件仍保留原图"));
});

test("textBytes 统计文本与工具参数", () => {
	const n = textBytes([
		{ content: "abcd" },
		{ content: [{ type: "text", text: "abcd" }, { type: "toolCall", arguments: { a: 1 } }] },
	]);
	assert.ok(n >= 12);
});

test("shrinkImage 真实压缩：体积暴降、对坏数据返回 null、命中缓存（sharp 不可用则跳过）", async (t) => {
	let sharp = null;
	try {
		sharp = (await import("sharp")).default;
	} catch {
		t.skip("本环境无 sharp，跳过真实压缩用例");
		return;
	}

	// 坏数据必须安静返回 null：绝不能因扩展异常把整轮请求弄坏
	assert.equal(await shrinkImage("bm90LWFuLWltYWdl", "image/png", budget({ shrinkKb: 8 })), null);

	// 真图：2400x1600 随机噪声图 PNG（15MiB base64），压到 1280px / JPEG q70
	const w = 2400;
	const h = 1600;
	const raw = crypto.randomBytes(w * h * 3);
	const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
	const base64 = png.toString("base64");
	assert.ok(base64.length > 10 * MiB, "测试素材本身应是大图");

	const res = await shrinkImage(base64, "image/png", budget({ shrinkKb: 256, shrinkEdge: 1280, shrinkQuality: 70 }));
	assert.ok(res, "应能压缩");
	assert.ok(res.bytes < base64.length / 4, `压缩后应大幅变小：${res.bytes} << ${base64.length}`);
	assert.equal(res.mimeType, "image/jpeg");
	assert.equal(await shrinkImage(base64, "image/png", budget({ shrinkKb: 256, shrinkEdge: 1280, shrinkQuality: 70 })), res, "同一张图应命中缓存（不重复编码）");

	// 不变量：能压就必须真的变小（否则返回 null，交给丢弃逻辑）——小图不该被 JPEG 重编码撞大
	for (const side of [64, 128, 256, 512]) {
		const buf = await sharp(crypto.randomBytes(side * side * 3), { raw: { width: side, height: side, channels: 3 } })
			.jpeg({ quality: 70, mozjpeg: true })
			.toBuffer();
		const src = buf.toString("base64");
		const out = await shrinkImage(src, "image/jpeg", budget({ shrinkKb: 256 }));
		assert.ok(out === null || out.bytes < src.length, `${side}px：能压就必须变小（res=${out?.bytes} src=${src.length}）`);
	}
});

function makeApi() {
	const handlers = {};
	return {
		handlers,
		on(name, fn) {
			handlers[name] = fn;
		},
		registerCommand() {},
	};
}

async function noisePng(sharp, w = 1200, h = 800) {
	return (await sharp(crypto.randomBytes(w * h * 3), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()).toString("base64");
}

test("端到端：默认导出接线，超预算时压缩旧图、保留最新图（sharp 不可用则跳过）", async (t) => {
	let sharp = null;
	try {
		sharp = (await import("sharp")).default;
	} catch {
		t.skip("本环境无 sharp，跳过端到端用例");
		return;
	}
	const saved = { ...process.env };
	Object.assign(process.env, { PI_IMAGE_BUDGET_MIB: "8", PI_IMAGE_KEEP: "1", PI_IMAGE_MAX_COUNT: "0", PI_IMAGE_SHRINK_MAX_KB: "256", PI_IMAGE_BUDGET_LOG: "" });
	try {
		const mod = await import("../.pi/extensions/image-budget.ts");
		const api = makeApi();
		mod.default(api);
		assert.ok(api.handlers.context, "必须注册 context 钩子");

		const blobs = [];
		for (let k = 0; k < 4; k++) blobs.push(await noisePng(sharp));
		const messages = blobs.map((b64, k) => ({
			role: "toolResult",
			content: [
				{ type: "text", text: `截图已保存 → D:/tmp/shot-${k}.png` },
				{ type: "image", data: b64, mimeType: "image/png" },
			],
		}));
		assert.ok(blobs.reduce((n, b) => n + b.length, 0) > 8 * MiB, "测试素材总字节必须超预算");

		const notices = [];
		const ctx = { ui: { notify: (m) => notices.push(m) }, sessionManager: { getSessionId: () => "testsess" } };
		const out = await api.handlers.context({ messages }, ctx);
		assert.ok(out && out.messages === messages, "应返回替换后的 messages（原数组就地改写）");

		const left = collectImages(out.messages);
		assert.equal(left.length, 4, "预算够时不应丢图（压缩即可）");
		assert.equal(left.at(-1).base64, blobs[3], "受保护的最新图必须原样保留");
		let shrunkCount = 0;
		for (const k of [0, 1, 2]) {
			const block = out.messages[k].content[1];
			if (block.type !== "image") {
				assert.ok(block.text.includes("会话文件仍保留原图"));
				continue;
			}
			if (block.mimeType === "image/jpeg") {
				assert.ok(block.data.length <= 256 * KiB * 1.5, `压缩后的旧图应在目标区：${block.data.length}`);
				shrunkCount++;
			} else {
				assert.equal(block.data.length, blobs[k].length, "未压缩的图必须原样不动");
			}
		}
		assert.ok(shrunkCount >= 1, "至少压缩一张旧图（预算靠压缩就已满足）");
		const total = collectImages(out.messages).reduce((n, s) => n + s.bytes, 0);
		assert.ok(total <= 8 * MiB, `压缩后总量应进预算：${(total / MiB).toFixed(1)}MiB`);

		// 预算压到极小时：连受保护的图也只能省略，并给用户一次性提示
		process.env.PI_IMAGE_BUDGET_MIB = "1";
		const messages2 = blobs.map((b64, k) => ({
			role: "toolResult",
			content: [{ type: "text", text: `截图已保存 → D:/tmp/shot-${k}.png` }, { type: "image", data: b64, mimeType: "image/png" }],
		}));
		const out2 = await api.handlers.context({ messages: messages2 }, ctx);
		assert.ok(out2, "应返回替换后的 messages");
		const left2 = collectImages(out2.messages);
		assert.ok(left2.length < 4, "极小预算下必须省略部分图");
		for (const k of [0, 1, 2, 3]) {
			const block = out2.messages[k].content[1];
			if (block.type === "text") assert.ok(block.text.includes("会话文件仍保留原图"));
		}
		assert.equal(notices.length, 1, "省略图片时应只提示一次");
	} finally {
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
	}
});

