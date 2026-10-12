import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { docxDocument } from "./fixtures/knowledge-documents.ts";

test("deduplicates concurrent uploads and resumes interrupted embedding without losing the original", async () => {
	const fixture = await createAssistantFixture();
	let hold = true;
	const embedding = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		if (hold) return;
		const { input } = JSON.parse(body) as { input: string[] };
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 0] })) }));
	});
	await new Promise<void>((resolve) => embedding.listen(0, "127.0.0.1", resolve));
	try {
		const address = embedding.address();
		if (!address || typeof address === "string") throw new Error("No embedding test port");
		await writeFile(
			fixture.embeddingEnvFile,
			`EMBED_API_KEY=fixture-only\nEMBED_BASE_URL=http://127.0.0.1:${address.port}/v1\nEMBED_MODEL_NAME=recovery-model\nEMBED_TOKENIZER=cl100k_base\nEMBED_TOKENIZER_MODEL=recovery-model\n`,
		);
		const sourcePath = join(fixture.root, "恢复项目");
		await mkdir(sourcePath);
		const project = await fixture.application.createProject({ sourcePath });
		const bytes = await docxDocument("Interrupted vision indexing must resume after restart.");
		const [first, second] = await Promise.all([
			fixture.application.services.knowledge.upload(project, "恢复.docx", bytes),
			fixture.application.services.knowledge.upload(project, "重复.docx", bytes),
		]);
		expect(first.id).toBe(second.id);
		await expect
			.poll(async () => (await fixture.application.services.knowledge.listDocuments(project))[0]?.stage, {
				timeout: 15_000,
			})
			.toBe("embedding");
		await fixture.application.services.knowledge.dispose();
		expect((await fixture.application.services.knowledge.listDocuments(project))[0]).toMatchObject({
			status: "queued",
			processedChunks: 0,
		});
		hold = false;
		await fixture.restart();
		await expect
			.poll(async () => (await fixture.application.services.knowledge.listDocuments(project))[0]?.status, {
				timeout: 15_000,
			})
			.toBe("ready");
		expect((await fixture.application.services.knowledge.original(project, first.id)).bytes).toEqual(bytes);
		expect((await fixture.application.services.knowledge.search(project, "vision"))[0]).toMatchObject({
			documentId: first.id,
			name: "恢复.docx",
		});
	} finally {
		await fixture.close();
		embedding.closeAllConnections();
		await new Promise<void>((resolve, reject) => embedding.close((error) => (error ? reject(error) : resolve())));
	}
});
