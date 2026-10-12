import type { SemanticEmbeddingPort } from "@earendil-works/workbench-core";
import type { EmbeddingConfig, KnowledgeEmbeddingClient } from "./knowledge-embedding.ts";

/** Equal inputs in one space share the HTTP batch for this retrieval request. */
export class MemoryEmbeddingScope implements SemanticEmbeddingPort {
	private readonly client: KnowledgeEmbeddingClient;
	private readonly pending = new Map<string, Promise<number[]>>();
	constructor(client: KnowledgeEmbeddingClient) {
		this.client = client;
	}
	async fingerprint(): Promise<string | undefined> {
		try {
			return (await this.client.config()).fingerprint;
		} catch {
			return undefined;
		}
	}
	async embed(text: string, signal?: AbortSignal): Promise<{ vector: number[]; fingerprint: string }> {
		const config = await this.client.config();
		return { vector: (await this.batch(config, [text], signal))[0], fingerprint: config.fingerprint };
	}
	async batch(config: EmbeddingConfig, texts: string[], signal?: AbortSignal): Promise<number[][]> {
		const missing = [...new Set(texts)].filter((text) => !this.pending.has(`${config.fingerprint}:${text}`));
		if (missing.length) {
			const values = this.client.embed(
				config,
				missing,
				signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
			);
			for (const [index, text] of missing.entries()) {
				const key = `${config.fingerprint}:${text}`;
				const cached = values
					.then((vectors) => vectors[index])
					.catch((error: unknown) => {
						if (this.pending.get(key) === cached) this.pending.delete(key);
						throw error;
					});
				this.pending.set(key, cached);
			}
		}
		return Promise.all(texts.map((text) => this.pending.get(`${config.fingerprint}:${text}`)!));
	}
}
