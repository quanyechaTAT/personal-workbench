import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { WorkbenchError } from "@earendil-works/workbench-core";
import { Tokenizer } from "@huggingface/tokenizers";
import { getEncoding } from "js-tiktoken";

export interface KnowledgeTokenizer {
	name: string;
	fingerprint: string;
	count(text: string): number;
	resolve?(text: string, signal?: AbortSignal): Promise<void>;
}

class RequiredTokenMeasurement extends Error {
	readonly text: string;
	constructor(text: string) {
		super("Provider token measurement required");
		this.text = text;
	}
}

/** Replays a pure chunk/budget calculation after resolving each missing provider count. */
export async function withKnowledgeTokenizer<T>(
	tokenizer: KnowledgeTokenizer,
	calculate: () => T,
	signal?: AbortSignal,
): Promise<T> {
	for (let attempts = 0; attempts < 20000; attempts++) {
		signal?.throwIfAborted();
		try {
			return calculate();
		} catch (error) {
			if (!(error instanceof RequiredTokenMeasurement) || !tokenizer.resolve) throw error;
			await tokenizer.resolve(error.text, signal);
		}
	}
	throw new WorkbenchError(
		"invalid_input",
		"文档需要超过 20000 次 Token 计量，请拆分后上传或配置匹配的本地 tokenizer",
	);
}

const encodings = new Map<string, KnowledgeTokenizer>();
export function encodingTokenizer(name: "cl100k_base" | "o200k_base"): KnowledgeTokenizer {
	let tokenizer = encodings.get(name);
	if (!tokenizer) {
		const encoding = getEncoding(name);
		tokenizer = {
			name,
			fingerprint: `js-tiktoken@1.0.21:${name}`,
			count: (text) => encoding.encode(text, [], []).length,
		};
		encodings.set(name, tokenizer);
	}
	return tokenizer;
}

const cached = new Map<string, KnowledgeTokenizer>();
export async function loadKnowledgeTokenizer(
	config: {
		model: string;
		tokenizer?: string;
		tokenizerFile?: string;
		tokenizerConfigFile?: string;
		tokenizerModel?: string;
	},
	envDirectory: string,
	measure?: (text: string, signal?: AbortSignal) => Promise<number>,
): Promise<KnowledgeTokenizer> {
	if (config.tokenizer === "provider-usage") {
		if (config.tokenizerFile || config.tokenizerConfigFile || config.tokenizerModel !== config.model || !measure)
			throw new WorkbenchError(
				"invalid_input",
				"provider-usage 需要匹配的 EMBED_TOKENIZER_MODEL 和可返回 usage 的 Embedding 服务，不能与本地 tokenizer 文件混用",
			);
		const counts = new Map<string, number>();
		const key = (text: string) => createHash("sha256").update(text).digest("hex");
		return {
			name: `供应商实际 Token 计量 (${config.model})`,
			fingerprint: `provider-usage@1:${config.model}`,
			count: (text) => {
				if (!text) return 0;
				// A submission-size guard triggers structural subdivision; it is never reported as a Token count.
				if (Buffer.byteLength(text) > 120000) return Infinity;
				const value = counts.get(key(text));
				if (value === undefined) throw new RequiredTokenMeasurement(text);
				return value;
			},
			resolve: async (text, signal) => {
				const value = await measure(text, signal);
				if (!Number.isSafeInteger(value) || value < 0 || (text.length > 0 && value === 0))
					throw new WorkbenchError("external_failure", "供应商 Token 计量无效");
				counts.set(key(text), value);
			},
		};
	}
	if (config.tokenizerFile) {
		if (config.tokenizerModel !== config.model || !config.tokenizerConfigFile)
			throw new WorkbenchError(
				"invalid_input",
				"本地 tokenizer 需要 EMBED_TOKENIZER_CONFIG_FILE，并用 EMBED_TOKENIZER_MODEL 指明匹配的 Embedding 模型",
			);
		const contents: string[] = [];
		for (const file of [config.tokenizerFile, config.tokenizerConfigFile]) {
			const path = isAbsolute(file) ? file : resolve(envDirectory, file);
			const metadata = await lstat(path).catch(() => undefined);
			if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 * 1024)
				throw new WorkbenchError("invalid_input", "无法读取 tokenizer 普通文件，或文件超过 64 MiB");
			contents.push(await readFile(path, "utf8"));
		}
		const fingerprint = createHash("sha256")
			.update(`hf-tokenizers@0.2.0\n${contents.join("\n")}`)
			.digest("hex");
		const previous = cached.get(fingerprint);
		if (previous) return previous;
		try {
			const encoder = new Tokenizer(JSON.parse(contents[0]), JSON.parse(contents[1]));
			const tokenizer = {
				name: `HuggingFace (${config.model})`,
				fingerprint,
				count: (text: string) => encoder.encode(text, { add_special_tokens: true }).ids.length,
			};
			tokenizer.count("中文 tokenizer validation");
			cached.clear();
			cached.set(fingerprint, tokenizer);
			return tokenizer;
		} catch {
			throw new WorkbenchError(
				"invalid_input",
				"tokenizer 文件无效或包含不支持的结构，请提供与模型一致的 tokenizer.json 和 tokenizer_config.json",
			);
		}
	}
	const known = /^(?:text-embedding-3-(?:small|large)|text-embedding-ada-002)$/u.test(config.model)
		? "cl100k_base"
		: undefined;
	const name = config.tokenizer ?? known;
	if (name === "cl100k_base" || name === "o200k_base") {
		if ((known && name !== known) || (!known && config.tokenizerModel !== config.model))
			throw new WorkbenchError(
				"invalid_input",
				"tokenizer 与 Embedding 模型不匹配；私有模型须用 EMBED_TOKENIZER_MODEL 明确声明服务实际采用的编码",
			);
		return encodingTokenizer(name);
	}
	throw new WorkbenchError(
		"invalid_input",
		"无法确认该 Embedding 模型的 tokenizer；请配置匹配的 EMBED_TOKENIZER，或本地 EMBED_TOKENIZER_FILE／CONFIG_FILE／MODEL。未使用字符估算建索引",
	);
}

/** Finds a Unicode boundary and verifies the actual encoded input, including wrapper tokens. */
export function fittingPrefix(
	text: string,
	max: number,
	tokenizer: KnowledgeTokenizer,
	wrap: (text: string) => string = (text) => text,
): string {
	if (tokenizer.count(wrap(text)) <= max) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (tokenizer.count(wrap(text.slice(0, middle))) <= max) low = middle;
		else high = middle - 1;
	}
	if (low > 0 && /[\uD800-\uDBFF]/u.test(text[low - 1])) low--;
	while (low > 0 && tokenizer.count(wrap(text.slice(0, low))) > max) low--;
	return text.slice(0, low);
}
