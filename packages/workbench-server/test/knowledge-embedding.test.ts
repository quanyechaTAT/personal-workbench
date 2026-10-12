import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { KnowledgeEmbeddingClient } from "../src/knowledge-embedding.ts";

test("reads system EMBED aliases, normalizes the endpoint and excludes secrets from the index fingerprint", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-embedding-"));
	try {
		const path = join(root, "system.env");
		await writeFile(
			path,
			"EMBED_API_KEY=first-key\nEMBED_BASE_URL=https://embedding.example/v1/\nEMBED_MODEL_NAME=embedding-model\nEMBED_DIMENSIONS=2\n",
		);
		const client = new KnowledgeEmbeddingClient(path);
		const first = await client.config();
		expect(first.url.href).toBe("https://embedding.example/v1/embeddings");
		expect(first.dimensions).toBe(2);
		await writeFile(
			path,
			"EMBED_API_KEY=rotated-key\nEMBED_BASE_URL=https://embedding.example/v1/embeddings\nEMBED_MODEL_NAME=embedding-model\nEMBED_DIMENSIONS=2\n",
		);
		expect((await client.config()).fingerprint).toBe(first.fingerprint);
		await writeFile(
			path,
			"EMBED_API_KEY=key\nEMBED_BASE_URL=https://user:secret@embedding.example/v1\nEMBED_MODEL_NAME=model\n",
		);
		await expect(client.config()).rejects.toThrow("不能包含凭证");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("retries a transient response, reorders vectors by index and never includes error bodies", async () => {
	let calls = 0;
	const client = new KnowledgeEmbeddingClient("unused", async () => {
		calls++;
		return calls === 1
			? new Response("provider-secret", { status: 503 })
			: Response.json({
					data: [
						{ index: 1, embedding: [0, 1] },
						{ index: 0, embedding: [1, 0] },
					],
				});
	});
	const config = {
		url: new URL("https://embedding.example/v1/embeddings"),
		model: "test",
		apiKey: "secret",
		fingerprint: "test",
	};
	expect(await client.embed(config, ["one", "two"])).toEqual([
		[1, 0],
		[0, 1],
	]);
	expect(calls).toBe(2);
	let streams = 0;
	const disconnected = new KnowledgeEmbeddingClient("unused", async () => {
		streams++;
		return streams === 1
			? new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(new Error("provider-secret"));
						},
					}),
				)
			: Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
	});
	expect(await disconnected.embed(config, ["one"])).toEqual([[1, 0]]);
	expect(streams).toBe(2);
	const invalid = new KnowledgeEmbeddingClient("unused", async () =>
		Response.json({ data: [{ index: 0, embedding: [0, 0] }] }),
	);
	await expect(invalid.embed(config, ["one"])).rejects.toThrow("向量无效");
	const denied = new KnowledgeEmbeddingClient("unused", async () => new Response("provider-secret", { status: 401 }));
	await expect(denied.embed(config, ["one"])).rejects.toThrow("HTTP 401");
	const controller = new AbortController();
	const pending = new KnowledgeEmbeddingClient("unused", async () => {
		controller.abort();
		throw new Error("provider-secret");
	});
	await expect(pending.embed(config, ["one"], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
