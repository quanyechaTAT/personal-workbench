import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type {
	KnowledgeDerivedDocument,
	KnowledgeDocument,
	KnowledgeSearchResult,
} from "@earendil-works/workbench-core";
import { expect, test, vi } from "vitest";
import { DEFAULT_KNOWLEDGE_SETTINGS } from "../src/knowledge-chunker.ts";
import { encodingTokenizer } from "../src/knowledge-tokenizer.ts";
import { pdfDocument, structuredDocxDocument } from "./fixtures/knowledge-documents.ts";
import { createKnowledgeFixture } from "./knowledge-rag-fixture.ts";

test("uses real Pi tool-free MQE, batch embeddings, Chinese FTS/RRF, settings invalidation and stable ids across restart", async () => {
	const rig = await createKnowledgeFixture();
	const { fixture } = rig;
	try {
		const project = await rig.project("星辰研究");
		const other = await rig.project("隔离研究");
		await writeFile(
			join(project.sourcePath ?? "", "rules.md"),
			"# 星辰项目\n\n## 分块\n\n结构化分块的 Token 上限为 256，标题也计入。\n\n## 版本\n\nQwen3 v2.1 仅使用 2025 年数据，不使用新版模型。",
		);
		await writeFile(
			join(other.sourcePath ?? "", "private.md"),
			"# 隔离项目\n\n星辰项目机密：PRIVATE-ONLY 分块 777 Token。",
		);
		const service = fixture.application.services.knowledge;
		await service.index(project);
		await service.index(other);
		const prefix = `/projects/${project.id}/knowledge`;
		expect(
			(
				await fixture.request(`${prefix}/settings`, {
					method: "PUT",
					body: JSON.stringify({
						...DEFAULT_KNOWLEDGE_SETTINGS,
						mqe: "always",
						contextTokens: 600,
						maxChunkTokens: 256,
						minChunkTokens: 40,
					}),
				})
			).status,
		).toBe(200);
		expect((await service.status(project)).staleFileCount).toBe(1);
		const stale = await service.retrieve(project, "分块 Token 上限");
		expect(stale.diagnostics.join()).toContain("过期");
		expect(stale.hits).toEqual([]);
		await fixture.request(`${prefix}/index`, { method: "POST" });
		const query = "分块 Token 上限";
		let toolFree = false;
		fixture.faux.setResponses([
			(context, options) => {
				toolFree = (context.tools?.length ?? 0) === 0;
				expect(context.systemPrompt).toContain("不得回答问题");
				expect(context.messages).toHaveLength(1);
				expect(JSON.stringify(context.messages)).not.toContain("fixture-secret");
				expect(options?.maxRetries).toBe(0);
				return fauxAssistantMessage(JSON.stringify({ queries: ["Token 分块的上限", "分块上限 Token"] }));
			},
		]);
		const result = (await (
			await fixture.request(`${prefix}/retrieve?q=${encodeURIComponent(query)}`)
		).json()) as KnowledgeSearchResult;
		expect(toolFree).toBe(true);
		expect(result.queries).toEqual([query, "Token 分块的上限", "分块上限 Token"]);
		expect(rig.requests.at(-1)).toEqual(result.queries);
		expect(result.hits[0].text).toContain("256");
		expect(result.hits[0].headingPath).toEqual(["星辰项目", "分块"]);
		expect(result.hits[0].matches?.some((match) => match.method === "keyword")).toBe(true);
		expect(new Set(result.hits.map((hit) => hit.id)).size).toBe(result.hits.length);
		expect(JSON.stringify(result)).not.toContain("PRIVATE-ONLY");
		expect(result.contextTokens).toBe(encodingTokenizer("cl100k_base").count(result.context));
		expect(result.contextTokens).toBeLessThanOrEqual(600);
		expect(result.context).toContain("rules.md");
		const ids = (await fixture.application.repositories.knowledge.listChunks(project.id)).map((chunk) => chunk.id);
		const requestsBefore = rig.requests.length;
		await fixture.request(`${prefix}/index`, { method: "POST" });
		expect(rig.requests.length).toBe(requestsBefore);
		await fixture.restart();
		expect((await fixture.application.services.knowledge.settings(project)).mqe).toBe("always");
		expect(
			(await fixture.application.repositories.knowledge.listChunks(project.id)).map((chunk) => chunk.id),
		).toEqual(ids);
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "private.md" }), { stopReason: "toolUse" }),
		]);
		const fallback = (await (
			await fixture.request(`${prefix}/retrieve?q=${encodeURIComponent(query)}`)
		).json()) as KnowledgeSearchResult;
		expect(fallback.queries).toEqual([query]);
		expect(fallback.diagnostics.join()).toContain("回退");
		await fixture.application.services.knowledge.configure(project, {
			...DEFAULT_KNOWLEDGE_SETTINGS,
			maxChunkTokens: 256,
			minChunkTokens: 40,
			mqe: "off",
		});
		rig.setMode("fail");
		const keyword = (await (
			await fixture.request(`${prefix}/retrieve?q=${encodeURIComponent("分块上限")}`)
		).json()) as KnowledgeSearchResult;
		expect(keyword.hits[0].text).toContain("256");
		expect(keyword.hits.every((hit) => hit.matches?.every((match) => match.method === "keyword"))).toBe(true);
		expect(keyword.diagnostics.join()).toContain("降级为关键词");
		expect(JSON.stringify(keyword)).not.toContain("fixture-secret");
		rig.setMode("ok");
		await writeFile(
			join(project.sourcePath ?? "", "repeated-table.md"),
			`# 重复表格\n\n| 标识 | 说明 |\n| --- | --- |\n${"| fixed | 完全相同的中文表格行，用于验证重复内容仍对应不同来源片段。 |\n".repeat(60)}`,
		);
		await fixture.application.services.knowledge.index(project);
		const repeated = (await fixture.application.repositories.knowledge.listChunks(project.id)).filter(
			(chunk) => chunk.path === "repeated-table.md",
		);
		expect(repeated.length).toBeGreaterThan(2);
		expect(new Set(repeated.map((chunk) => chunk.text)).size).toBeLessThan(repeated.length);
		expect(new Set(repeated.map((chunk) => chunk.id)).size).toBe(repeated.length);
	} finally {
		await rig.close();
	}
}, 45_000);

