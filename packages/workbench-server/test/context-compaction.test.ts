import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { startModelServer } from "./fixtures/model-server.ts";

async function seedHistory(fixture: Awaited<ReturnType<typeof createAssistantFixture>>, tokens: number) {
	await writeFile(
		join(fixture.root, "pi-agent", "settings.json"),
		JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
	);
	const session = await fixture.application.createSession({ profileSlug: "standard" });
	await fixture.restart();
	const manager = SessionManager.open(session.runtimeRef);
	manager.appendMessage({ role: "user", content: "earlier-goal ".repeat(200), timestamp: Date.now() - 2000 });
	manager.appendMessage({
		...fauxAssistantMessage("remember-progress", { timestamp: Date.now() - 1000 }),
		provider: fixture.model.provider,
		model: fixture.model.id,
		api: fixture.model.api,
		usage: {
			input: tokens - 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	return session;
}

for (const [tokens, shouldCompact] of [
	[102399, false],
	[102400, true],
] as const) {
	test(`automatic compaction ${shouldCompact ? "triggers" : "does not trigger"} at ${tokens}/128000 tokens`, async () => {
		const fixture = await createAssistantFixture(undefined, { modelContextWindow: 128000 });
		try {
			const session = await seedHistory(fixture, tokens);
			fixture.faux.setResponses([
				fauxAssistantMessage("summary-or-answer"),
				fauxAssistantMessage("continue-answer"),
				fauxAssistantMessage("next-answer"),
			]);
			const context = await fixture.application.contextForSession(session.id);
			const run = fixture.application.events.start(session.id, { text: "continue-goal", context: context.runtime });
			let sawEstimate = false;
			for await (const entry of fixture.application.events.subscribe(run.runId)) {
				if (entry.event.type === "usage.updated" && entry.event.data.contextTokensSource === "estimated") {
					expect(entry.event.data.contextTokens).toBeGreaterThan(0);
					sawEstimate = true;
				}
			}
			expect(sawEstimate).toBe(shouldCompact);
			const entries = SessionManager.open(session.runtimeRef).getEntries();
			expect(entries.some((entry) => entry.type === "compaction")).toBe(shouldCompact);
			expect(await readFile(session.runtimeRef, "utf8")).toContain("earlier-goal");
			expect(JSON.stringify(await fixture.application.services.sessions.readTranscript(session.id))).toContain(
				"earlier-goal",
			);
			expect((await fixture.application.repositories.agentRuns.get(run.runId))?.status).toBe("completed");
		} finally {
			await fixture.close();
		}
	}, 30_000);
}

test("changing the compaction threshold is applied to existing sessions and invalid settings are rejected", async () => {
	const fixture = await createAssistantFixture(undefined, { modelContextWindow: 128000 });
	try {
		const session = await seedHistory(fixture, 95000);
		await fixture.application.services.settings.set("context.autoCompactThresholdPercent", 70);
		await expect(
			fixture.application.services.settings.set("context.autoCompactThresholdPercent", 101),
		).rejects.toThrow();
		fixture.faux.setResponses([
			fauxAssistantMessage("preserved-goal-summary"),
			fauxAssistantMessage("continued"),
			fauxAssistantMessage("answer"),
		]);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, { text: "continue", context: context.runtime });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			/* drain */
		}
		expect(
			SessionManager.open(session.runtimeRef)
				.getEntries()
				.some((entry) => entry.type === "compaction"),
		).toBe(true);
	} finally {
		await fixture.close();
	}
}, 30_000);

test("repeated compaction within a long turn merges the previous checkpoint and the user's focus", async () => {
	const fixture = await createAssistantFixture(undefined, { modelContextWindow: 128000 });
	try {
		const session = await seedHistory(fixture, 10000);
		const manager = SessionManager.open(session.runtimeRef);
		const firstKept = manager.appendMessage({
			role: "user",
			content: "current-request ".repeat(1000),
			timestamp: Date.now(),
		});
		manager.appendCompaction(
			"Original goal: preserve marker ORIGINAL-GOAL and the user's no-commit constraint.",
			firstKept,
			10000,
			{ modifiedFiles: ["src/preserved.ts"], readFiles: ["docs/constraints.md"] },
			true,
		);
		manager.appendMessage({
			...fauxAssistantMessage("recent-work ".repeat(1000)),
			provider: fixture.model.provider,
			model: fixture.model.id,
			api: fixture.model.api,
		});
		let summaryInput = "";
		fixture.faux.setResponses([
			(context) => {
				summaryInput = JSON.stringify(context);
				return fauxAssistantMessage("Original goal and recent progress retained. Continue the unfinished work.");
			},
		]);
		const context = await fixture.application.contextForSession(session.id);
		const result = await fixture.application.services.sessions.executeCommand(
			session.id,
			{ name: "compact", instructions: "PRESERVE-TERMINAL-IDS" },
			context.runtime,
		);
		expect(summaryInput).toContain("ORIGINAL-GOAL");
		expect(summaryInput).toContain("current-request");
		expect(summaryInput).toContain("PRESERVE-TERMINAL-IDS");
		expect(result.type).toBe("compaction");
		if (result.type === "compaction") {
			expect(result.summary).toContain("src/preserved.ts");
			expect(result.summary).toContain("docs/constraints.md");
		}
		expect(fixture.faux.state.callCount).toBe(1);
	} finally {
		await fixture.close();
	}
}, 30_000);

test("compaction sees the latest retained user correction instead of reviving an earlier tool request", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await seedHistory(fixture, 10000);
		await writeFile(
			join(fixture.root, "pi-agent", "settings.json"),
			JSON.stringify({ compaction: { keepRecentTokens: 256 } }),
		);
		await fixture.restart();
		const manager = SessionManager.open(session.runtimeRef);
		manager.appendMessage({
			role: "user",
			content: "Run an independent release verification. ".repeat(200),
			timestamp: Date.now(),
		});
		manager.appendMessage({
			...fauxAssistantMessage("Release verification completed. ".repeat(200)),
			provider: fixture.model.provider,
			model: fixture.model.id,
			api: fixture.model.api,
		});
		manager.appendMessage({
			...fauxAssistantMessage(fauxToolCall("accept_changes", { criteria: [] }, { id: "latest-acceptance" })),
			provider: fixture.model.provider,
			model: fixture.model.id,
			api: fixture.model.api,
		});
		manager.appendMessage({
			role: "toolResult",
			toolName: "accept_changes",
			toolCallId: "latest-acceptance",
			isError: false,
			content: [{ type: "text", text: '{"status":"accepted","reason":"LATEST-ACCEPTED-RESULT"}' }],
			timestamp: Date.now(),
		});
		const latest = "LATEST-USER-CORRECTION: verification is done; wait for the release date. Do not repeat tools.";
		manager.appendMessage({ role: "user", content: latest, timestamp: Date.now() });
		manager.appendMessage({
			...fauxAssistantMessage("Waiting for the release date."),
			provider: fixture.model.provider,
			model: fixture.model.id,
			api: fixture.model.api,
		});
		fixture.faux.setResponses([
			(context) => {
				const focus = context.messages.at(-1);
				expect(focus?.role).toBe("user");
				expect(JSON.stringify(focus?.content)).toContain(latest);
				expect(JSON.stringify(focus?.content)).toContain("LATEST-ACCEPTED-RESULT");
				return fauxAssistantMessage(
					"Verification completed; wait for the user's release date. Do not replay tools.",
				);
			},
		]);
		const context = await fixture.application.contextForSession(session.id);
		await fixture.application.services.sessions.executeCommand(session.id, { name: "compact" }, context.runtime);
		expect(SessionManager.open(session.runtimeRef).buildSessionContext().messages.at(-2)).toMatchObject({
			role: "user",
			content: latest,
		});
	} finally {
		await fixture.close();
	}
}, 30_000);

