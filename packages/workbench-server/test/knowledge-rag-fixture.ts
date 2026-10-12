import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Project } from "@earendil-works/workbench-core";
import { createAssistantFixture } from "./assistant-fixture.ts";

/** A real Gateway, SQLite/vec0, parser workers and filesystem. Only model outputs are deterministic. */
export async function createKnowledgeFixture(
	vector: (text: string) => number[] = (text) =>
		/分块|chunk|Token/iu.test(text) ? [1, 0, 0] : /星辰|Qwen/iu.test(text) ? [0, 1, 0] : [0, 0, 1],
	options: { tokenUsage?: (text: string) => number; model?: string; rejectInput?: (input: string[]) => boolean } = {},
) {
	const fixture = await createAssistantFixture();
	const requests: string[][] = [];
	let mode: "ok" | "fail" | "hold" = "ok";
	let disconnected = 0;
	const embedding = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const { input } = JSON.parse(body) as { input: string[] };
		requests.push(input);
		response.once("close", () => {
			if (!response.writableEnded) disconnected++;
		});
		if (mode === "hold") return;
		if (mode === "fail") {
			response.writeHead(401);
			response.end("fixture-secret-error");
			return;
		}
		if (options.rejectInput?.(input)) {
			response.writeHead(400);
			response.end("fixture input refused");
			return;
		}
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				data: input.map((text, index) => ({ index, embedding: vector(text) })),
				...(options.tokenUsage
					? { usage: { total_tokens: input.reduce((sum, text) => sum + options.tokenUsage!(text), 0) } }
					: {}),
			}),
		);
	});
	await new Promise<void>((resolve) => embedding.listen(0, "127.0.0.1", resolve));
	const address = embedding.address();
	if (!address || typeof address === "string") throw new Error("No embedding fixture port");
	await writeFile(
		fixture.embeddingEnvFile,
		`EMBED_API_KEY=fixture-secret\nEMBED_BASE_URL=http://127.0.0.1:${address.port}/v1\nEMBED_MODEL_NAME=${options.model ?? "rag-fixture"}\nEMBED_TOKENIZER=${options.tokenUsage ? "provider-usage" : "cl100k_base"}\nEMBED_TOKENIZER_MODEL=${options.model ?? "rag-fixture"}\n`,
	);
	return {
		fixture,
		requests,
		setMode(value: typeof mode) {
			mode = value;
		},
		get disconnected() {
			return disconnected;
		},
		async project(name: string): Promise<Project> {
			const sourcePath = join(fixture.root, name);
			await mkdir(sourcePath);
			return fixture.application.createProject({ sourcePath });
		},
		async close() {
			try {
				await fixture.close();
			} finally {
				embedding.closeAllConnections();
				await new Promise<void>((resolve, reject) =>
					embedding.close((error) => (error ? reject(error) : resolve())),
				);
			}
		},
	};
}
