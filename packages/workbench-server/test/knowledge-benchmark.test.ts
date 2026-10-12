import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { KnowledgeHit, KnowledgeSearchResult } from "@earendil-works/workbench-core";
import mammoth from "mammoth";
import { expect, test } from "vitest";
import { DEFAULT_KNOWLEDGE_SETTINGS } from "../src/knowledge-chunker.ts";
import { type DocumentSection, parseKnowledgeDocument } from "../src/knowledge-document-parser.ts";
import { KnowledgeEmbeddingClient } from "../src/knowledge-embedding.ts";
import { encodingTokenizer } from "../src/knowledge-tokenizer.ts";
import { pdfDocument, structuredDocxDocument } from "./fixtures/knowledge-documents.ts";
import { createKnowledgeFixture } from "./knowledge-rag-fixture.ts";

// Exact v015 baseline from HEAD before this upgrade: 1200 characters, 160 overlap, single vector query.
function legacyChunks(sections: DocumentSection[]): Array<{ text: string; startPage?: number; endPage?: number }> {
	const passages: Array<{ text: string; startPage?: number; endPage?: number }> = [];
	for (const section of sections) {
		const content = section.text
			.replace(/\r\n?/gu, "\n")
			.replace(/[\t ]+/gu, " ")
			.trim();
		let start = 0;
		while (start < content.length) {
			let end = Math.min(content.length, start + 1200);
			if (end < content.length) {
				const boundary = Math.max(
					content.lastIndexOf("\n", end),
					content.lastIndexOf("。", end),
					content.lastIndexOf(". ", end),
				);
				if (boundary > start + 600) end = boundary + 1;
			}
			const text = content.slice(start, end).trim();
			if (text) passages.push({ text, startPage: section.page, endPage: section.page });
			if (end >= content.length) break;
			start = Math.max(start + 1, end - 160);
		}
	}
	return passages;
}

interface Measurement {
	hits: KnowledgeHit[];
	contextTokens: number;
	queryTokens: number;
	mqePromptTokens: number;
	latencyMs: number;
}