for (const [label, response] of [
	["empty", fauxAssistantMessage("")],
	["larger than the replaced history", fauxAssistantMessage("inflated summary ".repeat(300))],
	["truncated", fauxAssistantMessage("partial checkpoint", { stopReason: "length" })],
	[
		"a tool invocation",
		fauxAssistantMessage(fauxToolCall("write", { path: "unexpected.txt", content: "should not run" }), {
			stopReason: "toolUse",
		}),
	],
] as const) {
	test(`compaction rejects a summary that is ${label} and leaves the conversation intact`, async () => {
		const fixture = await createAssistantFixture();
		try {
			const session = await seedHistory(fixture, 10000);
			const before = SessionManager.open(session.runtimeRef).buildSessionContext().messages;
			fixture.faux.setResponses([response]);
			const context = await fixture.application.contextForSession(session.id);
			await expect(
				fixture.application.services.sessions.executeCommand(session.id, { name: "compact" }, context.runtime),
			).rejects.toThrow();
			const manager = SessionManager.open(session.runtimeRef);
			expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(manager.buildSessionContext().messages).toEqual(before);
		} finally {
			await fixture.close();
		}
	}, 30_000);
}

test("compaction retains recent messages and tool pairing, includes log tails and excludes image bytes", async () => {
	const fixture = await createAssistantFixture(undefined, { modelInput: ["text"] });
	try {
		const session = await seedHistory(fixture, 10000);
		const manager = SessionManager.open(session.runtimeRef);
		manager.appendMessage({
			...fauxAssistantMessage(fauxToolCall("exec_command", { cmd: "start-server" }, { id: "server-call" }), {
				stopReason: "toolUse",
			}),
			provider: fixture.model.provider,
			model: fixture.model.id,
			api: fixture.model.api,
		});
		manager.appendMessage({
			role: "toolResult",
			toolName: "exec_command",
			toolCallId: "server-call",
			isError: true,
			content: [
				{
					type: "text",
					text: `server-start\n${"verbose build log\n".repeat(2000)}\nexit_code=42 session_id=terminal-123`,
				},
			],
			timestamp: Date.now(),
		});
		manager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "Investigate server error. ".repeat(300) },
				{ type: "image", data: "PRIVATE-HISTORICAL-IMAGE", mimeType: "image/png" },
			],
			timestamp: Date.now(),
		});
		const kept = {
			...fauxAssistantMessage("most-recent-work ".repeat(300)),
			provider: fixture.model.provider,
			model: fixture.model.id,
			api: fixture.model.api,
		};
		manager.appendMessage(kept);
		fixture.faux.setResponses([
			(context, options) => {
				const replay = JSON.stringify(context.messages);
				expect(replay.includes("PRIVATE-HISTORICAL-IMAGE")).toBe(false);
				expect(replay.includes("server-start")).toBe(true);
				expect(replay.includes("exit_code=42 session_id=terminal-123")).toBe(true);
				expect(context.messages.find((message) => message.role === "toolResult")).toMatchObject({
					toolCallId: "server-call",
					isError: true,
				});
				// Includes the bounded latest user request in addition to the summarized span and log tails.
				expect(replay.length).toBeLessThan(30000);
				expect(options?.maxTokens).toBeLessThanOrEqual(6400);
				expect(context.systemPrompt).toContain("助手");
				return fauxAssistantMessage("Inspect failed server in terminal-123, exit code 42; preserve current goal.");
			},
		]);
		const context = await fixture.application.contextForSession(session.id);
		await fixture.application.services.sessions.executeCommand(session.id, { name: "compact" }, context.runtime);
		const updated = SessionManager.open(session.runtimeRef);
		expect(updated.buildSessionContext().messages.at(-1)).toEqual(kept);
		expect(updated.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(fixture.faux.state.callCount).toBe(1);
	} finally {
		await fixture.close();
	}
}, 30_000);

