import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { LearningOutput } from "@earendil-works/workbench-core/contracts";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { expect, test } from "vitest";
import { createWorkbenchApplication } from "../src/application.ts";
import { HaluMemServer } from "../src/halumem-server.ts";
import { HaluMemService } from "../src/halumem-service.ts";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { similarityResponse } from "./project-learning-fixture.ts";

function inputText(context: Context): string {
	const message = context.messages.at(-1);
	if (message?.role !== "user") throw new Error("Missing model input");
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
}

test("replays native roles, freezes extraction snapshots, updates memories and isolates corpus users", async () => {
	const fixture = await createAssistantFixture();
	const options = {
		root: join(fixture.root, "halumem"),
		model: { provider: fixture.model.provider, modelId: fixture.model.id },
		qaPrompt: "Reference: {context}\nQuestion: {question}",
		createApplication: (dataRoot: string) =>
			createWorkbenchApplication({
				dataRoot,
				agentDir: join(fixture.root, "pi-agent"),
				embeddingEnvFile: fixture.embeddingEnvFile,
				pi: { modelRuntime: fixture.modelRuntime, defaultModel: fixture.model },
			}),
	};
	const service = new HaluMemService(options);
	const scope = { run_id: "smoke", user_id: "alice" };
	const dialogue = {
		...scope,
		session_id: "first",
		timestamp: "2025-01-01T12:00:00Z",
		dialogue: [
			{ role: "user" as const, content: "I live in Paris." },
			{ role: "assistant" as const, content: "You live in Rome. This is an unverified assistant claim." },
			{ role: "user" as const, content: "Please remember my city for future travel planning." },
			{ role: "assistant" as const, content: "I have noted your request." },
		],
	};
	function extraction(text: string, change?: LearningOutput["memories"][number]["change"]) {
		return (context: Context) => {
			expect(context.tools ?? []).toHaveLength(0);
			const input = Parse(
				Type.Object({
					sources: Type.Array(
						Type.Object({
							id: Type.String(),
							role: Type.String(),
							text: Type.String(),
							verified: Type.Boolean(),
						}),
					),
				}),
				JSON.parse(inputText(context)),
			);
			const source = input.sources.find((item) => item.role === "user" && item.text.includes(text));
			expect(source?.verified).toBe(true);
			for (const assistant of input.sources.filter((item) => item.role === "assistant"))
				expect(assistant.verified).toBe(false);
			if (text === "I live in Paris.") expect(input.sources.filter((item) => item.role === "user")).toHaveLength(2);
			return fauxAssistantMessage(
				JSON.stringify({
					summary: "User city for future planning",
					memories: [
						{
							text,
							category: "fact",
							futureUse: "Answer future questions about the user's home city.",
							evidence: [{ sourceId: source!.id, quote: text }],
							...(change ? { change } : {}),
						},
					],
					skills: [],
				}),
			);
		};
	}
	try {
		fixture.faux.setResponses([extraction("I live in Paris.")]);
		const first = await service.addDialogue(dialogue);
		expect(first.memories.map((item) => item.memory)).toEqual(["I live in Paris."]);
		expect(first.diagnostics).toEqual([]);
		expect(await service.addDialogue(dialogue)).toEqual(first);
		await expect(service.addDialogue({ ...dialogue, timestamp: "2025-01-02T12:00:00Z" })).rejects.toThrow(
			"different dialogue",
		);
		fixture.faux.setResponses([
			extraction("I now live in Berlin.", {
				operation: "supersede",
				targetId: first.memories[0].id,
				expectedVersion: first.memories[0].version,
			}),
			(context) => similarityResponse(context, "related"),
		]);
		const second = await service.addDialogue({
			...scope,
			session_id: "second",
			timestamp: "2025-02-01T12:00:00Z",
			dialogue: [
				{ role: "user", content: "I now live in Berlin." },
				{ role: "assistant", content: "Noted." },
			],
		});
		expect(second.diagnostics).toEqual([]);
		expect(second.memories.map((item) => item.memory)).toEqual(["I now live in Berlin."]);
		expect((await service.getDialogueMemory({ ...scope, session_id: "first" })).memories).toEqual(first.memories);
		fixture.faux.setResponses([
			(context) => {
				expect(context.tools ?? []).toHaveLength(0);
				const prompt = inputText(context);
				expect(prompt).toContain("2025-02-01T12:00:00Z: I now live in Berlin.");
				expect(prompt).not.toContain("Paris");
				expect(prompt).not.toContain("Rome");
				return fauxAssistantMessage("Berlin");
			},
		]);
		const found = await service.retrieveMemory({
			...scope,
			query: "Where do I live?",
			top_k: 20,
			generate_answer: true,
		});
		expect(found.system_response).toBe("Berlin");
		expect(found.memories.map((item) => item.memory)).toEqual(["I now live in Berlin."]);
		fixture.faux.setResponses([extraction("I live in Tokyo.")]);
		await service.addDialogue({
			...dialogue,
			user_id: "bob",
			dialogue: [
				{ role: "user", content: "I live in Tokyo." },
				{ role: "assistant", content: "Noted." },
			],
		});
		const bob = await service.retrieveMemory({ run_id: "smoke", user_id: "bob", query: "home city", top_k: 20 });
		expect(bob.context).toContain("Tokyo");
		expect(bob.context).not.toContain("Berlin");
		expect((await service.retrieveMemory({ ...scope, query: "home city", top_k: 10 })).context).not.toContain(
			"Tokyo",
		);
		const retryInput = {
			...dialogue,
			user_id: "charlie",
			dialogue: [
				{ role: "user" as const, content: "I live in Oslo." },
				{ role: "assistant" as const, content: "Noted." },
			],
		};
		fixture.faux.setResponses([fauxAssistantMessage("invalid extraction JSON")]);
		await expect(service.addDialogue(retryInput)).rejects.toThrow("Memory extraction did not complete");
		fixture.faux.setResponses([extraction("I live in Oslo.")]);
		expect((await service.addDialogue(retryInput)).memories.map((item) => item.memory)).toEqual(["I live in Oslo."]);
		expect(fixture.faux.getPendingResponseCount()).toBe(0);
		await expect(service.getDialogueMemory({ ...scope, session_id: "../escape" })).rejects.toThrow("Invalid session");
		await service.close();
		const reopened = new HaluMemService(options);
		try {
			expect((await reopened.getDialogueMemory({ ...scope, session_id: "first" })).memories[0].memory).toBe(
				"I live in Paris.",
			);
		} finally {
			await reopened.close();
		}
	} finally {
		await service.close();
		await fixture.close();
	}
});

