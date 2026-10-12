import { writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createPerceptionFixture, imageDocument } from "./perception-fixture.ts";

test("real Gateway retains quota diagnostics, original images and unreviewed model provenance; explicit review survives restart and expires on retry", async () => {
	const setup = await createPerceptionFixture();
	try {
		const project = await setup.project("额度及图像核对");
		const other = await setup.project("隔离核对");
		setup.setProviderErrors("AllocationQuota.FreeTierOnly");
		const upload = await setup.fixture.application.services.knowledge.upload(project, "额度.png", imageDocument());
		const document = await setup.wait(project, upload.id);
		expect(document).toMatchObject({ status: "ready", processingState: "partial" });
		expect(document.diagnostics?.join("\n")).toContain("AllocationQuota.FreeTierOnly");
		expect(document.diagnostics?.join("\n")).not.toContain("fixture-perception-secret");
		expect(setup.counts.ocr).toBe(1);
		const preview = await setup.fixture.application.services.knowledge.preview(project, document.id);
		expect(preview.descriptionReview?.reviewedAt).toBeUndefined();
		const before = await setup.fixture.application.services.knowledge.retrieve(project, "Python");
		expect(before.context).toContain("未经用户核对的模型图像描述");
		expect(
			before.hits
				.find((hit) => hit.chunk === -1)
				?.sources?.some((source) => source.representation === "model_description" && source.origin === "model"),
		).toBe(true);
		const path = `/projects/${project.id}/knowledge/documents/${document.id}/confirm-description`;
		expect((await setup.fixture.request(`${path}?fingerprint=wrong`, { method: "POST" })).status).toBe(409);
		expect(
			(
				await setup.fixture.request(
					`/projects/${other.id}/knowledge/documents/${document.id}/confirm-description?fingerprint=${preview.descriptionReview?.fingerprint}`,
					{ method: "POST" },
				)
			).status,
		).toBe(404);
		expect(
			(
				await setup.fixture.request(`${path}?fingerprint=${preview.descriptionReview?.fingerprint}`, {
					method: "POST",
				})
			).status,
		).toBe(200);
		const after = await setup.fixture.application.services.knowledge.retrieve(project, "Python");
		expect(after.context).toContain("模型图像描述已由用户核对");
		expect(after.context).not.toContain("未经用户核对的模型图像描述");
		const reviewed = after.hits
			.flatMap((hit) => hit.sources ?? [])
			.filter((source) => source.representation === "model_description");
		expect(reviewed.every((source) => source.origin === "model" && source.reviewedAt)).toBe(true);
		await setup.fixture.restart();
		expect(
			(await setup.fixture.application.services.knowledge.preview(project, document.id)).descriptionReview
				?.reviewedAt,
		).toBeTruthy();
		await setup.fixture.application.services.knowledge.retryDocument(project, document.id);
		await setup.wait(project, document.id);
		expect(
			(await setup.fixture.application.services.knowledge.preview(project, document.id)).descriptionReview
				?.reviewedAt,
		).toBeTruthy();
		setup.setProviderErrors();
		await setup.fixture.application.services.knowledge.retryDocument(project, document.id);
		expect((await setup.wait(project, document.id)).status).toBe("ready");
		const renewed = await setup.fixture.application.services.knowledge.preview(project, document.id);
		expect(renewed.descriptionReview?.reviewedAt).toBeUndefined();
		expect(renewed.document.diagnostics?.join("\n")).toContain("尚未经用户确认");
		expect(renewed.descriptionReview?.fingerprint).not.toBe(preview.descriptionReview?.fingerprint);
		expect((await setup.fixture.application.services.knowledge.original(project, document.id)).bytes).toEqual(
			imageDocument(),
		);
	} finally {
		await setup.close();
	}
}, 45000);

test("keyword-only perceptual indexes honor parser and overlap fingerprints on explicit rebuild", async () => {
	const setup = await createPerceptionFixture();
	try {
		await writeFile(setup.fixture.embeddingEnvFile, setup.environment.replace("EMBED_TOKENIZER=cl100k_base\n", ""));
		const project = await setup.project("仅关键词分块指纹");
		const service = setup.fixture.application.services.knowledge;
		const document = await service.upload(project, "关键词.png", imageDocument());
		expect((await setup.wait(project, document.id)).status).toBe("ready");
		const files = await setup.fixture.application.repositories.knowledge.listFiles(project.id);
		expect(files[0].modelFingerprint).toBe("keyword-only");
		const before = await service.retrieve(project, "Python");
		expect(before.hits.some((hit) => hit.matches?.some((match) => match.method === "keyword"))).toBe(true);
		await service.configure(project, { overlapTokens: 32 });
		const stale = await service.retrieve(project, "Python");
		expect(stale.hits.some((hit) => hit.matches?.some((match) => match.method === "keyword"))).toBe(false);
		await service.index(project);
		const rebuilt = await setup.fixture.application.repositories.knowledge.listFiles(project.id);
		expect(rebuilt[0].indexFingerprint).not.toBe(files[0].indexFingerprint);
		expect(rebuilt[0].chunkerFingerprint).not.toBe(files[0].chunkerFingerprint);
		const after = await service.retrieve(project, "Python");
		expect(after.hits.some((hit) => hit.matches?.some((match) => match.method === "keyword"))).toBe(true);
	} finally {
		await setup.close();
	}
}, 45000);
