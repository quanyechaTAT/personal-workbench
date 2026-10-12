import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KnowledgeDocument } from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { validateAudio } from "../src/perception-adapter.ts";
import { PerceptionConfiguration } from "../src/perception-config.ts";
import { createPerceptionFixture, imageDocument, scannedDocument, wavDocument } from "./perception-fixture.ts";

test("native OCR, scanned PDF and streaming ASR are searchable with actual locators through Gateway", async () => {
	const setup = await createPerceptionFixture();
	try {
		const project = await setup.project("感知 中文 空格");
		const other = await setup.project("隔离项目");
		const ids: string[] = [];
		for (const [name, bytes] of [
			["截图.png", imageDocument()],
			["扫描.pdf", scannedDocument()],
			["记录.wav", wavDocument()],
		] as const) {
			const response = await setup.fixture.request(
				`/projects/${project.id}/knowledge/documents?name=${encodeURIComponent(name)}`,
				{ method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(bytes) },
			);
			expect(response.status).toBe(202);
			const document = (await response.json()) as KnowledgeDocument;
			ids.push(document.id);
			expect(await setup.wait(project, document.id)).toMatchObject({ status: "ready", contentVersion: 1 });
		}
		const hits = await setup.fixture.application.services.knowledge.search(project, "星辰 Python 3.12", 20);
		expect(new Set(hits.map((hit) => hit.documentId))).toEqual(new Set(ids));
		expect(hits.find((hit) => hit.name === "截图.png")?.sources?.some((source) => source.region?.width === 330)).toBe(
			true,
		);
		expect(hits.find((hit) => hit.name === "扫描.pdf")?.sources?.some((source) => source.page === 1)).toBe(true);
		const audio = hits.find((hit) => hit.name === "记录.wav");
		expect(audio?.sources?.find((source) => source.kind === "transcript")).toMatchObject({
			beginMs: 120,
			endMs: 880,
			origin: "model",
		});
		expect(audio?.text).not.toContain("临时草稿");
		const audioPreview = await setup.fixture.application.services.knowledge.preview(project, ids[2]);
		expect(audioPreview.derived?.markdown.match(/录音确认/gu)).toHaveLength(1);
		expect(await setup.fixture.application.services.knowledge.search(other, "星辰")).toEqual([]);
		expect((await setup.fixture.request(`/projects/${other.id}/knowledge/documents/${ids[0]}/file`)).status).toBe(
			404,
		);
		expect(
			(await setup.fixture.request(`/projects/${project.id}/knowledge/documents/${ids[1]}/page?page=1`)).headers.get(
				"content-type",
			),
		).toBe("image/png");
		const before = { ...setup.counts };
		await setup.fixture.restart();
		await setup.fixture.application.services.knowledge.retryDocument(project, ids[0]);
		expect((await setup.wait(project, ids[0])).status).toBe("ready");
		expect(setup.counts.ocr).toBe(before.ocr);
		expect(setup.counts.vision).toBe(before.vision);
		const duplicated = await setup.fixture.application.services.knowledge.upload(
			project,
			"重复截图.png",
			imageDocument(),
		);
		expect(duplicated.id).toBe(ids[0]);
		await setup.fixture.application.services.knowledge.deleteIndex(project, ids[0]);
		expect((await setup.fixture.application.services.knowledge.original(project, ids[0])).bytes).toEqual(
			imageDocument(),
		);
		await setup.fixture.application.services.knowledge.deleteDocument(project, ids[0]);
		expect(
			(await setup.fixture.application.services.knowledge.listDocuments(project)).map((value) => value.id),
		).not.toContain(ids[0]);
		const serialized =
			JSON.stringify(hits) + JSON.stringify(await setup.fixture.application.services.knowledge.status(project));
		expect(serialized).not.toContain("fixture-perception-secret");
	} finally {
		await setup.close();
	}
});

