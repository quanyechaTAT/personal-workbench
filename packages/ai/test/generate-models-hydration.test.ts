import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { validateGeneratedModelData } from "../scripts/model-data.ts";

it("hydrates Kimi Coding from the current models.dev provider without changing generated TypeScript", () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-hydrate-models-"));
	const isolatedPackageRoot = join(fixtureRoot, "package");
	try {
		mkdirSync(join(isolatedPackageRoot, "src/api"), { recursive: true });
		mkdirSync(join(isolatedPackageRoot, "src/providers"));
		cpSync(join(packageRoot, "scripts"), join(isolatedPackageRoot, "scripts"), { recursive: true });
		for (const path of ["package.json", "src/api/cloudflare.ts", "src/providers/kimi-coding.models.ts"]) {
			copyFileSync(join(packageRoot, path), join(isolatedPackageRoot, path));
		}
		writeFileSync(
			join(isolatedPackageRoot, "src/models.generated.ts"),
			'import { KIMI_CODING_MODELS } from "./providers/kimi-coding.models.ts";\n',
		);
		const generatedPaths = ["src/models.generated.ts", "src/providers/kimi-coding.models.ts"];
		const generatedBefore = generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"));
		const individualModelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-flash",
			"qwen3.8-max",
		];
		const catalog = {
			"alibaba-token-plan": {
				models: Object.fromEntries(individualModelIds.map((id) => [id, { id, name: id, tool_call: true }])),
			},
			"kimi-code-plan-cn": {
				models: Object.fromEntries(
					["k3", "kimi-for-coding", "unsupported-model"].map((id) => [
						id,
						{
							id,
							name: id,
							tool_call: id !== "unsupported-model",
							reasoning: true,
							modalities: { input: ["text", "image"] },
							limit: { context: 262144, output: 32768 },
						},
					]),
				),
			},
		};
		const preloadPath = join(fixtureRoot, "mock-catalogs.mjs");
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") return Response.json(catalog);\n` +
				`  if (["https://openrouter.ai/api/v1/models", "https://ai-gateway.vercel.sh/v1/models"].includes(String(input))) {\n` +
				`    return Response.json({ data: [] });\n` +
				`  }\n` +
				`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
				`};\n`,
		);
		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict", "--data-only"],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stdout + result.stderr).toBe(0);
		const data = JSON.parse(
			readFileSync(join(isolatedPackageRoot, "src/providers/data/kimi-coding.json"), "utf8"),
		) as Record<string, Record<string, unknown>>;
		expect(Object.keys(data["anthropic-messages"])).toEqual(["k3", "kimi-for-coding"]);
		expect(data["anthropic-messages"]["kimi-for-coding"]).toMatchObject({
			provider: "kimi-coding",
			api: "anthropic-messages",
			baseUrl: "https://api.kimi.com/coding",
			contextWindow: 262144,
			maxTokens: 32768,
		});
		expect(() => validateGeneratedModelData(isolatedPackageRoot)).not.toThrow();
		expect(generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"))).toEqual(
			generatedBefore,
		);
	} finally {
		expect(dirname(fixtureRoot)).toBe(tmpdir());
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});
