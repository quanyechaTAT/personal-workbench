import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { WorkbenchError } from "@earendil-works/workbench-core";
import { DEFAULT_EMBEDDING_ENV_FILE } from "./knowledge-embedding.ts";

export type PerceptionCapability = "ocr" | "asr" | "vision" | "multimodal";
export interface PerceptionEndpoint {
	url: URL;
	apiKey: string;
	model: string;
	fingerprint: string;
	spaceId: string;
}
const defaults = {
	ocr: { model: "qwen3.5-ocr", path: "/api/v1/services/aigc/multimodal-generation/generation" },
	asr: { model: "qwen-audio-3.0-asr-flash-streaming", path: "/api-ws/v1/inference" },
	vision: { model: "qwen3.7-flash-2026-07-15", path: "/compatible-mode/v1/chat/completions" },
	multimodal: {
		model: "tongyi-embedding-vision-flash",
		path: "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
	},
};
export class PerceptionConfiguration {
	private readonly envFile: string;
	constructor(envFile = DEFAULT_EMBEDDING_ENV_FILE) {
		this.envFile = envFile;
	}
	async endpoint(capability: PerceptionCapability): Promise<PerceptionEndpoint> {
		let values: Record<string, string | undefined>;
		try {
			const metadata = await lstat(this.envFile);
			if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) throw new Error("unsafe env");
			values = parseEnv(await readFile(this.envFile, "utf8"));
		} catch {
			throw new WorkbenchError("invalid_input", `系统 .env 不可用，尚未配置 ${capability.toUpperCase()}`);
		}
		const prefix = `MEMORY_${capability.toUpperCase()}`;
		if (values[`${prefix}_ENABLED`] === "false")
			throw new WorkbenchError("conflict", `${capability.toUpperCase()} 已关闭`);
		const apiKey = values[`${prefix}_API_KEY`]?.trim() || values.EMBED_API_KEY?.trim();
		if (!apiKey) throw new WorkbenchError("invalid_input", `${capability.toUpperCase()} 缺少服务凭证`);
		const model = values[`${prefix}_MODEL`]?.trim() || defaults[capability].model;
		const explicit = values[`${prefix}_ENDPOINT`]?.trim();
		let url: URL;
		try {
			if (explicit) url = new URL(explicit);
			else {
				const base = new URL(values.EMBED_BASE_URL ?? "");
				if (
					base.protocol !== "https:" ||
					!/^(?:(?:dashscope(?:-intl|-us)?|[a-z0-9-]+\.dashscope)|[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1|us-east-1)\.maas)\.aliyuncs\.com$/iu.test(
						base.hostname,
					) ||
					base.username ||
					base.password ||
					base.search ||
					base.hash
				)
					throw new Error("unknown provider");
				url = new URL(defaults[capability].path, base.origin);
				if (capability === "asr") url.protocol = "wss:";
			}
		} catch {
			throw new WorkbenchError(
				"invalid_input",
				`${capability.toUpperCase()} 需要独立 Endpoint；只能从已识别的百炼 HTTPS 来源派生地址`,
			);
		}
		const secure = capability === "asr" ? "wss:" : "https:";
		const local = capability === "asr" ? "ws:" : "http:";
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(url.protocol !== secure &&
				!(url.protocol === local && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
		)
			throw new WorkbenchError(
				"invalid_input",
				`${capability.toUpperCase()} Endpoint 必须使用安全协议且不能含凭证或查询参数`,
			);
		const revision = values.MEMORY_EMBED_SPACE_REVISION?.trim() || "1";
		const fingerprint = createHash("sha256")
			.update(JSON.stringify([capability, url.href, model, capability === "multimodal" ? 768 : null, revision]))
			.digest("hex");
		return { url, apiKey, model, fingerprint, spaceId: `bailian:${capability}:${fingerprint}` };
	}
	async capabilities() {
		return Promise.all(
			(Object.keys(defaults) as PerceptionCapability[]).map(async (name) => {
				try {
					const endpoint = await this.endpoint(name);
					return { name, configured: true, model: endpoint.model };
				} catch (error) {
					return {
						name,
						configured: false,
						model: defaults[name].model,
						diagnostic: error instanceof WorkbenchError ? error.message : "能力配置不可用",
					};
				}
			}),
		);
	}
}