test("guards the optional HTTP API and rejects gold fields before constructing a workspace", async () => {
	let opened = false;
	const service = new HaluMemService({
		root: join(process.cwd(), ".unused-halumem"),
		qaPrompt: "{context} {question}",
		createApplication: async () => {
			opened = true;
			throw new Error("Unexpected workspace");
		},
	});
	const token = "local-halumem-test-token";
	const server = new HaluMemServer(service, token);
	const origin = await server.start(0);
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	try {
		expect((await fetch(`${origin}/health`)).status).toBe(403);
		expect(
			(await fetch(`${origin}/health`, { headers: { ...headers, origin: "https://foreign.example" } })).status,
		).toBe(403);
		expect(await (await fetch(`${origin}/health`, { headers })).json()).toMatchObject({
			model: { modelId: "gpt-6-luna" },
		});
		const input = {
			run_id: "test",
			user_id: "alice",
			session_id: "one",
			timestamp: "2025-01-01T00:00:00Z",
			dialogue: [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hello" },
			],
		};
		for (const payload of [
			{ ...input, memory_points: [{ memory_content: "secret gold" }] },
			{ ...input, user_id: "../escape" },
			{ ...input, timestamp: "not-a-date" },
			{ ...input, dialogue: [{ role: "system", content: "gold answer" }] },
		]) {
			expect(
				(await fetch(`${origin}/add-dialogue`, { method: "POST", headers, body: JSON.stringify(payload) })).status,
			).toBe(400);
		}
		expect(
			(await fetch(`${origin}/get-dialogue-memory?run_id=test&user_id=alice&session_id=missing`, { headers }))
				.status,
		).toBe(404);
		expect(
			(
				await fetch(`${origin}/retrieve-memory`, {
					method: "POST",
					headers,
					body: JSON.stringify({ run_id: "test", user_id: "alice", query: "city", top_k: 20 }),
				})
			).status,
		).toBe(404);
		expect(opened).toBe(false);
	} finally {
		await server.close();
	}
});
