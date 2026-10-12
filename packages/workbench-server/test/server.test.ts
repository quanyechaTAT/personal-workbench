import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type {
	AgentEvent,
	AgentRuntime,
	CreateRuntimeSessionOptions,
	ResumeRuntimeSessionOptions,
	RuntimeCapabilities,
	RuntimeModel,
	RuntimeModelRef,
	RuntimeSession,
	RuntimeSessionFilter,
	RuntimeTranscriptMessage,
	SendMessageOptions,
} from "@earendil-works/workbench-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkbenchApplication } from "../src/application.ts";
import { WorkbenchHttpServer } from "../src/http-server.ts";
import { createAssistantFixture } from "./assistant-fixture.ts";

interface FakeConversation {
	cwd: string;
	messages: RuntimeTranscriptMessage[];
}

class FakeRuntime implements AgentRuntime {
	readonly id = "pi";
	disposed = false;
	lastCreateOptions?: CreateRuntimeSessionOptions;
	lastSendOptions?: SendMessageOptions;
	private nextSendGate?: { entered: () => void; wait: Promise<void> };
	private readonly conversations: Map<string, FakeConversation>;
	private readonly sessions = new Map<string, RuntimeSession>();
	private nextId = 1;

	constructor(conversations = new Map<string, FakeConversation>()) {
		this.conversations = conversations;
	}

	async createSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession> {
		this.lastCreateOptions = options;
		const id = options.id ?? `runtime-${this.nextId++}`;
		const session: RuntimeSession = {
			id,
			runtime: this.id,
			status: "idle",
			cwd: options.cwd,
			kind: options.kind,
			model: options.model,
			reference: { runtime: this.id, runtimeSessionId: id, opaque: `fake:${id}` },
		};
		this.sessions.set(id, session);
		this.conversations.set(id, { cwd: options.cwd, messages: [] });
		return session;
	}

	async resumeSession(options: ResumeRuntimeSessionOptions): Promise<RuntimeSession> {
		const conversation = this.conversations.get(options.reference.runtimeSessionId);
		if (!conversation) throw new Error("Missing fake conversation");
		const session: RuntimeSession = {
			id: options.reference.runtimeSessionId,
			runtime: this.id,
			status: "idle",
			cwd: conversation.cwd,
			kind: options.kind,
			reference: options.reference,
		};
		this.sessions.set(session.id, session);
		return session;
	}

	async *sendMessage(
		sessionId: string,
		input: { id: string; text: string },
		options: SendMessageOptions,
	): AsyncIterable<AgentEvent> {
		this.lastSendOptions = options;
		const conversation = this.requireConversation(sessionId);
		conversation.messages.push({
			id: input.id,
			role: "user",
			content: [{ type: "text", text: input.text }],
			timestamp: new Date().toISOString(),
		});
		const base = { occurredAt: new Date().toISOString(), sessionId, runId: options.runId };
		yield { ...base, id: `${options.runId}-1`, type: "run.started", data: { inputId: input.id } };
		const gate = this.nextSendGate;
		this.nextSendGate = undefined;
		if (gate) {
			gate.entered();
			await gate.wait;
		}
		yield {
			...base,
			id: `${options.runId}-2`,
			type: "message.text.delta",
			data: { messageId: "assistant-1", contentIndex: 0, delta: "Hello from Pi" },
		};
		conversation.messages.push({
			id: "assistant-1",
			role: "assistant",
			content: [{ type: "text", text: "Hello from Pi" }],
			timestamp: new Date().toISOString(),
		});
		yield { ...base, id: `${options.runId}-3`, type: "run.completed", data: { finalMessageId: "assistant-1" } };
	}