test("uploads real semantic DOCX/PDF and collision-named Markdown; keeps originals and precise source maps without a tokenizer", async () => {
	const rig = await createKnowledgeFixture();
	const { fixture } = rig;
	try {
		const project = await rig.project("原件与派生资料");
		const prefix = `/projects/${project.id}/knowledge`;
		const upload = async (name: string, bytes: Buffer) =>
			(await (
				await fixture.request(`${prefix}/documents?name=${encodeURIComponent(name)}`, {
					method: "POST",
					headers: { "content-type": "application/octet-stream" },
					body: new Uint8Array(bytes),
				})
			).json()) as KnowledgeDocument;
		const wordBytes = await structuredDocxDocument();
		const word = await upload("规范.docx", wordBytes);
		const pdf = await upload(
			"report.pdf",
			pdfDocument([
				[
					{ text: "Vision report", size: 24 },
					{ text: "Accuracy reached 91 percent.", size: 12 },
					{ text: "Use the original dataset.", size: 12 },
				],
				"Budget notes.",
			]),
		);
		const original = Buffer.from("# 原标题\r\n\r\n中文正文。\r\n\r\n第二段。", "utf8");
		const markdown = await upload("document.md", original);
		await expect
			.poll(
				async () =>
					(await fixture.application.services.knowledge.listDocuments(project)).filter(
						(document) => document.status === "ready",
					).length,
				{ timeout: 15_000 },
			)
			.toBe(3);
		const preview = await fixture.application.services.knowledge.preview(project, word.id);
		expect(preview.derived?.markdown).toContain("# 检索规范");
		expect(preview.derived?.markdown).toContain("| 参数 | 数值 |");
		expect(preview.passages[0].headingPath).toEqual(["检索规范"]);
		expect(preview.derived?.sources[0]).toMatchObject({ kind: "docx", block: 1 });
		expect(preview.derived?.diagnostics.join()).toContain("页码");
		const pdfPreview = await fixture.application.services.knowledge.preview(project, pdf.id);
		expect(pdfPreview.derived?.markdown).toContain("## Vision report");
		expect(pdfPreview.passages.map((passage) => passage.startPage)).toEqual([1, 2]);
		expect(pdfPreview.derived?.sources[0]).toMatchObject({ kind: "pdf", page: 1, textItemStart: 0 });
		expect(Buffer.from(await (await fixture.request(`${prefix}/documents/${word.id}/file`)).arrayBuffer())).toEqual(
			wordBytes,
		);
		expect(
			Buffer.from(await (await fixture.request(`${prefix}/documents/${markdown.id}/file`)).arrayBuffer()),
		).toEqual(original);
		expect(await (await fixture.request(`${prefix}/documents/${markdown.id}/markdown`)).text()).toBe(
			original.toString().replaceAll("\r\n", "\n"),
		);
		const map = (await (
			await fixture.request(`${prefix}/documents/${markdown.id}/sources`)
		).json()) as KnowledgeDerivedDocument;
		expect(map.sources.find((source) => source.startLine === 3)).toMatchObject({ originalStart: 9, originalEnd: 16 });
		const env = await readFile(fixture.embeddingEnvFile, "utf8");
		await writeFile(fixture.embeddingEnvFile, env.replace(/^EMBED_TOKENIZER.*\n/gmu, ""));
		const text = await upload("只保留原始段落.txt", Buffer.from("第一段文本。\n\n第二段内容。"));
		await expect
			.poll(
				async () =>
					(await fixture.application.services.knowledge.listDocuments(project)).find(
						(document) => document.id === text.id,
					)?.status,
				{ timeout: 15_000 },
			)
			.toBe("failed");
		const failed = await fixture.application.services.knowledge.preview(project, text.id);
		expect(failed.document.error).toContain("tokenizer");
		expect(failed.derived?.markdown).toBe("第一段文本。\n\n第二段内容。");
		expect(failed.derived?.diagnostics.join()).toContain("未推断");
		expect((await fixture.request(`${prefix}/documents/${text.id}/markdown`)).status).toBe(200);
		expect((await fixture.application.services.knowledge.retrieve(project, "原标题")).hits).toEqual([]);
		await writeFile(fixture.embeddingEnvFile, env);
		expect((await fixture.request(`${prefix}/index`, { method: "POST" })).status).toBe(200);
		expect(
			(await fixture.application.services.knowledge.listDocuments(project)).every(
				(document) => document.status === "ready",
			),
		).toBe(true);
		expect((await fixture.application.services.knowledge.original(project, markdown.id)).bytes).toEqual(original);
	} finally {
		await rig.close();
	}
}, 45_000);

