import { setImmediate } from "node:timers/promises";
import { PathPolicy } from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { KnowledgeService } from "../src/knowledge-service.ts";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("a failed document can retry while its diagnostic is still being saved", async () => {
	const fixture = await createAssistantFixture();
	let release: (() => void) | undefined;
	let reported = false;
	const service = new KnowledgeService(
		fixture.application.repositories.knowledge,
		new PathPolicy(fixture.application.paths),
		{
			paths: fixture.application.paths,
			embeddingEnvFile: fixture.embeddingEnvFile,
			onError: async () => {
				if (reported) return;
				reported = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			},
		},
	);
	try {
		const project = await fixture.application.services.projects.create({ name: "retry" });
		const document = await service.upload(project, "broken.docx", Buffer.from("not a Word document"));
		await expect.poll(() => Boolean(release), { timeout: 10000 }).toBe(true);
		expect((await service.listDocuments(project))[0].status).toBe("failed");
		let settled = false;
		const outcome = service
			.retryDocument(project, document.id)
			.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			)
			.finally(() => {
				settled = true;
			});
		await setImmediate();
		expect(settled).toBe(false);
		release!();
		expect(await outcome).toMatchObject({ value: { id: document.id, status: "queued" } });
	} finally {
		release?.();
		await service.dispose();
		await fixture.close();
	}
});