test("audio rejects malformed encoding and premature completion; captions retain separate final sentence locators", async () => {
	const bytes = wavDocument();
	const invalidSize = Buffer.from(bytes);
	invalidSize.writeUInt32LE(0, 4);
	expect(() => validateAudio(invalidSize, "错误.wav")).toThrow("转换");
	const invalidAlignment = Buffer.from(bytes);
	invalidAlignment.writeUInt16LE(4, 32);
	expect(() => validateAudio(invalidAlignment, "错误.wav")).toThrow("转换");
	const stereoFrame = Buffer.alloc(417);
	stereoFrame.writeUInt32BE(0xfffb9000);
	expect(() => validateAudio(stereoFrame, "双声道.mp3")).toThrow("转换");
	const monoFrame = Buffer.alloc(417);
	monoFrame.writeUInt32BE(0xfffb90c0);
	expect(validateAudio(monoFrame, "单声道.mp3").format).toBe("mp3");
	expect(() => validateAudio(monoFrame.subarray(0, 300), "截断.mp3")).toThrow("转换");
	const setup = await createPerceptionFixture();
	try {
		const project = await setup.project("字幕与协议");
		setup.setExtraSentence(true);
		const audio = await setup.fixture.application.services.knowledge.upload(project, "时间段.wav", bytes);
		expect((await setup.wait(project, audio.id)).status).toBe("ready");
		const response = await setup.fixture.request(`/projects/${project.id}/knowledge/documents/${audio.id}/captions`);
		const text = await response.text();
		expect(text).toContain("00:00:00.120 --> 00:00:00.880\n录音确认");
		expect(text).toContain("00:00:00.900 --> 00:00:01.600\n尚未验证 OCR 权限。");
		expect(text.match(/录音确认/gu)).toHaveLength(1);
		const retrieved = await setup.fixture.application.services.knowledge.retrieve(project, "录音 OCR 权限", 8);
		expect(retrieved.context).toContain("音频 120–1600 ms");
		expect(retrieved.context).toContain("音频 900–1600 ms：尚未验证 OCR 权限。");
		expect(
			(await setup.fixture.request(`/projects/${project.id}/knowledge/documents/${audio.id}/view`)).headers.get(
				"x-content-type-options",
			),
		).toBe("nosniff");
		setup.setPrematureAsr(true);
		const different = Buffer.from(bytes);
		different[44] = 1;
		const interrupted = await setup.fixture.application.services.knowledge.upload(project, "提前结束.wav", different);
		expect(await setup.wait(project, interrupted.id)).toMatchObject({
			status: "failed",
			error: "ASR 返回无效协议，未发布转写",
		});
		expect((await setup.fixture.application.services.knowledge.preview(project, interrupted.id)).passages).toEqual(
			[],
		);
	} finally {
		await setup.close();
	}
});

test("project indexing snapshots text, images, scanned PDF and audio; versions and file-before-database caches survive recovery", async () => {
	const setup = await createPerceptionFixture();
	try {
		const project = await setup.project("扫描管理原件");
		const service = setup.fixture.application.services.knowledge;
		for (const [name, bytes] of [
			["说明.txt", Buffer.from("项目的原始版本说明。")],
			["截图.png", imageDocument()],
			["扫描.pdf", scannedDocument()],
			["录音.wav", wavDocument()],
		] as const)
			await writeFile(join(project.sourcePath!, name), bytes);
		await service.index(project);
		const documents = await service.listDocuments(project);
		expect(documents).toHaveLength(4);
		expect(documents.every((value) => value.status === "ready" && value.source?.kind === "snapshot")).toBe(true);
		const text = documents.find((value) => value.name === "说明.txt")!;
		await writeFile(join(project.sourcePath!, "说明.txt"), "项目的新版本说明。");
		await service.index(project);
		expect((await service.original(project, text.id)).bytes.toString()).toContain("原始版本");
		expect(
			(await service.listDocuments(project)).find((value) => value.name === "说明.txt" && !value.supersededBy)
				?.contentVersion,
		).toBe(2);
		const image = documents.find((value) => value.name === "截图.png")!;
		const ocrCount = setup.counts.ocr;
		const database = new DatabaseSync(setup.fixture.application.paths.database);
		database.prepare("DELETE FROM knowledge_representations WHERE document_id=?").run(image.id);
		database.close();
		await setup.fixture.restart();
		await setup.fixture.application.services.knowledge.retryDocument(project, image.id);
		expect((await setup.wait(project, image.id)).status).toBe("ready");
		expect(setup.counts.ocr).toBe(ocrCount);
		await unlink(join(project.sourcePath!, "录音.wav"));
		await setup.fixture.application.services.knowledge.index(project);
		expect(
			(
				await setup.fixture.application.services.knowledge.original(
					project,
					documents.find((value) => value.name === "录音.wav")!.id,
				)
			).bytes,
		).toEqual(wavDocument());
		expect(await readFile(join(project.sourcePath!, "说明.txt"), "utf8")).toContain("新版本");
	} finally {
		await setup.close();
	}
});