test("an automatic compaction failure reports its cause and preserves the original context", async () => {
	const fixture = await createAssistantFixture(undefined, { modelContextWindow: 128000 });
	try {
		const session = await seedHistory(fixture, 102400);
		fixture.faux.setResponses([
			fauxAssistantMessage(""),
			fauxAssistantMessage("continue safely with original history"),
		]);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, { text: "continue", context: context.runtime });
		let failureVisible = false;
		for await (const entry of fixture.application.events.subscribe(run.runId))
			if (entry.event.type === "agent.status" && entry.event.data.detail?.includes("模型返回空摘要"))
				failureVisible = true;
		expect(failureVisible).toBe(true);
		expect(
			SessionManager.open(session.runtimeRef)
				.getEntries()
				.some((entry) => entry.type === "compaction"),
		).toBe(false);
		expect((await fixture.application.repositories.agentRuns.get(run.runId))?.status).toBe("completed");
	} finally {
		await fixture.close();
	}
}, 30_000);

test("cancelling an in-flight summary leaves the session history unchanged", async () => {
	const fixture = await createAssistantFixture();
	const controller = new AbortController();
	try {
		const session = await seedHistory(fixture, 10000);
		const before = SessionManager.open(session.runtimeRef).buildSessionContext().messages;
		let entered: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		fixture.faux.setResponses([
			async (_context, options) => {
				entered();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("unfinished checkpoint", { stopReason: "aborted" });
			},
		]);
		const context = await fixture.application.contextForSession(session.id);
		const command = fixture.application.services.sessions.executeCommand(
			session.id,
			{ name: "compact" },
			context.runtime,
			controller.signal,
		);
		const rejected = expect(command).rejects.toThrow("取消");
		await started;
		controller.abort();
		await rejected;
		const manager = SessionManager.open(session.runtimeRef);
		expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(manager.buildSessionContext().messages).toEqual(before);
	} finally {
		controller.abort();
		await fixture.close();
	}
}, 30_000);

