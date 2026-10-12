import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendWorkbenchMessageInput, SessionService } from "@earendil-works/workbench-core";
import type { AgentEvent } from "@earendil-works/workbench-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { AgentEventBroker, type SequencedAgentEvent } from "../src/event-broker.ts";
import { StructuredLogger } from "../src/logger.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("AgentEventBroker replay", () => {
	test("different sessions run concurrently while duplicate submissions leave the existing stream unchanged", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-busy-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const logger = new StructuredLogger(join(root, "workbench.jsonl"));
		await logger.initialize();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sessions: Pick<SessionService, "abort" | "send"> = {
			abort: async () => undefined,
			send: async function* (sessionId, input) {
				await gate;
				yield {
					id: input.runId!,
					type: "run.completed",
					occurredAt: new Date().toISOString(),
					sessionId,
					runId: input.runId!,
					data: {},
				};
			},
		};
		const broker = new AgentEventBroker(sessions, logger);
		const first = broker.start("first", { text: "hold" });
		const second = broker.start("new-session", { text: "concurrent" });
		expect(() => broker.start("first", { text: "duplicate" })).toThrow("该会话正在运行");
		expect(broker.getActiveRunId("first")).toBe(first.runId);
		expect(broker.getActiveRunId("new-session")).toBe(second.runId);
		release();
		for (const runId of [first.runId, second.runId]) {
			for await (const _entry of broker.subscribe(runId)) {
				/* drain */
			}
		}
		const next = broker.start("new-session", { text: "ready" });
		for await (const _entry of broker.subscribe(next.runId)) {
			/* drain */
		}
		await logger.flush();
	});
	test("publishes completion only after session settlement and releases active run discovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-settlement-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const logger = new StructuredLogger(join(root, "workbench.jsonl"));
		await logger.initialize();
		let settled = false;
		const sessions: Pick<SessionService, "abort" | "send"> = {
			abort: async () => undefined,
			send: async function* (sessionId, input) {
				yield {
					id: "completed",
					type: "run.completed",
					occurredAt: "2026-09-26T00:00:00Z",
					sessionId,
					runId: input.runId!,
					data: {},
				};
				await new Promise<void>((resolve) => setImmediate(resolve));
				settled = true;
			},
		};
		const broker = new AgentEventBroker(sessions, logger);
		const { runId } = broker.start("settling-session", { text: "Finish" });
		expect(broker.getActiveRunId("settling-session")).toBe(runId);
		for await (const entry of broker.subscribe(runId)) {
			if (entry.event.type === "run.completed") {
				expect(settled).toBe(true);
				expect(broker.getActiveRunId("settling-session")).toBeUndefined();
			}
		}
		await logger.flush();
	});

	test("emits stream.reset when the requested cursor is older than the retained buffer", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-event-broker-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const logger = new StructuredLogger(join(root, "workbench.jsonl"));
		await logger.initialize();
		const sessions: Pick<SessionService, "abort" | "send"> = {
			abort: async () => undefined,
			send: async function* (sessionId: string, input: SendWorkbenchMessageInput): AsyncIterable<AgentEvent> {
				for (let index = 0; index < 30; index += 1) {
					yield {
						id: `event-${index}`,
						type: "agent.status",
						occurredAt: "2026-09-16T00:00:00.000Z",
						sessionId,
						runId: input.runId ?? "missing-run",
						data: { status: "running", detail: String(index) },
					};
				}
				yield {
					id: "event-complete",
					type: "run.completed",
					occurredAt: "2026-09-16T00:00:01.000Z",
					sessionId,
					runId: input.runId ?? "missing-run",
					data: {},
				};
			},
		};
		const broker = new AgentEventBroker(sessions, logger, 20);
		const { runId } = broker.start("session-1", { text: "Generate events" });
		while (!broker.get(runId).completed) await new Promise<void>((resolve) => setImmediate(resolve));

		const replay: SequencedAgentEvent[] = [];
		for await (const entry of broker.subscribe(runId, 0)) replay.push(entry);
		expect(replay[0]?.event).toEqual({ type: "stream.reset", data: { reason: "buffer_exhausted" } });
		expect(replay.at(-1)?.event.type).toBe("run.completed");
		await logger.flush();
	});
});