test("compares the same documents/questions against the v015 algorithm through real SQLite, files, HTTP gateways and deterministic Pi", async () => {
	const tokenizer = encodingTokenizer("cl100k_base");
	const vector = (text: string) => {
		const patterns = [
			/Token|分块/iu,
			/Qwen3|版本|2025/iu,
			/表格|列名|表头/iu,
			/代码|函数|function/iu,
			/Vision|accuracy/iu,
		];
		const values = patterns.map((pattern) => Number(pattern.test(text)));
		return [...values, values.some(Boolean) ? 0 : 1];
	};
	const rig = await createKnowledgeFixture(vector);
	const { fixture } = rig;
	let baselineGateway: ReturnType<typeof createServer> | undefined;
	try {
		const project = await rig.project("结构化检索基准");
		const old = await rig.project("v015检索基准");
		const documents = [
			{
				path: "manual.md",
				bytes: Buffer.from(
					`# 工作规范\n\n## Token 分块\n\n${"中文长段落背景说明，与数值规格无关。".repeat(160)}\n\nToken 分块上限为 192，标题计入。短段落只在同一章节合并。\n\n## Qwen3 版本\n\nQwen3 v2.1 仅使用 2025 年数据，不使用新版模型。\n\n## 表格规范\n\n表格分段必须重复表头和列名。\n\n| 参数 | 说明 |\n| --- | --- |\n${Array.from({ length: 25 }, (_, index) => `| 行 ${index} | 列名 ${index} 的中文说明 |`).join("\n")}\n\n## 代码规范\n\n代码优先按函数边界拆分，保留缩进和围栏。\n\n\`\`\`ts\n${Array.from({ length: 30 }, (_, index) => `function example${index}() {\n  return ${index};\n}\n`).join("\n")}\`\`\``,
				),
			},
			{ path: "policy.docx", bytes: await structuredDocxDocument() },
			{
				path: "vision.pdf",
				bytes: pdfDocument(["Vision accuracy reached 91 percent.", "The experiment used the original dataset."]),
			},
			{ path: "finance.txt", bytes: Buffer.from("财务预算与报销政策。".repeat(170)) },
			{ path: "travel.md", bytes: Buffer.from("# 出差行程\n\n酒店交通安排。".repeat(70)) },
		];
		const cases = [
			{
				query: "Token 怎么分块？",
				rewrites: ["如何设置 Token 分块上限", "Token 分块的上限说明"],
				markers: ["Token 分块上限为 192"],
			},
			{
				query: "Qwen3 v2.1 的 2025 数据限制",
				rewrites: ["2025 的 Qwen3 v2.1 数据限制", "Qwen3 v2.1 数据在 2025 的限制"],
				markers: ["Qwen3 v2.1 仅使用 2025"],
			},
			{
				query: "表格分段如何保留列名？",
				rewrites: ["表格拆分时保留列名", "列名在表格分段中的保留"],
				markers: ["表格分段必须重复表头"],
			},
			{
				query: "代码如何拆分？",
				rewrites: ["代码按函数拆分", "函数边界的代码分块"],
				markers: ["代码优先按函数边界"],
			},
			{ query: "Vision accuracy", rewrites: ["accuracy Vision", "Vision accuracy data"], markers: ["91 percent"] },
		];
		const embeddings = new KnowledgeEmbeddingClient(fixture.embeddingEnvFile);
		const config = await embeddings.config();
		const repository = fixture.application.repositories.knowledge;
		const oldInputs: string[] = [];
		for (const document of documents) {
			await writeFile(join(project.sourcePath ?? "", document.path), document.bytes);
			await writeFile(join(old.sourcePath ?? "", document.path), document.bytes);
			const sections = document.path.endsWith(".docx")
				? [{ text: (await mammoth.extractRawText({ buffer: document.bytes })).value }]
				: (await parseKnowledgeDocument(join(old.sourcePath ?? "", document.path), document.path)).sections;
			const passages = legacyChunks(sections);
			const vectors: number[][] = [];
			for (let offset = 0; offset < passages.length; offset += 16)
				vectors.push(
					...(await embeddings.embed(
						config,
						passages.slice(offset, offset + 16).map((passage) => passage.text),
					)),
				);
			oldInputs.push(...passages.map((passage) => passage.text));
			await repository.replaceFile(
				{
					projectId: old.id,
					path: document.path,
					contentHash: "baseline",
					modelFingerprint: config.fingerprint,
					chunkCount: passages.length,
					indexedAt: new Date().toISOString(),
				},
				passages.map((passage, index) => ({
					...passage,
					projectId: old.id,
					path: document.path,
					ordinal: index,
					vector: vectors[index],
				})),
			);
		}
		await fixture.application.services.knowledge.configure(project, {
			...DEFAULT_KNOWLEDGE_SETTINGS,
			maxChunkTokens: 192,
			minChunkTokens: 48,
			contextTokens: 1024,
			mqe: "always",
		});
		const indexingStart = rig.requests.length;
		expect((await fixture.request(`/projects/${project.id}/knowledge/index`, { method: "POST" })).status).toBe(200);
		const newInputs = rig.requests.slice(indexingStart).flat();
		expect(newInputs.every((input) => tokenizer.count(input) <= 192)).toBe(true);
		// The legacy adapter exposes the original algorithm over loopback HTTP, with the same embedding client and DB.
		baselineGateway = createServer(async (request, response) => {
			try {
				const query = new URL(request.url ?? "/", "http://localhost").searchParams.get("q") ?? "";
				const [queryVector] = await embeddings.embed(config, [query.slice(0, 2000)]);
				const hits = await repository.search(old.id, config.fingerprint, queryVector, 5);
				let remaining = 12000;
				const snippets = hits.flatMap((hit) => {
					const text = hit.text.slice(0, remaining);
					remaining -= text.length;
					return text ? [`Source: ${hit.path}${hit.startPage ? ` (page ${hit.startPage})` : ""}\n${text}`] : [];
				});
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						hits,
						contextTokens: tokenizer.count(
							`<workbench-retrieved-knowledge>\n${snippets.join("\n\n---\n\n")}\n</workbench-retrieved-knowledge>`,
						),
						queryTokens: tokenizer.count(query),
						mqePromptTokens: 0,
					}),
				);
			} catch {
				response.writeHead(500);
				response.end("baseline failed");
			}
		});
		await new Promise<void>((resolve) => baselineGateway?.listen(0, "127.0.0.1", resolve));
		const address = baselineGateway.address();
		if (!address || typeof address === "string") throw new Error("No baseline Gateway port");
		const rows = [];
		for (const item of cases) {
			const baseline: Measurement[] = [];
			const upgraded: Measurement[] = [];
			// Warm both paths, then measure three paired iterations. There is no real provider latency in this fixture.
			for (let iteration = 0; iteration < 4; iteration++) {
				let started = performance.now();
				const oldResponse = await fetch(
					`http://127.0.0.1:${address.port}/search?q=${encodeURIComponent(item.query)}`,
				);
				expect(oldResponse.status).toBe(200);
				const oldResult = (await oldResponse.json()) as Omit<Measurement, "latencyMs">;
				const oldLatency = performance.now() - started;
				let mqePromptTokens = 0;
				fixture.faux.setResponses([
					(context) => {
						expect(context.tools?.length ?? 0).toBe(0);
						mqePromptTokens = tokenizer.count(`${context.systemPrompt}\n${JSON.stringify(context.messages)}`);
						return fauxAssistantMessage(JSON.stringify({ queries: item.rewrites }));
					},
				]);
				started = performance.now();
				const result = (await (
					await fixture.request(
						`/projects/${project.id}/knowledge/retrieve?q=${encodeURIComponent(item.query)}&limit=5`,
					)
				).json()) as KnowledgeSearchResult;
				expect(result.queries[0]).toBe(item.query);
				expect(result.queries.length).toBeLessThanOrEqual(3);
				expect(result.contextTokens).toBeLessThanOrEqual(1024);
				if (iteration) {
					baseline.push({ ...oldResult, latencyMs: oldLatency });
					upgraded.push({
						hits: result.hits,
						contextTokens: result.contextTokens,
						queryTokens: result.queries.reduce((sum, query) => sum + tokenizer.count(query), 0),
						mqePromptTokens,
						latencyMs: performance.now() - started,
					});
				}
			}
			const summarize = (values: Measurement[]) => {
				const first = values[0];
				const relevant = (hit: KnowledgeHit) => item.markers.some((marker) => hit.text.includes(marker));
				return {
					top1Hit: Boolean(first.hits[0] && relevant(first.hits[0])),
					hitAt5: first.hits.some(relevant),
					relevantHits: first.hits.filter(relevant).length,
					irrelevantHits: first.hits.filter((hit) => !relevant(hit)).length,
					returnedHits: first.hits.length,
					contextTokens: first.contextTokens,
					queryEmbeddingTokens: first.queryTokens,
					mqePromptTokens: first.mqePromptTokens,
					medianLatencyMs: Number(
						values
							.map((value) => value.latencyMs)
							.sort((a, b) => a - b)[1]
							.toFixed(2),
					),
					sources: first.hits.map((hit) => ({
						path: hit.path,
						headingPath: hit.headingPath,
						page: hit.startPage,
					})),
				};
			};
			rows.push({
				question: item.query,
				groundTruth: item.markers,
				before: summarize(baseline),
				after: summarize(upgraded),
			});
		}
		const inputMetrics = (inputs: string[]) => ({
			chunks: inputs.length,
			embeddingTokens: inputs.reduce((sum, text) => sum + tokenizer.count(text), 0),
			maxChunkTokens: Math.max(...inputs.map((text) => tokenizer.count(text))),
		});
		const report = {
			generatedAt: new Date().toISOString(),
			baselineCommit: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: fileURLToPath(new URL("../../../", import.meta.url)),
				encoding: "utf8",
			}).trim(),
			corpusSha256: createHash("sha256")
				.update(Buffer.concat(documents.flatMap((document) => [Buffer.from(document.path), document.bytes])))
				.digest("hex"),
			documents: documents.map(({ path, bytes }) => ({ path, bytes: bytes.length })),
			tokenizer: tokenizer.name,
			samples: 3,
			baseline: "v015:1200 characters / 160 overlap / top5 single vector / 12000 character context",
			upgraded:
				"192 token chunks / 48 minimum / 1024 token context / hybrid RRF k60 / at most 2 tool-free Pi MQE rewrites",
			indexing: { before: inputMetrics(oldInputs), after: inputMetrics(newInputs) },
			rows,
		};
		expect(report.indexing.before.maxChunkTokens).toBeGreaterThan(192);
		expect(report.indexing.after.maxChunkTokens).toBeLessThanOrEqual(192);
		if (process.env.WORKBENCH_RAG_BENCHMARK_REPORT === "1") {
			const markdown = `# RAG 升级对照验证\n\n生成时间：${report.generatedAt}。旧实现基准：${report.baselineCommit}。语料 SHA-256：${report.corpusSha256}。\n\n真实 SQLite/sqlite-vec、文件系统、解析 Worker 和两个本机 HTTP Gateway；Embedding 返回固定语义特征向量，MQE 通过真实 Pi SDK 的 faux provider 返回预定表达。未调用真实或付费模型。这是功能与资源上限回归，不能外推线上准确率、计费或服务延迟。\n\n同一组 ${documents.length} 份文档、${cases.length} 个问题。每条路径先预热一次，再取三次延迟中位数；HTTP 及解析配置见测试源码。相关结果由表中的完整答案标记判定，未含标记的返回片段计为无关；命中率和无关数均为最终返回结果，不是所有候选。\n\n| 指标 | 升级前 | 升级后 |\n|---|---:|---:|\n| 索引片段 | ${report.indexing.before.chunks} | ${report.indexing.after.chunks} |\n| 索引 Embedding Token 总量 | ${report.indexing.before.embeddingTokens} | ${report.indexing.after.embeddingTokens} |\n| 单片段最大 Token | ${report.indexing.before.maxChunkTokens} | ${report.indexing.after.maxChunkTokens} |\n| 首位命中 | ${rows.filter((row) => row.before.top1Hit).length}/${cases.length} | ${rows.filter((row) => row.after.top1Hit).length}/${cases.length} |\n| 前五结果命中 | ${rows.filter((row) => row.before.hitAt5).length}/${cases.length} | ${rows.filter((row) => row.after.hitAt5).length}/${cases.length} |\n| 返回无关片段合计 | ${rows.reduce((sum, row) => sum + row.before.irrelevantHits, 0)} | ${rows.reduce((sum, row) => sum + row.after.irrelevantHits, 0)} |\n\n| 问题 | 首位命中 前→后 | 无关片段 前→后 | 上下文 Token 前→后 | 查询 Embedding Token 前→后 | MQE 提示 Token 后 | 延迟 ms 前→后 |\n|---|---|---|---|---|---:|---|\n${rows.map((row) => `| ${row.question} | ${row.before.top1Hit} → ${row.after.top1Hit} | ${row.before.irrelevantHits} → ${row.after.irrelevantHits} | ${row.before.contextTokens} → ${row.after.contextTokens} | ${row.before.queryEmbeddingTokens} → ${row.after.queryEmbeddingTokens} | ${row.after.mqePromptTokens} | ${row.before.medianLatencyMs} → ${row.after.medianLatencyMs} |`).join("\n")}\n\nMQE 增加生成请求及查询 Token；表中提示 Token 使用 cl100k_base 对测试提示计数，未计真实服务输出、计费或聊天模板。旧路径复现原字符切片与单向量检索；其 Gateway 是只在此测试内存在的 HTTP 适配器。升级后走工作台真实 /knowledge/retrieve。上下文包装文字有变化，因此绝对 Token 差值也包括引用开销。RRF 无独立 reranker，无法保证每个问题都有相关命中。\n\n结构化分块可能增加片段数量和重复标题开销；MQE 也可能增加延迟。本次仅记录测量值，不声称所有指标均改善。完整逐题来源保存在 [JSON 记录](PROJECT_RAG_BENCHMARK.json)。\n\n复现：在 packages/workbench-server 下设置 WORKBENCH_RAG_BENCHMARK_REPORT=1，运行 node ../../node_modules/vitest/dist/cli.js --run test/knowledge-benchmark.test.ts。全部数据写入系统临时目录，结束后清理；报告写入 docs/workbench，不打开现有工作台数据库。\n`;
			await writeFile(new URL("../../../docs/workbench/PROJECT_RAG_BENCHMARK.md", import.meta.url), markdown);
			await writeFile(
				new URL("../../../docs/workbench/PROJECT_RAG_BENCHMARK.json", import.meta.url),
				`${JSON.stringify(report, null, 2)}\n`,
			);
		}
	} finally {
		if (baselineGateway) {
			baselineGateway.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				baselineGateway?.close((error) => (error ? reject(error) : resolve())),
			);
		}
		await rig.close();
	}
}, 60_000);
