import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { PerceptionConfiguration } from "../src/perception-config.ts";

test.each([
	"https://dashscope.aliyuncs.com/compatible-mode/v1",
	"https://fixture-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
])("four capabilities inherit only the shared Beijing URL and key: %s", async (baseUrl) => {
	const root = await mkdtemp(join(tmpdir(), "workbench-public-config 中文 "));
	try {
		const envFile = join(root, ".env");
		await writeFile(
			envFile,
			`EMBED_BASE_URL=${baseUrl}\nEMBED_API_KEY=fixture-common-key\nEMBED_MODEL_NAME=text-only-model\n`,
		);
		const configuration = new PerceptionConfiguration(envFile);
		const expected = [
			["ocr", "qwen3.5-ocr", "https:", "/api/v1/services/aigc/multimodal-generation/generation"],
			["asr", "qwen-audio-3.0-asr-flash-streaming", "wss:", "/api-ws/v1/inference"],
			["vision", "qwen3.7-flash-2026-07-15", "https:", "/compatible-mode/v1/chat/completions"],
			[
				"multimodal",
				"tongyi-embedding-vision-flash",
				"https:",
				"/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
			],
		] as const;
		for (const [name, model, protocol, path] of expected) {
			const endpoint = await configuration.endpoint(name);
			expect(endpoint.apiKey === "fixture-common-key").toBe(true);
			expect(endpoint.model).toBe(model);
			expect(endpoint.url.hostname).toBe(new URL(baseUrl).hostname);
			expect(endpoint.url.protocol).toBe(protocol);
			expect(endpoint.url.pathname).toBe(path);
		}
		const capabilities = await configuration.capabilities();
		expect(capabilities.every((value) => value.configured)).toBe(true);
		expect(JSON.stringify(capabilities)).not.toContain("fixture-common-key");
		const original = await configuration.endpoint("vision");
		await writeFile(
			envFile,
			`EMBED_BASE_URL=${baseUrl}\nEMBED_API_KEY=fixture-common-key\nMEMORY_VISION_MODEL=vision-model-override\n`,
		);
		const changed = await configuration.endpoint("vision");
		expect(changed.model).toBe("vision-model-override");
		expect(changed.url.href).toBe(original.url.href);
		expect(changed.apiKey === original.apiKey).toBe(true);
		expect(changed.fingerprint).not.toBe(original.fingerprint);
	} finally {
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true });
	}
});

test.each([
	"https://fixture-workspace.cn-beijing.maas.aliyuncs.com.example.invalid/compatible-mode/v1",
	"https://example.invalid/compatible-mode/v1",
	"http://dashscope.aliyuncs.com/compatible-mode/v1",
	"https://fixture-user@dashscope.aliyuncs.com/compatible-mode/v1",
])("shared-key inheritance rejects unrecognized or unsafe origins: %s", async (baseUrl) => {
	const root = await mkdtemp(join(tmpdir(), "workbench-config-origin 中文 "));
	try {
		const envFile = join(root, ".env");
		await writeFile(envFile, `EMBED_BASE_URL=${baseUrl}\nEMBED_API_KEY=fixture-common-key\n`);
		const configuration = new PerceptionConfiguration(envFile);
		await expect(configuration.endpoint("vision")).rejects.toThrow("已识别的百炼 HTTPS 来源");
		expect((await configuration.capabilities()).every((value) => !value.configured)).toBe(true);
	} finally {
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true });
	}
});