test("cancel, interrupted ASR, snapshot versions, missing capabilities and vector revisions are explicit", async () => {
	const setup = await createPerceptionFixture();
	try {
		const project = await setup.project("中断版本");
		setup.setHoldOcr(true);
		const image = await setup.fixture.application.services.knowledge.upload(project, "取消.png", imageDocument());
		await expect.poll(() => setup.counts.ocr).toBe(1);
		expect(await setup.fixture.application.services.knowledge.cancelDocument(project, image.id)).toMatchObject({
			status: "failed",
			processingState: "cancelled",
		});
		setup.setHoldOcr(false);
		await setup.fixture.application.services.knowledge.retryDocument(project, image.id);
		expect((await setup.wait(project, image.id)).status).toBe("ready");
		setup.setHoldAsr(true);
		const audio = await setup.fixture.application.services.knowledge.upload(project, "中断.wav", wavDocument());
		await expect.poll(() => setup.counts.asr).toBe(1);
		await setup.fixture.restart();
		expect(
			(await setup.fixture.application.services.knowledge.listDocuments(project)).find(
				(value) => value.id === audio.id,
			),
		).toMatchObject({ status: "failed", processingState: "interrupted" });
		setup.setHoldAsr(false);
		await setup.fixture.application.services.knowledge.retryDocument(project, audio.id);
		expect((await setup.wait(project, audio.id)).status).toBe("ready");
		expect(setup.counts.asr).toBe(2);
		const file = join(project.sourcePath!, "源资料.txt");
		await writeFile(file, "快照版本一");
		const first = await setup.fixture.application.services.knowledge.snapshot(project, "源资料.txt");
		await setup.wait(project, first.id);
		await writeFile(file, "快照版本二");
		const second = await setup.fixture.application.services.knowledge.snapshot(project, "源资料.txt");
		await setup.wait(project, second.id);
		expect(second.contentVersion).toBe(2);
		expect((await setup.fixture.application.services.knowledge.original(project, first.id)).bytes.toString()).toBe(
			"快照版本一",
		);
		expect(
			(await setup.fixture.application.services.knowledge.listDocuments(project)).find(
				(value) => value.id === first.id,
			)?.supersededBy,
		).toBe(second.id);
		const endpoint = await new PerceptionConfiguration(setup.fixture.embeddingEnvFile).endpoint("multimodal");
		expect(
			await setup.fixture.application.repositories.knowledge.searchPerceptualVectors(
				project.id,
				endpoint.spaceId,
				[1, ...Array<number>(767).fill(0)],
				5,
			),
		).toHaveLength(1);
		await expect(
			setup.fixture.application.repositories.knowledge.searchPerceptualVectors(
				project.id,
				endpoint.spaceId,
				[1, 0],
				5,
			),
		).rejects.toThrow("维度");
		await writeFile(setup.fixture.embeddingEnvFile, `${setup.environment}MEMORY_EMBED_SPACE_REVISION=2\n`);
		const changed = await new PerceptionConfiguration(setup.fixture.embeddingEnvFile).endpoint("multimodal");
		expect(changed.spaceId).not.toBe(endpoint.spaceId);
		expect(
			await setup.fixture.application.repositories.knowledge.searchPerceptualVectors(
				project.id,
				changed.spaceId,
				[1, ...Array<number>(767).fill(0)],
				5,
			),
		).toEqual([]);
		await writeFile(
			setup.fixture.embeddingEnvFile,
			"EMBED_API_KEY=fixture-only\nEMBED_BASE_URL=http://127.0.0.1:1/v1\nMEMORY_OCR_ENABLED=false\nMEMORY_VISION_ENABLED=false\nMEMORY_MULTIMODAL_ENABLED=false\n",
		);
		const missing = await setup.fixture.application.services.knowledge.upload(
			project,
			"缺少服务.bmp",
			Buffer.from("BM invalid"),
		);
		expect((await setup.wait(project, missing.id)).status).toBe("failed");
		await setup.fixture.application.services.knowledge.retryDocument(project, image.id);
		expect(await setup.wait(project, image.id)).toMatchObject({
			status: "failed",
			processingState: "missing_capability",
		});
		expect(
			(await setup.fixture.application.services.knowledge.original(project, image.id)).bytes.length,
		).toBeGreaterThan(0);
	} finally {
		await setup.close();
	}
});
