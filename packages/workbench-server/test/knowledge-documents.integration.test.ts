import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { KnowledgeDocument, KnowledgeHit } from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { docxDocument, pdfDocument } from "./fixtures/knowledge-documents.ts";

test("uploads PDF and Word into a project, indexes with system .env, retrieves citations, and preserves isolation and restart recovery", async () => {
	const fixture = await createAssistantFixture();
	const requests: Array<{ model: string; input: string[] }> = [];
	let failEmbedding = false;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		if (failEmbedding) {
			response.writeHead(401);
			response.end("secret-error-body");
			return;
		}
		const value = JSON.parse(body) as { model: string; input: string[] };
		requests.push(value);
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				data: value.input.map((text, index) => ({
					index,
					embedding: /vision|视觉|accuracy/iu.test(text)
						? [1, 0, 0]
						: /private|隔离/iu.test(text)
							? [0, 0, 1]
							: [0, 1, 0],
				})),
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No embedding port");
		await writeFile(
			fixture.embeddingEnvFile,
			`EMBED_API_KEY=system-secret\nEMBED_BASE_URL=http://127.0.0.1:${address.port}/v1\nEMBED_MODEL_NAME=real-test-embedding\nEMBED_TOKENIZER=cl100k_base\nEMBED_TOKENIZER_MODEL=real-test-embedding\n`,
		);
		const source = join(fixture.root, "CV Learning");
		await mkdir(source);
		const project = await fixture.application.createProject({ sourcePath: source });
		const otherSource = join(fixture.root, "Other Project");
		await mkdir(otherSource);
		const other = await fixture.application.createProject({ sourcePath: otherSource });
		const prefix = `/projects/${project.id}/knowledge`;
		const upload = async (name: string, bytes: Buffer, projectId = project.id) => {
			const response = await fixture.request(
				`/projects/${projectId}/knowledge/documents?name=${encodeURIComponent(name)}`,
				{ method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(bytes) },
			);
			expect(response.status).toBe(202);
			return (await response.json()) as KnowledgeDocument;
		};
		const pdf = await upload(
			"vision.pdf",
			pdfDocument(["Vision accuracy reached 91 percent.", "Budget and timeline notes."]),
		);
		const wordBytes = await docxDocument("视觉研究 vision baseline 准确率 92%。仅供 CV 项目参考。");
		const word = await upload("视觉资料.docx", wordBytes);
		expect((await upload("重复.docx", wordBytes)).id).toBe(word.id);
		const isolated = await upload(
			"private.docx",
			await docxDocument("private 隔离项目 confidential notes"),
			other.id,
		);
		await expect
			.poll(
				async () => (await fixture.application.services.knowledge.listDocuments(project)).map((doc) => doc.status),
				{ timeout: 15_000 },
			)
			.toEqual(["ready", "ready"]);
		await expect
			.poll(async () => (await fixture.application.services.knowledge.listDocuments(other))[0]?.status, {
				timeout: 15_000,
			})
			.toBe("ready");
		expect(
			await readFile(join(source, ".env")).catch((error: unknown) => (error instanceof Error ? undefined : error)),
		).toBeUndefined();
		const hits = (await (await fixture.request(`${prefix}/search?q=vision`)).json()) as KnowledgeHit[];
		expect(hits.some((hit) => hit.documentId === pdf.id && hit.startPage === 1 && hit.text.includes("91"))).toBe(
			true,
		);
		expect(hits.some((hit) => hit.documentId === word.id && hit.text.includes("92%"))).toBe(true);
		expect(hits.some((hit) => hit.documentId === isolated.id)).toBe(false);
		const preview = await fixture.request(`${prefix}/documents/${pdf.id}/preview`);
		expect(await preview.json()).toMatchObject({
			document: { name: "vision.pdf", pageCount: 2 },
			passages: [{ startPage: 1 }, { startPage: 2 }],
		});
		expect((await fixture.request(`/projects/${other.id}/knowledge/documents/${pdf.id}/file`)).status).toBe(404);
		expect(Buffer.from(await (await fixture.request(`${prefix}/documents/${word.id}/file`)).arrayBuffer())).toEqual(
			wordBytes,
		);
		const session = await fixture.application.createSession({ projectId: project.id });
		const context = await fixture.application.contextForSession(session.id, "vision accuracy");
		expect(context.turn?.appendSystemPrompt?.join("\n")).toContain("vision.pdf，第 1 页");
		expect(JSON.stringify(context)).not.toContain("system-secret");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("knowledge_search", { query: "vision accuracy" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("根据 vision.pdf 第 1 页，准确率为 91%。"),
		]);
		const run = (await (
			await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "检索 vision 的 accuracy" }),
			})
		).json()) as { runId: string };
		const events = await (await fixture.request(`/runs/${run.runId}/events`)).text();
		expect(events).toContain("vision.pdf");
		expect(events).toContain("run.completed");
		const damaged = await upload("损坏.docx", Buffer.from("not a Word document"));
		await expect
			.poll(
				async () =>
					(await fixture.application.services.knowledge.listDocuments(project)).find(
						(doc) => doc.id === damaged.id,
					)?.status,
				{ timeout: 15_000 },
			)
			.toBe("failed");
		failEmbedding = true;
		const retryable = await upload("待重试.txt", Buffer.from("vision embedding retry"));
		await expect
			.poll(
				async () =>
					(await fixture.application.services.knowledge.listDocuments(project)).find(
						(doc) => doc.id === retryable.id,
					)?.status,
				{ timeout: 15_000 },
			)
			.toBe("failed");
		failEmbedding = false;
		expect((await fixture.request(`${prefix}/documents/${retryable.id}/retry`, { method: "POST" })).status).toBe(202);
		await expect
			.poll(
				async () =>
					(await fixture.application.services.knowledge.listDocuments(project)).find(
						(doc) => doc.id === retryable.id,
					)?.status,
				{ timeout: 15_000 },
			)
			.toBe("ready");
		expect(requests.every((request) => request.model === "real-test-embedding")).toBe(true);
		expect(JSON.stringify(requests)).not.toContain("system-secret");
		await fixture.restart();
		const after = (await (await fixture.request(`${prefix}/search?q=vision`)).json()) as KnowledgeHit[];
		expect(after.some((hit) => hit.documentId === word.id)).toBe(true);
		expect((await fixture.request(`${prefix}/documents/${pdf.id}`, { method: "DELETE" })).status).toBe(200);
		expect(
			((await (await fixture.request(`${prefix}/search?q=vision`)).json()) as KnowledgeHit[]).some(
				(hit) => hit.documentId === pdf.id,
			),
		).toBe(false);
	} finally {
		await fixture.close();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}, 30_000);
