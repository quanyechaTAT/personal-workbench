import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type MemoryRetrievalResult, MemoryService, PathPolicy } from "@earendil-works/workbench-core";
import { WorkbenchDatabase } from "@earendil-works/workbench-database";
import { expect, test } from "vitest";
import { createPerceptionFixture, imageDocument, scannedDocument, wavDocument } from "./perception-fixture.ts";

test("measures fixed four-layer queries against append-only Markdown component replay without claiming provider accuracy", async () => {
	const setup = await createPerceptionFixture();
	let database: WorkbenchDatabase | undefined;
	try {
		const { fixture } = setup;
		const before = await setup.project("旧组件基准");
		const after = await setup.project("四层基准");
		const foreign = await setup.project("隔离资料");
		const oldBody = `# 项目记忆\n\n## 版本\n项目使用 Python 3.10。\n项目使用 Python 3.12。\n\n## 背景\n${"与问题无关的项目背景。".repeat(300)}\n`;
		await writeFile(join(before.workspacePath, "MEMORY.md"), oldBody);
		const legacy = new MemoryService(
			fixture.application.paths,
			new PathPolicy(fixture.application.paths),
			fixture.application.repositories.memory,
		);
		await legacy.reindex("project", `projects/${before.slug}/MEMORY.md`, before.id);
		for (const [project, text] of [
			[after, "项目使用 Python 3.10。"],
			[after, "项目使用 Python 3.12。"],
			[foreign, "PRIVATE-ONLY Python 4.99。"],
		] as const) {
			const candidate = await fixture.application.services.memory.propose(
				{ project },
				{ kind: "project", proposedText: text, reason: "人工确认基准事实" },
			);
			await fixture.application.services.memory.accept(candidate.id);
		}
		const documents = [
			{ name: "截图.png", bytes: imageDocument() },
			{ name: "扫描.pdf", bytes: scannedDocument() },
			{ name: "录音.wav", bytes: wavDocument() },
		];
		for (const document of documents) {
			const value = await fixture.application.services.knowledge.upload(after, document.name, document.bytes);
			expect((await setup.wait(after, value.id)).status).toBe("ready");
		}
		const session = await fixture.application.createSession({ projectId: after.id });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "不存在的权限文件.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("目录检查已结束；权限验证失败，原因未确认。"),
		]);
		const run = fixture.application.events.start(session.id, { text: "检查目录，保留待验证权限问题。" });
		for await (const _event of fixture.application.events.subscribe(run.runId)) {
			/* real SDK */
		}
		expect((await fixture.application.services.memoryState.episodes(session.id))[0]?.outcome).toBe("failure");
		await fixture.application.services.semantic.rebuildVectors({ project: after });
		await fixture.application.services.memoryState.rebuildVectors(session.id);
		database = new WorkbenchDatabase(fixture.application.paths.database);
		const cases = [
			{ query: "Python", marker: "Python 3.12", layer: "semantic" },
			{ query: "目录", marker: "权限验证失败", layer: "episodic" },
			{ query: "待验证权限", marker: "待验证权限", layer: "working" },
			{ query: "截图", marker: "截图.png", layer: "perceptual" },
			{ query: "扫描", marker: "扫描.pdf", layer: "perceptual" },
			{ query: "录音", marker: "录音.wav", layer: "perceptual" },
		];
		const rows = [];
		for (const item of cases) {
			const oldTimes: number[] = [],
				newTimes: number[] = [];
			let oldHits: string[] = [],
				current: MemoryRetrievalResult | undefined;
			for (let iteration = 0; iteration < 4; iteration++) {
				const started = performance.now();
				// HEAD's literal LIKE branch recalls 500 rows before project filtering; ordinary Markdown has no version validity.
				const candidates = database
					.prepare(
						"SELECT mi.content, mi.project_id FROM memory_index mi JOIN memory_files mf ON mf.id = mi.memory_file_id WHERE lower(mi.content) LIKE lower(?) LIMIT 500",
					)
					.all(`%${item.query}%`) as unknown as Array<{ content: string; project_id: string | null }>;
				oldHits = candidates
					.filter((value) => value.project_id === before.id)
					.slice(0, 5)
					.map((value) => value.content);
				const oldTime = performance.now() - started;
				const newStart = performance.now();
				const response = await fixture.request(
					`/sessions/${session.id}/memory/retrieve?q=${encodeURIComponent(item.query)}`,
				);
				expect(response.status).toBe(200);
				current = (await response.json()) as MemoryRetrievalResult;
				if (iteration) {
					oldTimes.push(oldTime);
					newTimes.push(performance.now() - newStart);
				}
			}
			if (!current) throw new Error("Missing retrieval result");
			const oldContext = `${oldBody.slice(0, 32000)}\n${oldHits.join("\n").slice(0, 12000)}`;
			const newContext = current.fragments.map((value) => `${value.label}\n${value.text}`).join("\n");
			expect(newContext).not.toContain("PRIVATE-ONLY");
			expect(newContext).not.toContain("Python 3.10");
			expect(current.characters).toBeLessThanOrEqual(24000);
			const median = (values: number[]) => Number(values.sort((a, b) => a - b)[1].toFixed(2));
			rows.push({
				query: item.query,
				expectedLayer: item.layer,
				marker: item.marker,
				before: {
					recallAt5: Number(oldHits.some((text) => text.includes(item.marker))),
					staleFactInContext: oldContext.includes("Python 3.10"),
					crossProjectHits: oldHits.filter((text) => text.includes("PRIVATE-ONLY")).length,
					characters: oldContext.length,
					estimatedTokens: Math.ceil(oldContext.length / 3),
					medianLatencyMs: median(oldTimes),
				},
				after: {
					recallAt5: Number(
						current.fragments
							.slice(0, 5)
							.some(
								(value) => value.layer === item.layer && `${value.label}\n${value.text}`.includes(item.marker),
							),
					),
					staleFactInContext: newContext.includes("Python 3.10"),
					crossProjectHits: current.fragments.filter((value) => value.text.includes("PRIVATE-ONLY")).length,
					characters: current.characters,
					estimatedTokens: current.estimatedTokens,
					medianLatencyMs: median(newTimes),
					sources: current.fragments.map((value) => ({
						layer: value.layer,
						label: value.label,
						reason: value.reason,
					})),
				},
			});
		}
		const report = {
			generatedAt: new Date().toISOString(),
			baselineCommit: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: fileURLToPath(new URL("../../../", import.meta.url)),
				encoding: "utf8",
			}).trim(),
			corpusSha256: createHash("sha256")
				.update(oldBody)
				.update(Buffer.concat(documents.map((value) => value.bytes)))
				.update(JSON.stringify(cases))
				.digest("hex"),
			samples: 3,
			baseline:
				"Component replay: ordinary append-only project Markdown, HEAD literal LIKE LIMIT 500 then scope, complete project Memory + duplicate retrieved snippets. Not an old full application or model-answer benchmark.",
			protocol:
				"Real SQLite/sqlite-vec, FS, Pi SDK faux provider, native controlled OCR/ASR/vision/embedding and upgraded authenticated Gateway. Embedding vectors are deliberately constant; no provider semantic accuracy inferred.",
			rows,
		};
		expect(rows.reduce((sum, row) => sum + row.after.recallAt5, 0)).toBeGreaterThan(
			rows.reduce((sum, row) => sum + row.before.recallAt5, 0),
		);
		if (process.env.WORKBENCH_MEMORY_BENCHMARK_REPORT === "1") {
			await writeFile(
				new URL("../../../docs/workbench/FOUR_LAYER_MEMORY_BENCHMARK.json", import.meta.url),
				`${JSON.stringify(report, null, 2)}\n`,
			);
			await writeFile(
				new URL("../../../docs/workbench/FOUR_LAYER_MEMORY_BENCHMARK.md", import.meta.url),
				`# 四层记忆组件对照验证\n\n生成：${report.generatedAt}。基准提交：${report.baselineCommit}。资料哈希：${report.corpusSha256}。\n\n六个固定人工标注问题；每个问题一个相关目标，Recall@5 为前五装配片段是否包含该目标。升级前复现旧 Markdown 追加、LIKE 候选上限后范围过滤和整份项目记忆加重复检索片段；它不是旧应用完整运行。升级后走真实认证 Gateway。两端只比较记忆正文，排除公共系统指令、Skills 与完整 Pi 历史。原 Pi 历史仍可包含旧版本，本表只检查新增上下文。旧链不解析图片、扫描页与音频，因此这部分差异体现新增资料覆盖，不是识别准确率提升。\n\n真实 SQLite、文件系统、Pi SDK、受控 HTTP/WebSocket；向量固定且不模拟语义质量。未调用真实供应商。旧查询延迟只计本机 SQL，升级后包括 HTTP、分层读取、协议 Embedding；不可据此比较供应商延迟。先预热一次，再取三次中位数。字符／3 仅估算 Token。\n\n| 查询 | Recall@5 前→后 | 过期事实进入上下文 前→后 | 跨项目命中 前→后 | 上下文字符 前→后 | 估算 Token 前→后 | 延迟 ms 前→后 |\n|---|---|---|---|---|---|---|\n${rows.map((row) => `| ${row.query} | ${row.before.recallAt5} → ${row.after.recallAt5} | ${row.before.staleFactInContext} → ${row.after.staleFactInContext} | ${row.before.crossProjectHits} → ${row.after.crossProjectHits} | ${row.before.characters} → ${row.after.characters} | ${row.before.estimatedTokens} → ${row.after.estimatedTokens} | ${row.before.medianLatencyMs} → ${row.after.medianLatencyMs} |`).join("\n")}\n\n不把过期事实进入上下文等同模型已误用；不声称所有指标改善。来源和命中理由见 [JSON](FOUR_LAYER_MEMORY_BENCHMARK.json)。\n\n复现：在 packages/workbench-server 设置 WORKBENCH_MEMORY_BENCHMARK_REPORT=1，运行 node ../../node_modules/vitest/dist/cli.js --run test/memory-benchmark.integration.test.ts。测试只使用并清理临时数据目录。\n`,
			);
		}
	} finally {
		database?.close();
		await setup.close();
	}
}, 60000);
