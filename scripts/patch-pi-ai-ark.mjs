#!/usr/bin/env node
/**
 * patch-pi-ai-ark.mjs — 把火山方舟（Ark）两个 plan 端点加为 pi-ai 内置（预制）供应商。
 *
 * 背景：pi-ai 的内置供应商目录编译在 dist（providers/all.js + models.generated.js）里，
 * models.json 自定义供应商虽然可用，但不会出现在"未配置"状态的新机 Models 面板/
 * /login 的 API Key 预制列表中。本脚本给每个 pi-ai dist 副本写入：
 *   1. providers/ark-agent-plan.js / .models.js / data/ark-agent-plan.json
 *   2. providers/ark-coding-plan.js / .models.js / data/ark-coding-plan.json
 *   3. providers/all.js：import + builtinProviders() 注册
 *   4. models.generated.js：import + MODELS 表注册
 *   5. env-api-keys.js：envMap 增加 ARK_AGENT_PLAN_API_KEY / ARK_CODING_PLAN_API_KEY
 *
 * 模型目录固化自 2026-09 时的火山方舟 plan 现网配置（与用户 ~/.pi/agent/models.json
 * 中 ark-agent-plan / ark-code-plan 一致）；凭据不写死——用户经 Models 面板输入
 * （落 auth.json）或设环境变量即可。
 *
 * ⚠ pi / pi-ai 升级会覆盖 dist → 升级后重跑本脚本（幂等）：
 *   node scripts/patch-pi-ai-ark.mjs          # 全部已知副本
 *   node scripts/patch-pi-ai-ark.mjs <dist>   # 指定单个 pi-ai dist 目录
 */
import fs from "node:fs";
import path from "node:path";

const ARK_PLAN_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3";
const ARK_CODING_BASE = "https://ark.cn-beijing.volces.com/api/coding/v3";

const NAME_MAP = { glm: "GLM", kimi: "Kimi", doubao: "Doubao", deepseek: "DeepSeek", minimax: "MiniMax", ark: "Ark" };
function prettyName(id) {
	return id.split("-").map((t) => NAME_MAP[t.toLowerCase()] ?? (/^[0-9]/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1))).join(" ");
}

/* 模型目录（固化自用户 ~/.pi/agent/models.json，与现网 plan 一致） */
const AGENT_PLAN_MODELS = [
	{ id: "ark-code-latest" },
	{ id: "doubao-seed-evolving", input: ["text", "image"], contextWindow: 1048576, maxTokens: 256000 },
	{ id: "doubao-seed-2.1-turbo", input: ["text", "image"], contextWindow: 262144, maxTokens: 256000 },
	{ id: "doubao-seed-2.0-lite", input: ["text", "image"], contextWindow: 262144, maxTokens: 128000 },
	{ id: "doubao-seed-2.0-mini", input: ["text", "image"], contextWindow: 262144, maxTokens: 128000 },
	{ id: "glm-5.3", input: ["text"], contextWindow: 1048576, maxTokens: 128000 },
	{ id: "glm-5.3-flash", input: ["text", "image"], contextWindow: 1048576, maxTokens: 128000 },
	{ id: "deepseek-v4-pro", input: ["text"], contextWindow: 1048576, maxTokens: 393216 },
	{ id: "deepseek-v4-flash", input: ["text"], contextWindow: 1048576, maxTokens: 393216 },
	{ id: "kimi-k3", input: ["text", "image"], contextWindow: 1048576, maxTokens: 128000 },
	{ id: "glm-latest", input: ["text"], contextWindow: 1048576, maxTokens: 128000 },
	{ id: "kimi-k2.7-code", input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 },
	{ id: "minimax-m3" },
];
const CODING_PLAN_MODELS = [
	{ id: "ark-code-latest", reasoning: true, compat: { thinkingFormat: "deepseek" }, contextWindow: 262144, maxTokens: 32768 },
	{ id: "doubao-seed-2.0-lite", input: ["text", "image"], contextWindow: 262144, maxTokens: 128000 },
	{ id: "kimi-k2.7-code", input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 },
	{ id: "minimax-m3" },
	{ id: "doubao-seed-2.1-turbo", input: ["text", "image"], contextWindow: 262144, maxTokens: 256000 },
	{ id: "deepseek-v4-flash", input: ["text"], contextWindow: 1048576, maxTokens: 393216 },
	{ id: "glm-5.3", input: ["text"], contextWindow: 1048576, maxTokens: 128000 },
	{ id: "doubao-seed-evolving", input: ["text", "image"], contextWindow: 1048576, maxTokens: 256000 },
	{ id: "deepseek-v4-pro", input: ["text"], contextWindow: 1048576, maxTokens: 393216 },
	{ id: "glm-5.3-flash", input: ["text", "image"], contextWindow: 1048576, maxTokens: 128000 },
];

