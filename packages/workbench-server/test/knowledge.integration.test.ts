import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("indexes project files with .env embeddings, searches in chat, and restores the derived index", async () => {
	const fixture = await createAssistantFixture();
	const submitted: string[] = [];
	const embeddingServer = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const parsed = JSON.parse(body) as { input: string[] };
		submitted.push(...parsed.input);
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				data: parsed.input.map((text, index) => ({
					index,
					embedding: /vision|视觉/iu.test(text) ? [1, 0] : [0, 1],
				})),
			}),
		);
	});
	await new Promise<void>((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
	try {
		const address = embeddingServer.address();
		if (!address || typeof address === "string") throw new Error("No embedding test port");
		const root = join(fixture.root, "视觉学习");
		await mkdir(root);
		await writeFile(
			fixture.embeddingEnvFile,
			`EMBED_API_KEY=project-test-secret\nEMBED_BASE_URL=http://127.0.0.1:${address.port}/v1\nEMBED_MODEL_NAME=test-embedding\nEMBED_TOKENIZER=cl100k_base\nEMBED_TOKENIZER_MODEL=test-embedding\n`,
		);
		await writeFile(
			join(root, ".env"),
			"API_KEY=ignored-project-secret\nBASEURL=https://invalid.example\nMODELNAME=wrong\n",
		);
		await writeFile(join(root, "README.md"), "视觉 vision classification experiment and baseline.");
		await writeFile(join(root, "notes.txt"), "Finance budget notes.");
		const created = await fixture.request("/projects", {
			method: "POST",
			body: JSON.stringify({ sourcePath: root }),
		});
		expect(created.status).toBe(201);
		const project = (await created.json()) as { id: string; name: string };
		expect(project.name).toBe("视觉学习");
		expect((await fixture.application.services.files.list("", root)).map((entry) => entry.name)).not.toContain(
			".env",
		);
		expect((await fixture.request(`/projects/${project.id}/files/read?path=.env`)).status).toBe(403);
		await fixture.application.services.knowledge.index(await fixture.application.services.projects.get(project.id));
		const indexed = await fixture.request(`/projects/${project.id}/knowledge/index`, { method: "POST" });
		expect(indexed.status).toBe(200);
		expect(await indexed.json()).toMatchObject({
			configured: true,
			fileCount: 2,
			chunkCount: 2,
			model: "test-embedding",
		});
		expect(submitted.join("\n")).not.toContain("project-test-secret");
		const hits = (await (
			await fixture.request(`/projects/${project.id}/knowledge/search?q=vision`)
		).json()) as Array<{ path: string }>;
		expect(hits[0]?.path).toBe("README.md");
		const session = await fixture.application.createSession({ projectId: project.id });
		const context = await fixture.application.contextForSession(session.id, "vision baseline");
		expect(context.turn?.appendSystemPrompt?.join("\n")).toContain("README.md");
		expect(JSON.stringify(context)).not.toContain("project-test-secret");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("knowledge_search", { query: "vision" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("已检索项目知识"),
		]);
		const run = (await (
			await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "查找 vision" }),
			})
		).json()) as { runId: string };
		const events = await (await fixture.request(`/runs/${run.runId}/events`)).text();
		expect(events).toContain("tool.completed");
		expect(events).toContain("run.completed");
		await fixture.restart();
		expect(await (await fixture.request(`/projects/${project.id}/knowledge`)).json()).toMatchObject({
			fileCount: 2,
			chunkCount: 2,
		});
		const restoredHits = (await (
			await fixture.request(`/projects/${project.id}/knowledge/search?q=vision`)
		).json()) as Array<{ path: string }>;
		expect(restoredHits[0]?.path).toBe("README.md");
		await writeFile(join(root, "notes.txt"), "Updated finance budget notes.");
		await fixture.request(`/projects/${project.id}/knowledge/index`, { method: "POST" });
		expect(await readFile(join(root, "notes.txt"), "utf8")).toContain("Updated");
	} finally {
		await fixture.close();
		await new Promise<void>((resolve, reject) =>
			embeddingServer.close((error) => (error ? reject(error) : resolve())),
		);
	}
}, 30_000);
