import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { WorkbenchError } from "@earendil-works/workbench-core";

export interface EmbeddingConfig {
	url: URL;
	model: string;
	apiKey: string;
	dimensions?: number;
	fingerprint: string;
	tokenizer?: string;
	tokenizerFile?: string;
	tokenizerConfigFile?: string;
	tokenizerModel?: string;
}

interface EmbeddingResponse {
	vectors: number[][];
	totalTokens?: number;
}

export const DEFAULT_EMBEDDING_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

function configuredValue(values: Record<string, string | undefined>, ...aliases: string[]): string | undefined {
	const entries = new Map(Object.entries(values).map(([key, value]) => [key.toUpperCase(), value?.trim()]));
	return aliases.map((alias) => entries.get(alias)).find(Boolean);
}

/** Reads system configuration only. Secrets never enter DTOs, SQLite or Pi context. */
export class KnowledgeEmbeddingClient {
	private readonly envFile: string;
	private readonly fetcher: typeof fetch;
	private readonly measured = new Map<string, { vector: number[]; tokens: number }>();
	constructor(envFile = DEFAULT_EMBEDDING_ENV_FILE, fetcher: typeof fetch = fetch) {
		this.envFile = envFile;
		this.fetcher = fetcher;
	}
	async config(): Promise<EmbeddingConfig> {
		let values: Record<string, string | undefined>;
		try {
			const metadata = await lstat(this.envFile);
			if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024)
				throw new WorkbenchError("invalid_input", "系统 .env 必须是普通配置文件");
			values = parseEnv(await readFile(this.envFile, "utf8"));
		} catch (error) {
			if (error instanceof WorkbenchError) throw error;
			throw new WorkbenchError(
				"invalid_input",
				"无法读取系统根目录 .env，请配置 EMBED_API_KEY、EMBED_BASE_URL、EMBED_MODEL_NAME",
			);
		}
		const apiKey = configuredValue(
			values,
			"EMBED_API_KEY",
			"EMBEDDING_API_KEY",
			"EMBEDDING_APIKEY",
			"OPENAI_API_KEY",
			"API_KEY",
		);
		const baseUrl = configuredValue(
			values,
			"EMBED_BASE_URL",
			"EMBEDDING_BASE_URL",
			"EMBEDDING_BASEURL",
			"OPENAI_BASE_URL",
			"BASE_URL",
			"BASEURL",
		);
		const model = configuredValue(
			values,
			"EMBED_MODEL_NAME",
			"EMBED_MODEL",
			"EMBEDDING_MODEL_NAME",
			"EMBEDDING_MODELNAME",
			"EMBEDDING_MODEL_ID",
			"EMBEDDING_MODEL",
			"MODEL_NAME",
			"MODELNAME",
		);
		if (!apiKey || !baseUrl || !model)
			throw new WorkbenchError("invalid_input", "系统 .env 缺少 Embedding 的 API Key、Base URL 或 Model Name");
		let url: URL;
		try {
			url = new URL(baseUrl);
		} catch {
			throw new WorkbenchError("invalid_input", "系统 .env 中的 Embedding Base URL 无效");
		}
		if (url.username || url.password || url.search || url.hash)
			throw new WorkbenchError("invalid_input", "Embedding URL 不能包含凭证、查询参数或片段");
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		)
			throw new WorkbenchError("invalid_input", "Embedding URL 必须使用 HTTPS；本机服务可使用 HTTP");
		const path = url.pathname.replace(/\/+$/u, "");
		url.pathname = `${path}${path.endsWith("/embeddings") ? "" : "/embeddings"}`;
		const rawDimensions = configuredValue(values, "EMBED_DIMENSIONS", "EMBEDDING_DIMENSIONS");
		const dimensions = rawDimensions ? Number(rawDimensions) : undefined;
		if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192))
			throw new WorkbenchError("invalid_input", "Embedding Dimensions 必须为 1 到 8192 的整数");
		if (
			model === "qwen3.7-text-embedding" &&
			dimensions !== undefined &&
			![256, 512, 768, 1024, 1536, 2048, 2560].includes(dimensions)
		)
			throw new WorkbenchError("invalid_input", "qwen3.7-text-embedding 的维度必须使用百炼公布的离散选项");
		return {
			url,
			model,
			apiKey,
			tokenizer: configuredValue(values, "EMBED_TOKENIZER"),
			tokenizerFile: configuredValue(values, "EMBED_TOKENIZER_FILE"),
			tokenizerConfigFile: configuredValue(values, "EMBED_TOKENIZER_CONFIG_FILE"),
			tokenizerModel: configuredValue(values, "EMBED_TOKENIZER_MODEL"),
			dimensions,
			fingerprint: createHash("sha256")
				.update(
					`${url.href}\n${model}\n${dimensions ?? "default"}\n${configuredValue(values, "EMBED_SPACE_REVISION", "MEMORY_EMBED_SPACE_REVISION") ?? "1"}`,
				)
				.digest("hex"),
		};
	}
	async embed(config: EmbeddingConfig, input: string[], signal?: AbortSignal): Promise<number[][]> {
		if (!input.length) return [];
		signal?.throwIfAborted();
		const cached = input.map((text) =>
			this.measured.get(createHash("sha256").update(`${config.fingerprint}\n${text}`).digest("hex")),
		);
		if (config.tokenizer === "provider-usage" && cached.every((value) => value))
			return cached.map((value) => [...value!.vector]);
		return (await this.request(config, input, signal)).vectors;
	}
	async measure(config: EmbeddingConfig, text: string, signal?: AbortSignal): Promise<number> {
		signal?.throwIfAborted();
		const key = createHash("sha256").update(`${config.fingerprint}\n${text}`).digest("hex");
		const cached = this.measured.get(key);
		if (cached) return cached.tokens;
		// Only one input makes the provider's total_tokens an exact count for that input.
		const result = await this.request(config, [text], signal);
		if (result.totalTokens === undefined || (text.length > 0 && result.totalTokens === 0))
			throw new WorkbenchError(
				"external_failure",
				"Embedding 响应缺少有效 usage.total_tokens，无法执行精确 Token 分块",
			);
		this.measured.set(key, { vector: result.vectors[0], tokens: result.totalTokens });
		if (this.measured.size > 128) this.measured.delete(this.measured.keys().next().value ?? "");
		return result.totalTokens;
	}
	private async request(config: EmbeddingConfig, input: string[], signal?: AbortSignal): Promise<EmbeddingResponse> {
		if (/^qwen3\.7-text-embedding(?:-flash)?$/u.test(config.model) && input.length > 20)
			throw new WorkbenchError("invalid_input", "百炼 qwen3.7 文本 Embedding 每批最多 20 条");
		for (let attempt = 0; attempt <= 5; attempt++) {
			signal?.throwIfAborted();
			let response: Response;
			try {
				response = await this.fetcher(config.url, {
					method: "POST",
					headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
					body: JSON.stringify({
						model: config.model,
						input,
						...(config.dimensions ? { dimensions: config.dimensions } : {}),
					}),
					redirect: "error",
					signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
				});
			} catch {
				signal?.throwIfAborted();
				if (attempt === 5)
					throw new WorkbenchError("external_failure", "Embedding 服务连接失败或超时，已重试 5 次");
				await delay(Math.min(500 * 2 ** attempt, 5000), undefined, { signal });
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				if (attempt < 5 && [408, 429, 500, 502, 503, 504].includes(response.status)) {
					await delay(Math.min(500 * 2 ** attempt, 5000), undefined, { signal });
					continue;
				}
				throw new WorkbenchError(
					"external_failure",
					`Embedding 服务返回 HTTP ${response.status}，请检查系统配置或服务状态`,
				);
			}
			const buffers: Uint8Array[] = [];
			let size = 0;
			if (!response.body) throw new WorkbenchError("external_failure", "Embedding 服务返回空响应");
			try {
				for await (const buffer of response.body) {
					size += buffer.length;
					if (size > 16 * 1024 * 1024) throw new WorkbenchError("external_failure", "Embedding 响应超过大小上限");
					buffers.push(buffer);
				}
			} catch (error) {
				signal?.throwIfAborted();
				if (error instanceof WorkbenchError) throw error;
				if (attempt === 5) throw new WorkbenchError("external_failure", "Embedding 响应连接中断，已重试 5 次");
				await delay(Math.min(500 * 2 ** attempt, 5000), undefined, { signal });
				continue;
			}
			let value: unknown;
			try {
				value = JSON.parse(Buffer.concat(buffers).toString("utf8"));
			} catch {
				throw new WorkbenchError("external_failure", "Embedding 服务返回格式无效");
			}
			if (typeof value !== "object" || value === null || !("data" in value) || !Array.isArray(value.data))
				throw new WorkbenchError("external_failure", "Embedding 服务返回格式无效");
			const items: Array<{ index: number; embedding: number[] }> = [];
			for (const item of value.data) {
				if (
					typeof item !== "object" ||
					item === null ||
					!("index" in item) ||
					!Number.isInteger(item.index) ||
					!("embedding" in item) ||
					!Array.isArray(item.embedding) ||
					!item.embedding.length ||
					item.embedding.length > 8192 ||
					!item.embedding.every(
						(number: unknown) => typeof number === "number" && Number.isFinite(number) && Math.abs(number) < 3e38,
					) ||
					!item.embedding.some((number: number) => number !== 0)
				)
					throw new WorkbenchError("external_failure", "Embedding 向量无效");
				items.push({ index: item.index as number, embedding: item.embedding as number[] });
			}
			items.sort((left, right) => left.index - right.index);
			if (
				items.length !== input.length ||
				items.some(
					(item, index) =>
						item.index !== index ||
						item.embedding.length !== items[0]?.embedding.length ||
						(config.dimensions && item.embedding.length !== config.dimensions),
				)
			)
				throw new WorkbenchError("external_failure", "Embedding 响应数量或向量维度与输入不一致");
			const usage = "usage" in value ? value.usage : undefined;
			const tokens =
				typeof usage === "object" && usage !== null && "total_tokens" in usage ? usage.total_tokens : undefined;
			return {
				vectors: items.map((item) => item.embedding),
				totalTokens: typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined,
			};
		}
		throw new WorkbenchError("external_failure", "Embedding 服务不可用");
	}
}