function toSdkData(providerId, baseUrl, entries) {
	const models = {};
	for (const m of entries) {
		models[m.id] = {
			id: m.id,
			name: prettyName(m.id),
			api: "openai-completions",
			provider: providerId,
			baseUrl,
			...(m.compat ? { compat: m.compat } : {}),
			...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
			...(m.input ? { input: m.input } : {}),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // 套餐计费
			...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
			...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
		};
	}
	return { "openai-completions": models };
}

const PROVIDERS = [
	{
		id: "ark-agent-plan", pascal: "ArkAgentPlan", name: "Ark Agent Plan",
		baseUrl: ARK_PLAN_BASE, env: "ARK_AGENT_PLAN_API_KEY", models: AGENT_PLAN_MODELS,
	},
	{
		id: "ark-coding-plan", pascal: "ArkCodingPlan", name: "Ark Coding Plan",
		baseUrl: ARK_CODING_BASE, env: "ARK_CODING_PLAN_API_KEY", models: CODING_PLAN_MODELS,
	},
];

const factoryTemplate = (p) => `// Vendored patch (scripts/patch-pi-ai-ark.mjs): 火山方舟 plan 端点内置供应商
import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider } from "../models.js";
import { ${p.pascal}_MODELS } from "./${p.id}.models.js";
export function ${p.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Provider() {
    return createProvider({
        id: "${p.id}",
        name: "${p.name}",
        baseUrl: "${p.baseUrl}",
        auth: { apiKey: envApiKeyAuth("${p.name} API key", ["${p.env}"]) },
        models: Object.values(${p.pascal}_MODELS),
        api: openAICompletionsApi(),
    });
}
//# sourceMappingURL=${p.id}.js.map
`;

const modelsTemplate = (p) => `// Vendored patch (scripts/patch-pi-ai-ark.mjs)
import values from "./data/${p.id}.json" with { type: "json" };
import { flattenModelCatalog } from "../model-catalog.js";
export const ${p.pascal}_MODELS = flattenModelCatalog("${p.id}", values);
//# sourceMappingURL=${p.id}.models.js.map
`;