test("cancels queued/active documents, HTTP retrieval and chat preparation; preserves committed chunks and current-session-only references", async () => {
	const rig = await createKnowledgeFixture();
	const { fixture } = rig;
	try {
		const project = await rig.project("取消验证");
		await writeFile(
			join(project.sourcePath ?? "", "facts.md"),
			"# Qwen3\n\nQwen3 使用 2025 年数据。\n\n# 其他\n\n星辰项目结构化分块。",
		);
		await fixture.application.services.knowledge.index(project);
		await fixture.application.services.knowledge.configure(project, { ...DEFAULT_KNOWLEDGE_SETTINGS, mqe: "off" });
		const prefix = `/projects/${project.id}/knowledge`;
		rig.setMode("hold");
		const first = await fixture.application.services.knowledge.upload(
			project,
			"阻塞.txt",
			Buffer.from("需要取消的分块任务"),
		);
		const queued = await fixture.application.services.knowledge.upload(
			project,
			"排队.txt",
			Buffer.from("排队也可以立即取消"),
		);
		await expect
			.poll(
				async () =>
					(await fixture.application.services.knowledge.listDocuments(project)).find(
						(document) => document.id === first.id,
					)?.stage,
				{ timeout: 15_000 },
			)
			.toBe("embedding");
		const cancel = await fixture.request(`${prefix}/documents/${queued.id}/cancel`, { method: "POST" });
		expect(cancel.status).toBe(200);
		expect(await cancel.json()).toMatchObject({ status: "failed", error: "文档处理已取消" });
		expect((await fixture.request(`${prefix}/documents/${first.id}/cancel`, { method: "POST" })).status).toBe(200);
		expect((await fixture.application.services.knowledge.original(project, first.id)).bytes.toString()).toContain(
			"需要取消",
		);
		const controller = new AbortController();
		const before = rig.requests.length;
		const retrieval = fixture.request(`${prefix}/retrieve?q=Qwen3`, { signal: controller.signal });
		await expect.poll(() => rig.requests.length).toBeGreaterThan(before);
		controller.abort();
		await expect(retrieval).rejects.toMatchObject({ name: "AbortError" });
		await expect.poll(() => rig.disconnected).toBeGreaterThan(1);
		rig.setMode("ok");
		const session = await fixture.application.createSession({ projectId: project.id });
		const otherSession = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([fauxAssistantMessage("研究 Qwen3。")]);
		const begin = (await (
			await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "正在研究 Qwen3，数据时间为 2025。" }),
			})
		).json()) as { runId: string };
		expect(await (await fixture.request(`/runs/${begin.runId}/events`)).text()).toContain("run.completed");
		await fixture.application.services.knowledge.configure(project, { ...DEFAULT_KNOWLEDGE_SETTINGS, mqe: "auto" });
		fixture.faux.setResponses([
			(context) => {
				expect(context.tools?.length ?? 0).toBe(0);
				expect(JSON.stringify(context.messages)).toContain("Qwen3");
				return fauxAssistantMessage('{"queries":["Qwen3 使用的 2025 年数据"]}');
			},
		]);
		const context = await fixture.application.contextForSession(session.id, "它使用的数据是哪一年？");
		expect(context.knowledge?.queries).toEqual(["它使用的数据是哪一年？", "Qwen3 使用的 2025 年数据"]);
		expect(
			(await fixture.application.contextForSession(otherSession.id, "它使用的数据是哪一年？")).knowledge?.mqe
				.applied,
		).toBe(false);
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("knowledge_search", { query: "它使用的数据是哪一年？" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(context.tools?.length ?? 0).toBe(0);
				expect(JSON.stringify(context.messages)).toContain("Qwen3");
				return fauxAssistantMessage('{"queries":["Qwen3 使用的 2025 年数据"]}');
			},
			fauxAssistantMessage("Qwen3 使用 2025 年数据。"),
		]);
		const toolRun = (await (
			await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "检索 Qwen3" }),
			})
		).json()) as { runId: string };
		const toolEvents = await (await fixture.request(`/runs/${toolRun.runId}/events`)).text();
		expect(toolEvents).toContain("它使用的数据是哪一年？");
		expect(toolEvents).toContain("Qwen3 使用的 2025 年数据");
		expect(toolEvents).toContain("run.completed");
		await fixture.application.services.knowledge.configure(project, { ...DEFAULT_KNOWLEDGE_SETTINGS, mqe: "off" });
		rig.setMode("hold");
		const callCount = rig.requests.length;
		const preparation = vi.spyOn(fixture.application, "contextForSession");
		const transcript = vi.spyOn(fixture.application.services.sessions, "readTranscript");
		const build = vi.spyOn(fixture.application.context, "build");
		const retrieve = vi.spyOn(fixture.application.services.knowledge, "retrieve");
		let early: string | undefined;
		const sending = fixture
			.request(`/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Qwen3 数据" }) })
			.then(
				async (response) => {
					early = `${response.status} ${await response.text()}`;
					return response;
				},
				(error: unknown) => {
					early = String(error);
					return undefined;
				},
			);
		try {
			await expect
				.poll(
					() => {
						if (early) throw new Error(`Chat preparation ended before embedding: ${early}`);
						return rig.requests.length;
					},
					{ timeout: 15000 },
				)
				.toBeGreaterThan(callCount);
		} catch {
			throw new Error(
				`Preparation trace: context=${preparation.mock.calls.length}, transcript=${transcript.mock.calls.length}, build=${build.mock.calls.length}, retrieve=${retrieve.mock.calls.length}, response=${early ?? "pending"}`,
			);
		}
		expect((await fixture.request(`/sessions/${session.id}/abort`, { method: "POST" })).status).toBe(202);
		expect((await sending)?.status).toBeGreaterThanOrEqual(400);
		expect(fixture.application.events.getActiveRunId(session.id)).toBeUndefined();
		rig.setMode("ok");
		expect((await fixture.application.repositories.knowledge.listChunks(project.id)).length).toBe(2);
		await fixture.application.services.knowledge.retryDocument(project, first.id);
		await expect
			.poll(
				async () =>
					(await fixture.application.services.knowledge.listDocuments(project)).find(
						(document) => document.id === first.id,
					)?.status,
				{ timeout: 15_000 },
			)
			.toBe("ready");
	} finally {
		await rig.close();
	}
}, 45_000);