	async abort(): Promise<void> {}
	async getSession(sessionId: string): Promise<RuntimeSession> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Missing fake session");
		return session;
	}
	async listSessions(filter: RuntimeSessionFilter = {}): Promise<RuntimeSession[]> {
		return [...this.sessions.values()].filter((session) => !filter.cwd || session.cwd === filter.cwd);
	}
	async readTranscript(sessionId: string): Promise<RuntimeTranscriptMessage[]> {
		return [...this.requireConversation(sessionId).messages];
	}
	async readTranscriptReference(options: ResumeRuntimeSessionOptions): Promise<RuntimeTranscriptMessage[]> {
		return this.readTranscript(options.reference.runtimeSessionId);
	}
	async deleteSessionReference(options: ResumeRuntimeSessionOptions): Promise<void> {
		this.sessions.delete(options.reference.runtimeSessionId);
		this.conversations.delete(options.reference.runtimeSessionId);
	}
	getCapabilities(): RuntimeCapabilities {
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
	async listModels(): Promise<RuntimeModel[]> {
		return [
			{
				provider: "fake",
				modelId: "test",
				name: "Test",
				available: true,
				reasoning: false,
				contextWindow: 1_000,
				maxTokens: 100,
			},
		];
	}
	async selectModel(sessionId: string, model: RuntimeModelRef): Promise<void> {
		const session = await this.getSession(sessionId);
		this.sessions.set(sessionId, { ...session, model });
	}
	async releaseSession(sessionId: string): Promise<void> {
		this.sessions.delete(sessionId);
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		this.sessions.clear();
	}

	pauseNextSend(): { entered: Promise<void>; release(): void } {
		let markEntered: (() => void) | undefined;
		let release: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.nextSendGate = { entered: () => markEntered?.(), wait };
		return { entered, release: () => release?.() };
	}

	private requireConversation(sessionId: string): FakeConversation {
		const conversation = this.conversations.get(sessionId);
		if (!conversation) throw new Error("Missing fake conversation");
		return conversation;
	}
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startTestServer(runtime: AgentRuntime, dataRoot: string, staticRoot?: string) {
	const application = await createWorkbenchApplication({ dataRoot, runtime });
	const server = new WorkbenchHttpServer(application, { port: 0, token: "test-token", staticRoot });
	const started = await server.start();
	cleanups.push(async () => {
		await server.close();
		await application.close();
	});
	const request = async (path: string, init: RequestInit = {}) =>
		fetch(`${started.origin}${path}`, {
			...init,
			headers: { authorization: "Bearer test-token", "content-type": "application/json", ...init.headers },
		});
	return { application, request, started };
}

describe("Workbench Gateway", () => {
	test("Agent Tasks with separate sessions finish independently while another task is still running", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-server-queue-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const runtime = new FakeRuntime();
		const workbench = await startTestServer(runtime, root);
		const project = await workbench.application.createProject({ name: "Queued Work" });
		const firstTask = await workbench.application.services.tasks.create({
			projectId: project.id,
			title: "First agent task",
			type: "agent",
		});
		const secondTask = await workbench.application.services.tasks.create({
			projectId: project.id,
			title: "Second agent task",
			type: "agent",
		});
		const gate = runtime.pauseNextSend();

		const first = await workbench.application.startTask(firstTask.id);
		await gate.entered;
		const second = await workbench.application.startTask(secondTask.id);
		await (await workbench.request(`/api/v1/runs/${second.runId}/events`)).text();
		expect((await workbench.application.services.tasks.get(firstTask.id)).status).toBe("running");
		expect((await workbench.application.services.tasks.get(secondTask.id)).status).toBe("review");
		expect((await workbench.application.services.tasks.listRuns(secondTask.id))[0]).toMatchObject({
			status: "review",
			agentRunId: second.runId,
		});
		gate.release();
		await (await workbench.request(`/api/v1/runs/${first.runId}/events`)).text();
		expect((await workbench.application.services.tasks.get(firstTask.id)).status).toBe("review");
	});

	test("binds personal sessions to the Workbench workspace and injects query-scoped memory", async () => {
		const fixture = await createAssistantFixture();
		try {
			const candidate = await fixture.application.services.memory.propose(
				{},
				{
					kind: "global",
					proposedText: "火星检索标记使用已确认的整理方法。",
					reason: "用户确认长期知识",
				},
			);
			await fixture.application.services.memory.accept(candidate.id);
			const daily = await fixture.application.services.memory.propose(
				{},
				{ kind: "daily", date: "2026-09-15", proposedText: "DAILY_UNPROMOTED_SCRATCH", reason: "保留每日资料" },
			);
			await fixture.application.services.memory.accept(daily.id);
			const session = await fixture.application.createSession({ profileSlug: "standard" });
			expect(session.cwd).toBe(join(fixture.application.paths.workspace, "chats", session.id));
			fixture.faux.setResponses([
				(context) => {
					expect(context.systemPrompt).toContain("<workbench-memory-context>");
					expect(context.systemPrompt).toContain("火星检索标记");
					expect(context.systemPrompt).toContain("MEMORY.md");
					expect(context.systemPrompt).not.toContain("DAILY_UNPROMOTED_SCRATCH");
					return fauxAssistantMessage("按已确认知识继续整理。");
				},
			]);
			const messageResponse = await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "继续火星检索整理" }),
			});
			expect(messageResponse.status).toBe(202);
			const run = (await messageResponse.json()) as { runId: string };
			await (await fixture.request(`/runs/${run.runId}/events`)).text();
		} finally {
			await fixture.close();
		}
	});

	test("releases the runtime and instance lock when one shutdown step fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-server-close-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const runtime = new FakeRuntime();
		const application = await createWorkbenchApplication({ dataRoot: root, runtime });
		const disposePermissions = application.services.permissions.dispose.bind(application.services.permissions);
		application.services.permissions.dispose = async () => {
			await disposePermissions();
			throw new Error("permission cleanup failed");
		};

		await expect(application.close()).rejects.toThrow("permission cleanup failed");
		expect(runtime.disposed).toBe(true);

		const reopened = await createWorkbenchApplication({ dataRoot: root, runtime: new FakeRuntime() });
		await reopened.close();
	});

	test("serves projects, sessions, streaming, tasks, memory, files, and restart recovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-server path 中文-"));
		const projectParent = await mkdtemp(join(tmpdir(), "workbench-project-source-"));
		const sourcePath = join(projectParent, "CV Learning");
		await mkdir(sourcePath);
		cleanups.push(() => rm(projectParent, { recursive: true, force: true }));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const conversations = new Map<string, FakeConversation>();
		const first = await startTestServer(new FakeRuntime(conversations), root);
		const unauthorized = await fetch(`${first.started.origin}/api/v1/health`);
		expect(unauthorized.status).toBe(403);
		await expect(createWorkbenchApplication({ dataRoot: root, runtime: new FakeRuntime() })).rejects.toMatchObject({
			code: "conflict",
		});

		const projectResponse = await first.request("/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ sourcePath }),
		});
		expect(projectResponse.status).toBe(201);
		const project = (await projectResponse.json()) as { id: string; slug: string };
		expect(project.slug).toBe("cv-learning");
		const defaultMode = await first.request("/api/v1/settings/agent.defaultMode", {
			method: "PUT",
			body: JSON.stringify({ value: "ptc" }),
		});
		expect(defaultMode.status).toBe(200);
		const profiles = (await (await first.request("/api/v1/profiles")).json()) as Array<{
			id: string;
			slug: string;
		}>;
		const defaultSessionResponse = await first.request("/api/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: project.id, title: "Uses configured mode" }),
		});
		expect(defaultSessionResponse.status).toBe(400);

		const sessionResponse = await first.request("/api/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: project.id, profileSlug: "standard" }),
		});
		expect(sessionResponse.status).toBe(201);
		const session = (await sessionResponse.json()) as { id: string; agentProfileId: string };
		expect(session.agentProfileId).toBe(profiles.find((profile) => profile.slug === "standard")?.id);
		const messageResponse = await first.request(`/api/v1/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "Continue the project" }),
		});
		expect(messageResponse.status).toBe(202);
		const run = (await messageResponse.json()) as { runId: string };
		const stream = await first.request(`/api/v1/runs/${run.runId}/events`);
		const streamText = await stream.text();
		expect(streamText).toContain("event: message.text.delta");
		expect(streamText).toContain("Hello from Pi");
		expect(streamText).toContain("event: run.completed");
		const diagnostics = (await (await first.request("/api/v1/developer/events")).json()) as Array<{
			stage: string;
			type: string;
		}>;
		expect(diagnostics).toContainEqual(expect.objectContaining({ stage: "normalized", type: "run.completed" }));
		const runtimeInfo = (await (await first.request("/api/v1/runtime/info")).json()) as {
			runtime: string;
			workspacePath: string;
		};
		expect(runtimeInfo).toMatchObject({ runtime: "pi", workspacePath: join(root, "workspace") });
		const logs = (await (await first.request("/api/v1/developer/logs")).json()) as Array<{ event: string }>;
		expect(logs.some((entry) => entry.event === "message.send")).toBe(true);
		const resumedStream = await first.request(`/api/v1/runs/${run.runId}/events?after=1`);
		const resumedText = await resumedStream.text();
		expect(resumedText).not.toContain("event: run.started");
		expect(resumedText).toContain("event: message.text.delta");
		expect(resumedText).toContain("event: run.completed");

		const taskResponse = await first.request("/api/v1/tasks", {
			method: "POST",
			body: JSON.stringify({ projectId: project.id, title: "Review model results", type: "agent" }),
		});
		expect(taskResponse.status).toBe(201);
		const agentTask = (await taskResponse.json()) as { id: string };
		const taskRunResponse = await first.request(`/api/v1/tasks/${agentTask.id}/run`, {
			method: "POST",
			body: JSON.stringify({ profileSlug: "standard" }),
		});
		expect(taskRunResponse.status).toBe(202);
		const taskRun = (await taskRunResponse.json()) as { runId: string; taskRun: { id: string } };
		await (await first.request(`/api/v1/runs/${taskRun.runId}/events`)).text();
		const reviewedTask = (await (await first.request(`/api/v1/tasks/${agentTask.id}`)).json()) as {
			status: string;
		};
		expect(reviewedTask.status).toBe("review");
		const taskRuns = (await (await first.request(`/api/v1/tasks/${agentTask.id}/runs`)).json()) as Array<{
			status: string;
		}>;
		expect(taskRuns[0]?.status).toBe("review");
		const candidateResponse = await first.request("/api/v1/memory/candidates", {
			method: "POST",
			body: JSON.stringify({
				kind: "project",
				projectId: project.id,
				proposedText: "Use the CV Learning workspace for experiments.",
				reason: "Durable project decision",
			}),
		});
		const candidate = (await candidateResponse.json()) as { id: string };
		const accepted = await first.request(`/api/v1/memory/candidates/${candidate.id}/accept`, { method: "POST" });
		expect(accepted.status).toBe(200);
		const memoryFiles = (await (await first.request("/api/v1/memory/files")).json()) as Array<{
			relativePath: string;
		}>;
		expect(memoryFiles.map((entry) => entry.relativePath)).toContain("projects/cv-learning/AGENTS.md");
		const file = (await (await first.request(`/api/v1/files/read?path=projects/cv-learning/AGENTS.md`)).json()) as {
			content: string;
			contentHash: string;
		};
		expect(file.content).toContain("Use the CV Learning workspace");
		const editedThroughFiles = await first.request("/api/v1/files/write", {
			method: "PUT",
			body: JSON.stringify({
				path: "projects/cv-learning/AGENTS.md",
				content: `${file.content}\nUser-edited through the Files page.\n`,
				expectedHash: file.contentHash,
			}),
		});
		expect(editedThroughFiles.status).toBe(200);
		const indexedEdit = (await (
			await first.request(`/api/v1/memory/search?q=${encodeURIComponent("User-edited")}&projectId=${project.id}`)
		).json()) as Array<{ snippet: string }>;
		expect(indexedEdit.some((entry) => entry.snippet.includes("User-edited"))).toBe(true);
		const deniedWrite = await first.request("/api/v1/files/write", {
			method: "PUT",
			body: JSON.stringify({ path: "../outside.txt", content: "denied" }),
		});
		expect(deniedWrite.status).toBe(403);
		const home = (await (await first.request("/api/v1/home")).json()) as {
			projects: Array<{ id: string }>;
			tasks: Array<{ id: string }>;
			activity: Array<{ type: string; projectId?: string }>;
		};
		expect(home.projects.map((entry) => entry.id)).toContain(project.id);
		expect(home.tasks.map((entry) => entry.id)).toContain(agentTask.id);
		expect(home.activity.some((entry) => entry.type === "run.completed")).toBe(true);
		expect(home.activity.some((entry) => entry.type === "memory.candidate.accepted")).toBe(true);

		await first.application.close();
		const secondApplication = await createWorkbenchApplication({
			dataRoot: root,
			runtime: new FakeRuntime(conversations),
		});
		cleanups.push(() => secondApplication.close());
		const projects = await secondApplication.services.projects.list();
		const tasks = await secondApplication.services.tasks.list({ projectId: project.id });
		const transcript = await secondApplication.services.sessions.readTranscript(
			session.id,
			(await secondApplication.contextForSession(session.id)).runtime,
		);
		expect(projects).toHaveLength(1);
		expect(tasks).toHaveLength(1);
		expect((await secondApplication.services.activity.list()).some((entry) => entry.type === "run.completed")).toBe(
			true,
		);
		expect(transcript.map((message) => message.content[0]?.text)).toContain("Continue the project");
		expect(await readFile(join(root, "workspace", "projects", "cv-learning", "AGENTS.md"), "utf8")).toContain(
			"Use the CV Learning workspace",
		);
	});

	test("rejects malformed request bodies and cross-origin requests", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-server-validation-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const staticRoot = join(root, "ui");
		await mkdir(staticRoot);
		await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Workbench test</title>", "utf8");
		const { request, started } = await startTestServer(new FakeRuntime(), root, staticRoot);
		const malformed = await request("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: "" }) });
		expect(malformed.status).toBe(400);
		expect((await request("/api/v1/tasks?status=unknown")).status).toBe(400);
		expect((await request("/api/v1/memory/candidates?status=unknown")).status).toBe(400);
		expect((await request("/api/v1/developer/events?stage=unknown")).status).toBe(400);
		expect((await request("/api/v1/developer/logs?limit=0")).status).toBe(400);
		const crossOrigin = await fetch(`${started.origin}/api/v1/health`, {
			headers: { authorization: "Bearer test-token", origin: "https://example.com" },
		});
		expect(crossOrigin.status).toBe(403);
		const bootstrap = await fetch(started.launchUrl, { redirect: "manual" });
		expect(bootstrap.status).toBe(303);
		const cookie = bootstrap.headers.get("set-cookie");
		expect(cookie).toContain("HttpOnly");
		const page = await fetch(`${started.origin}/chat`, { headers: { cookie: cookie ?? "" } });
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Workbench test");
	});
});
