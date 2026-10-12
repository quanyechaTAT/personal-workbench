import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentProfileService,
	ProjectService,
	SessionService,
	type SystemServices,
	WorkbenchPaths,
	WorkspaceManager,
} from "@earendil-works/workbench-core";
import type {
	AgentEvent,
	AgentRuntime,
	CreateRuntimeSessionOptions,
	ResumeRuntimeSessionOptions,
	RuntimeInput,
	RuntimeModelRef,
	RuntimeSession,
	RuntimeSessionFilter,
	RuntimeTranscriptMessage,
	SendMessageOptions,
} from "@earendil-works/workbench-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchDatabase } from "../src/database.ts";
import { createWorkbenchRepositories } from "../src/repositories.ts";

class FakeRuntime implements AgentRuntime {
	readonly id = "pi";
	private readonly sessions = new Map<string, RuntimeSession>();
	private sequence = 0;

	async createSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession> {
		const id = `runtime-${++this.sequence}`;
		const session: RuntimeSession = {
			id,
			runtime: this.id,
			status: "idle",
			cwd: options.cwd,
			kind: options.kind,
			model: options.model,
			reference: { runtime: this.id, runtimeSessionId: id, opaque: `sessions/${id}.jsonl` },
		};
		this.sessions.set(id, session);
		return session;
	}

	async resumeSession(options: ResumeRuntimeSessionOptions): Promise<RuntimeSession> {
		const existing = this.sessions.get(options.reference.runtimeSessionId);
		if (existing) return existing;
		const session: RuntimeSession = {
			id: options.reference.runtimeSessionId,
			runtime: this.id,
			status: "idle",
			cwd: options.expectedCwd ?? "",
			kind: options.kind,
			reference: options.reference,
		};
		this.sessions.set(session.id, session);
		return session;
	}

	async *sendMessage(sessionId: string, input: RuntimeInput, options: SendMessageOptions): AsyncIterable<AgentEvent> {
		yield {
			id: "event-start",
			type: "run.started",
			occurredAt: "2026-09-15T08:00:00.000Z",
			sessionId,
			runId: options.runId,
			data: { inputId: input.id },
		};
		yield {
			id: "event-complete",
			type: "run.completed",
			occurredAt: "2026-09-15T08:00:01.000Z",
			sessionId,
			runId: options.runId,
			data: { finalMessageId: "assistant-1" },
		};
	}

	async abort(_sessionId: string): Promise<void> {}

	async getSession(sessionId: string): Promise<RuntimeSession> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("missing runtime session");
		return session;
	}

	async listSessions(filter?: RuntimeSessionFilter): Promise<RuntimeSession[]> {
		return [...this.sessions.values()].filter((session) => !filter?.cwd || session.cwd === filter.cwd);
	}

	async readTranscript(_sessionId: string): Promise<RuntimeTranscriptMessage[]> {
		return [];
	}
	async readTranscriptReference(_options: ResumeRuntimeSessionOptions): Promise<RuntimeTranscriptMessage[]> {
		return [];
	}
	async deleteSessionReference(options: ResumeRuntimeSessionOptions): Promise<void> {
		this.sessions.delete(options.reference.runtimeSessionId);
	}

	getCapabilities() {
		return {
			abort: true,
			steering: false,
			modelSelection: true,
			persistentSessions: true,
			reasoningStream: true,
			resume: true,
			toolStream: true,
		};
	}

	async listModels() {
		return [];
	}

	async selectModel(sessionId: string, model: RuntimeModelRef): Promise<void> {
		const session = await this.getSession(sessionId);
		this.sessions.set(sessionId, { ...session, model });
	}

	async releaseSession(sessionId: string): Promise<void> {
		this.sessions.delete(sessionId);
	}

	async dispose(): Promise<void> {
		this.sessions.clear();
	}
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("SessionService", () => {
	it("maps runtime references without copying conversation history and recovers interrupted runs", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-session-service-"));
		cleanup.push(async () => rm(root, { recursive: true, force: true }));
		const paths = new WorkbenchPaths(root);
		const workspace = new WorkspaceManager(paths);
		await workspace.initialize();
		const database = new WorkbenchDatabase(paths.database);
		const repositories = createWorkbenchRepositories(database);
		let sequence = 0;
		const system: SystemServices = {
			id: () => `domain-${++sequence}`,
			now: () => new Date("2026-09-15T08:00:00.000Z"),
		};
		const project = await new ProjectService(repositories.projects, workspace, system).create({
			name: "CV Learning",
		});
		const profileService = new AgentProfileService(
			repositories.profiles,
			repositories.skills,
			repositories.mcpConnections,
			system,
		);
		await profileService.ensureBuiltins();
		const profile = await profileService.getBySlug("standard");
		const runtime = new FakeRuntime();
		const service = new SessionService({
			sessions: repositories.sessions,
			runs: repositories.agentRuns,
			profiles: repositories.profiles,
			runtimes: new Map([[runtime.id, runtime]]),
			system,
		});
		const session = await service.create({ project, profile, title: "CV session" });
		expect(session.runtimeRef).toBe("sessions/runtime-1.jsonl");
		expect(Object.keys(session)).not.toContain("messages");

		const events: AgentEvent[] = [];
		for await (const event of service.send(session.id, {
			text: "Continue",
			inputMessageId: "input-1",
			runId: "run-1",
		})) {
			events.push(event);
		}
		expect(events.at(-1)?.type).toBe("run.completed");
		expect((await repositories.sessions.get(session.id))?.status).toBe("idle");
		expect(await repositories.agentRuns.get("run-1")).toMatchObject({
			status: "completed",
			finalMessageId: "assistant-1",
		});

		const runningSession = { ...(await service.get(session.id)), status: "running" as const };
		await repositories.sessions.update(runningSession);
		await repositories.agentRuns.create({
			id: "orphan-run",
			sessionId: session.id,
			status: "running",
			inputMessageId: "orphan-input",
			profileSlug: "standard",
			startedAt: "2026-09-15T07:59:00.000Z",
		});
		await service.initializeRecovery();
		expect((await repositories.sessions.get(session.id))?.status).toBe("interrupted");
		expect((await repositories.agentRuns.get("orphan-run"))?.status).toBe("interrupted");
		database.close();
	});
});