function patchDist(distDir) {
	const need = [path.join(distDir, "providers"), path.join(distDir, "providers", "data")];
	for (const d of need) if (!fs.existsSync(d)) throw new Error(`锚点缺失（不是 pi-ai dist?）: ${d}`);
	const allJs = path.join(distDir, "providers", "all.js");
	const genJs = path.join(distDir, "models.generated.js");
	const envJs = path.join(distDir, "env-api-keys.js");
	for (const f of [allJs, genJs, envJs]) if (!fs.existsSync(f)) throw new Error(`锚点缺失: ${f}`);

	let changed = [];
	for (const p of PROVIDERS) {
		const dataJson = path.join(distDir, "providers", "data", `${p.id}.json`);
		const providerJs = path.join(distDir, "providers", `${p.id}.js`);
		const modelsJs = path.join(distDir, "providers", `${p.id}.models.js`);
		const data = JSON.stringify(toSdkData(p.id, p.baseUrl, p.models));
		if (!fs.existsSync(dataJson) || fs.readFileSync(dataJson, "utf8") !== data) {
			fs.writeFileSync(dataJson, data);
			changed.push(path.basename(dataJson));
		}
		for (const [f, content] of [[providerJs, factoryTemplate(p)], [modelsJs, modelsTemplate(p)]]) {
			if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== content) {
				fs.writeFileSync(f, content);
				changed.push(path.basename(f));
			}
		}
	}

	/* all.js：import + builtinProviders() 注册 */
	let all = fs.readFileSync(allJs, "utf8");
	const impAnchor = 'import { anthropicProvider } from "./anthropic.js";';
	const regAnchor = "        anthropicProvider(),";
	if (all.includes(impAnchor) && all.includes(regAnchor) && !all.includes("ark-agent-plan")) {
		all = all.replace(impAnchor, impAnchor + "\n" + PROVIDERS.map((p) => `import { ${p.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Provider } from "./${p.id}.js";`).join("\n"));
		all = all.replace(regAnchor, regAnchor + "\n" + PROVIDERS.map((p) => `        ${p.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Provider(),`).join("\n"));
		fs.writeFileSync(allJs, all);
		changed.push("providers/all.js");
	}

	/* models.generated.js：import + MODELS 表 */
	let gen = fs.readFileSync(genJs, "utf8");
	const genImpAnchor = 'import { ANTHROPIC_MODELS } from "./providers/anthropic.models.js";';
	const genMapAnchor = "export const MODELS = {";
	if (gen.includes(genImpAnchor) && gen.includes(genMapAnchor) && !gen.includes("ark-agent-plan")) {
		gen = gen.replace(genImpAnchor, genImpAnchor + "\n" + PROVIDERS.map((p) => `import { ${p.pascal}_MODELS } from "./providers/${p.id}.models.js";`).join("\n"));
		gen = gen.replace(genMapAnchor, genMapAnchor + "\n" + PROVIDERS.map((p) => `    "${p.id}": ${p.pascal}_MODELS,`).join("\n"));
		fs.writeFileSync(genJs, gen);
		changed.push("models.generated.js");
	}

	/* env-api-keys.js：envMap */
	let env = fs.readFileSync(envJs, "utf8");
	const envAnchor = '"zai-coding-cn": "ZAI_CODING_CN_API_KEY",';
	if (env.includes(envAnchor) && !env.includes('"ark-agent-plan"')) {
		env = env.replace(envAnchor, envAnchor + "\n" + PROVIDERS.map((p) => `        "${p.id}": "${p.env}",`).join("\n"));
		fs.writeFileSync(envJs, env);
		changed.push("env-api-keys.js");
	}

	return changed;
}

const KNOWN_DISTS = [
	"C:/Users/nkualexlee/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist",
	"D:/vibecoding/gba-font-cracker-js/pi-web/node_modules/@earendil-works/pi-ai/dist",
	"D:/vibecoding/gba-font-cracker-js/pi-web/.next/node_modules/@earendil-works/pi-ai-5e96b54476ded9ea/dist",
	"D:/gbfp/payload/pi-web/node_modules/@earendil-works/pi-ai/dist",
	"D:/gbfp/payload/pi-web/.next/node_modules/@earendil-works/pi-ai-5e96b54476ded9ea/dist",
	"D:/Program Files/GBA Font Studio/payload/pi-web/node_modules/@earendil-works/pi-ai/dist",
	"D:/Program Files/GBA Font Studio/payload/pi-web/.next/node_modules/@earendil-works/pi-ai-5e96b54476ded9ea/dist",
];

const args = process.argv.slice(2);
const targets = args.length ? args : KNOWN_DISTS.filter((d) => fs.existsSync(d));
for (const t of targets) {
	try {
		const changed = patchDist(t);
		console.log(`${changed.length ? "✔" : "＝"} ${t}${changed.length ? "  ← " + changed.join(", ") : "  (已是最新)"}`);
	} catch (e) {
		console.error(`✘ ${t}: ${e.message}`);
		process.exitCode = 1;
	}
}