test.each(["openai-completions", "anthropic-messages", "openai-responses"])(
	"%s compaction uses the current provider credentials and an independent output budget",
	async (api) => {
		const wire = await startModelServer();
		const fixture = await createAssistantFixture();
		try {
			await writeFile(
				join(fixture.root, "pi-agent", "settings.json"),
				JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
			);
			const current = await fixture.application.services.modelSettings.get();
			const saved = await fixture.application.services.modelSettings.save(undefined, {
				name: "摘要协议验证",
				baseUrl: `${wire.origin}/v1`,
				api,
				enabled: true,
				apiKey: "!literal-fixture-summary-key",
				expectedVersion: current.version,
				models: [
					{
						modelId: "deepseek-flash",
						name: "摘要测试",
						enabled: true,
						reasoning: true,
						vision: false,
						contextWindow: 32768,
						maxTokens: 1024,
						thinkingPreset: "deepseek",
					},
				],
			});
			const provider = saved.providers.find((entry) => entry.name === "摘要协议验证")!;
			const session = await fixture.application.createSession({
				profileSlug: "standard",
				model: { provider: provider.id, modelId: "deepseek-flash" },
			});
			await fixture.restart();
			const manager = SessionManager.open(session.runtimeRef);
			manager.appendMessage({ role: "user", content: "NATIVE-SUMMARY-GOAL ".repeat(300), timestamp: Date.now() });
			manager.appendMessage({
				...fauxAssistantMessage("Recent work continues. ".repeat(300)),
				provider: provider.id,
				model: "deepseek-flash",
				api,
			});
			const context = await fixture.application.contextForSession(session.id);
			await fixture.application.services.sessions.executeCommand(session.id, { name: "compact" }, context.runtime);
			expect(wire.requests).toHaveLength(1);
			const request = wire.requests[0]!;
			expect(request.authorization ?? request.apiKey).toContain("!literal-fixture-summary-key");
			expect(JSON.stringify(request.body).includes("NATIVE-SUMMARY-GOAL")).toBe(true);
			expect(
				request.body.max_tokens ?? request.body.max_output_tokens ?? request.body.max_completion_tokens,
			).toBeLessThanOrEqual(1024);
			expect(request.body.thinking).not.toEqual({ type: "adaptive" });
			expect(
				SessionManager.open(session.runtimeRef)
					.getEntries()
					.filter((entry) => entry.type === "compaction"),
			).toHaveLength(1);
		} finally {
			await fixture.close();
			await wire.close();
		}
	},
	30_000,
);
