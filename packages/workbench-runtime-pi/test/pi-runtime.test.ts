import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxThinking, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { defineTool, type ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Approval, Project, WorkbenchTask } from "@earendil-works/workbench-core";
import type { AgentEvent, RuntimeSession } from "@earendil-works/workbench-runtime";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { PiRuntime } from "../src/pi-runtime.ts";
import { createWorkbenchExtension, type WorkbenchExtensionServices } from "../src/workbench-extension.ts";

class MemoryCredentialStore implements CredentialStore {
	private readonly credentials = new Map<string, Credential>();

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.credentials.get(providerId);
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const credential = await fn(this.credentials.get(providerId));
		if (credential) this.credentials.set(providerId, credential);
		return credential;
	}

	async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		this.credentials.delete(providerId);
	}
}

interface TestHarness {
	root: string;
	workspace: string;
	agentDir: string;
	sessionDir: string;
	modelRuntime: ModelRuntime;
	faux: ReturnType<typeof registerFauxProvider>;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()?.();
});

async function createHarness(name: string, tokensPerSecond?: number): Promise<TestHarness> {
	const root = await mkdtemp(join(tmpdir(), `workbench-pi-${name}-`));
	const workspace = join(root, "workspace", "projects", "CV Learning");
	const agentDir = join(root, "pi-agent");
	const sessionDir = join(root, "state", "pi-sessions");
	await Promise.all([mkdir(workspace, { recursive: true }), mkdir(agentDir, { recursive: true })]);
	const faux = registerFauxProvider({
		provider: `workbench-${name}`,
		tokensPerSecond,
		tokenSize: { min: 1, max: 1 },
	});
	const credentials = new MemoryCredentialStore();
	await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "test-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
	});
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	cleanup.push(async () => {
		faux.unregister();
		await rm(root, { recursive: true, force: true });
	});
	return { root, workspace, agentDir, sessionDir, modelRuntime, faux };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const collected: AgentEvent[] = [];
	for await (const event of events) collected.push(event);
	return collected;
}

function createProbeTool(onExecute: (value: string) => void = () => undefined) {
	return defineTool({
		name: "workbench_probe",
		label: "Workbench probe",
		description: "Confirms that Workbench custom tools are available",
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_toolCallId, params) => {
			onExecute(params.value);
			return { content: [{ type: "text", text: `probe:${params.value}` }], details: {} };
		},
	});
}

async function createRuntime(
	harness: TestHarness,
	options: {
		extensionFactories?: ExtensionFactory[];
		sessionExtensionFactories?: Parameters<typeof PiRuntime.create>[0]["sessionExtensionFactories"];
		onRawEvent?: Parameters<typeof PiRuntime.create>[0]["onRawEvent"];
		tool?: ReturnType<typeof createProbeTool>;
		toolNames?: string[];
	} = {},
): Promise<PiRuntime> {
	return PiRuntime.create({
		agentDir: harness.agentDir,
		sessionDir: harness.sessionDir,
		modelRuntime: harness.modelRuntime,
		defaultModel: harness.faux.getModel(),
		toolNames: options.tool ? ["read", options.tool.name, ...(options.toolNames ?? [])] : (options.toolNames ?? []),
		customTools: options.tool ? [options.tool] : [],
		extensionFactories: options.extensionFactories,
		sessionExtensionFactories: options.sessionExtensionFactories,
		onRawEvent: options.onRawEvent,
	});
}

describe("PiRuntime POC", () => {
	it("rejects a correction processed after settlement and clears it before the next run", async () => {
		const harness = await createHarness("steering-settlement", 100);
		let inputEntered: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			inputEntered = resolve;
		});
		let releaseInput: (() => void) | undefined;
		const released = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const extension: ExtensionFactory = (pi) => {
			pi.on("input", async (event) => {
				if (event.text === "延迟纠偏") {
					inputEntered?.();
					await released;
				}
				return { action: "continue" };
			});
		};
		harness.faux.setResponses([
			fauxAssistantMessage("原始任务完成"),
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("延迟纠偏");
				return fauxAssistantMessage("下一轮正常完成");
			},
		]);
		const runtime = await createRuntime(harness, {
			extensionFactories: [extension],
			onRawEvent: ({ event }) => {
				if (event.type === "agent_settled") releaseInput?.();
			},
		});
		try {
			const session = await runtime.createSession({ cwd: harness.workspace, kind: "project" });
			let correction: Promise<unknown> | undefined;
			for await (const event of runtime.sendMessage(
				session.id,
				{ id: "input", text: "原始任务" },
				{ runId: "settling-run" },
			)) {
				if (!correction && event.type === "message.text.delta") {
					correction = runtime
						.steerMessage(session.id, "延迟纠偏", "settling-run")
						.catch((error: unknown) => error);
					await entered;
				}
			}
			expect(correction).toBeDefined();
			await expect(correction).resolves.toMatchObject({ code: "session_busy" });
			const next = await collect(
				runtime.sendMessage(session.id, { id: "next", text: "新任务" }, { runId: "next-run" }),
			);
			expect(next.some((event) => event.type === "run.completed")).toBe(true);
			expect(JSON.stringify(await runtime.readTranscript(session.id))).not.toContain("延迟纠偏");
		} finally {
			releaseInput?.();
			await runtime.dispose();
		}
	});

	it("queues concurrent corrections while the model streams and continues within the same run", async () => {
		const harness = await createHarness("steering-stream", 100);
		const userInputs: string[][] = [];
		harness.faux.setResponses([
			fauxAssistantMessage("正在分析原始任务"),
			(context) => {
				userInputs.push(
					context.messages
						.filter((message) => message.role === "user")
						.map((message) =>
							typeof message.content === "string"
								? message.content
								: message.content
										.filter((part) => part.type === "text")
										.map((part) => part.text)
										.join("\n"),
						),
				);
				return fauxAssistantMessage("继续处理第一条指令");
			},
			(context) => {
				userInputs.push(
					context.messages
						.filter((message) => message.role === "user")
						.map((message) =>
							typeof message.content === "string"
								? message.content
								: message.content
										.filter((part) => part.type === "text")
										.map((part) => part.text)
										.join("\n"),
						),
				);
				return fauxAssistantMessage("按两条追加指令完成");
			},
		]);
		const runtime = await createRuntime(harness);
		try {
			const session = await runtime.createSession({ cwd: harness.workspace, kind: "project" });
			const events: AgentEvent[] = [];
			let submitted = false;
			for await (const event of runtime.sendMessage(
				session.id,
				{ id: "input", text: "原始任务" },
				{ runId: "stream-run" },
			)) {
				events.push(event);
				if (!submitted && event.type === "message.text.delta") {
					submitted = true;
					await Promise.all([
						runtime.steerMessage(session.id, "只修启动问题", "stream-run"),
						runtime.steerMessage(session.id, "保留其他功能", "stream-run"),
					]);
				}
			}
			expect(submitted).toBe(true);
			expect(userInputs.at(-1)).toEqual(["原始任务", "只修启动问题", "保留其他功能"]);
			expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
			expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
			expect(
				events.flatMap((event) =>
					event.type === "message.started" && event.data.steering ? [event.data.text] : [],
				),
			).toEqual(["只修启动问题", "保留其他功能"]);
			expect(events.every((event) => event.runId === "stream-run")).toBe(true);
			await expect(runtime.steerMessage(session.id, "过期纠偏", "stream-run")).rejects.toMatchObject({
				code: "session_busy",
			});
		} finally {
			await runtime.dispose();
		}
	});

	it("retries upstream_error before executing a partially streamed write call", async () => {
		const harness = await createHarness("upstream-write");
		harness.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "result.txt", content: "partial" }, { id: "partial-write" }),
				{ stopReason: "error", errorMessage: "upstream_error: Upstream request failed" },
			),
			fauxAssistantMessage(
				fauxToolCall("write", { path: "result.txt", content: "completed" }, { id: "successful-write" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("文件已写入"),
		]);
		const runtime = await createRuntime(harness, { toolNames: ["write"] });
		try {
			const session = await runtime.createSession({ cwd: harness.workspace, kind: "project" });
			const events = await collect(
				runtime.sendMessage(session.id, { id: "write-after-retry", text: "创建文件" }, { runId: "upstream-run" }),
			);
			expect(events.some((event) => event.type === "run.completed")).toBe(true);
			expect(events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
			expect(await readFile(join(harness.workspace, "result.txt"), "utf8")).toBe("completed");
		} finally {
			await runtime.dispose();
		}
	}, 20_000);

	it("retries a transient model failure five times without replaying the user turn or changing Pi settings", async () => {
		const harness = await createHarness("five-retries");
		const piSettings = { retry: { enabled: false, maxRetries: 1, baseDelayMs: 1 } };
		await writeFile(join(harness.agentDir, "settings.json"), JSON.stringify(piSettings));
		harness.faux.setResponses([
			...Array.from({ length: 5 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			),
			fauxAssistantMessage("重连后已完成"),
		]);
		const runtime = await createRuntime(harness);
		try {
			const session = await runtime.createSession({ cwd: harness.workspace, kind: "project" });
			const events = await collect(
				runtime.sendMessage(session.id, { id: "once", text: "完成任务" }, { runId: "retry-run" }),
			);
			const retries = events.filter((event) => event.type === "agent.status" && event.data.detail?.includes("重试"));
			expect(retries).toHaveLength(5);
			expect(retries[4]).toMatchObject({ data: { detail: expect.stringContaining("5/5") } });
			expect(events.some((event) => event.type === "run.completed")).toBe(true);
			expect((await runtime.readTranscript(session.id)).filter((message) => message.role === "user")).toHaveLength(
				1,
			);
			expect(JSON.parse(await readFile(join(harness.agentDir, "settings.json"), "utf8"))).toEqual(piSettings);
		} finally {
			await runtime.dispose();
		}
	});

	it("streams normalized text, reasoning, and tool events, then resumes the durable Pi session", async () => {
		const harness = await createHarness("resume");
		const skillRoot = join(harness.root, "skills");
		const skillDir = join(skillRoot, "poc-skill");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, "SKILL.md"),
			"---\nname: poc-skill\ndescription: Controlled Workbench POC skill\n---\nUse the POC procedure.\n",
		);
		let extensionStarts = 0;
		const extension: ExtensionFactory = (pi) => {
			pi.on("session_start", () => {
				extensionStarts += 1;
			});
		};
		const toolValues: string[] = [];
		const probe = createProbeTool((value) => toolValues.push(value));
		let sawSkill = false;
		let sawTurnContext = false;
		let resumedSawStaleTurnContext = false;
		harness.faux.setResponses([
			(context) => {
				sawSkill = context.systemPrompt?.includes("poc-skill") === true;
				sawTurnContext = context.systemPrompt?.includes("retrieved memory marker") === true;
				return fauxAssistantMessage(fauxToolCall("workbench_probe", { value: "ready" }, { id: "probe-1" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage([fauxThinking("checking"), { type: "text", text: "first answer" }]),
			(context) => {
				resumedSawStaleTurnContext = context.systemPrompt?.includes("retrieved memory marker") === true;
				return fauxAssistantMessage("continued answer");
			},
		]);

		const runtime = await createRuntime(harness, { extensionFactories: [extension], tool: probe });
		const session = await runtime.createSession({
			cwd: harness.workspace,
			kind: "project",
			context: { skillPaths: [skillDir] },
		});
		expect(existsSync(session.reference.opaque)).toBe(true);
		expect(extensionStarts).toBe(1);
		expect((await readFile(session.reference.opaque, "utf8")).split("\n")[0]).toContain(`"id":"${session.id}"`);

		const events = await collect(
			runtime.sendMessage(
				session.id,
				{ id: "input-1", text: "Run the POC" },
				{
					runId: "run-1",
					context: { appendSystemPrompt: ["retrieved memory marker"] },
				},
			),
		);
		expect(sawSkill).toBe(true);
		expect(sawTurnContext).toBe(true);
		expect(toolValues).toEqual(["ready"]);
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"run.started",
				"message.reasoning.delta",
				"message.text.delta",
				"tool.started",
				"tool.completed",
				"run.completed",
			]),
		);
		const finalMessageId = events.find((event) => event.type === "run.completed")?.data.finalMessageId;
		const streamedMessageIds = events
			.filter((event) => event.type === "message.text.delta" || event.type === "message.reasoning.delta")
			.map((event) => event.data.messageId);
		expect(new Set(streamedMessageIds)).toEqual(new Set([finalMessageId]));
		const models = await runtime.listModels();
		expect(models).toContainEqual(
			expect.objectContaining({ provider: harness.faux.getModel().provider, available: true }),
		);
		await runtime.selectModel(session.id, {
			provider: harness.faux.getModel().provider,
			modelId: harness.faux.getModel().id,
		});
		await runtime.dispose();

		const resumedRuntime = await createRuntime(harness, { extensionFactories: [extension], tool: probe });
		const resumed: RuntimeSession = await resumedRuntime.resumeSession({
			reference: session.reference,
			expectedCwd: harness.workspace,
			kind: "project",
			context: { skillPaths: [skillDir] },
		});
		expect(resumed.id).toBe(session.id);
		expect(extensionStarts).toBe(2);
		const beforeContinue = await resumedRuntime.readTranscript(resumed.id);
		expect(beforeContinue.some((message) => message.content.some((content) => content.text === "first answer"))).toBe(
			true,
		);
		const continuedEvents = await collect(
			resumedRuntime.sendMessage(
				resumed.id,
				{ id: "input-2", text: "Continue yesterday's work" },
				{ runId: "run-2" },
			),
		);
		expect(continuedEvents.at(-2)?.type).toBe("run.completed");
		expect(resumedSawStaleTurnContext).toBe(false);
		const afterContinue = await resumedRuntime.readTranscript(resumed.id);
		expect(
			afterContinue.some((message) => message.content.some((content) => content.text === "continued answer")),
		).toBe(true);
		await resumedRuntime.dispose();
	});

	it("aborts a Windows PowerShell call while an extension approval gate is waiting", async () => {
		const harness = await createHarness("abort");
		let approvalEntered: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			approvalEntered = resolve;
		});
		const gate: ExtensionFactory = (pi) => {
			pi.on("tool_call", async (_event, context) => {
				approvalEntered?.();
				const signal = context.signal;
				if (signal && !signal.aborted) {
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				}
				return { block: true, reason: "Approval cancelled" };
			});
		};
		harness.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("powershell", { command: "Write-Output should-not-run" }, { id: "powershell-abort" }),
				{ stopReason: "toolUse" },
			),
		]);
		const runtime = await createRuntime(harness, { extensionFactories: [gate], toolNames: ["powershell"] });
		const session = await runtime.createSession({ cwd: harness.workspace, kind: "project" });
		const collecting = collect(
			runtime.sendMessage(session.id, { id: "input-abort", text: "Use the tool" }, { runId: "run-abort" }),
		);
		await entered;
		await runtime.abort(session.id);
		const events = await collecting;
		expect(events.some((event) => event.type === "run.aborted")).toBe(true);
		expect((await runtime.getSession(session.id)).status).toBe("idle");
		await runtime.dispose();
	});

	it("rejects a resume when the project cwd binding does not match", async () => {
		const harness = await createHarness("cwd");
		const runtime = await createRuntime(harness);
		const session = await runtime.createSession({ cwd: harness.workspace, kind: "project" });
		await runtime.dispose();
		const resumedRuntime = await createRuntime(harness);
		await expect(
			resumedRuntime.resumeSession({
				reference: session.reference,
				expectedCwd: join(harness.root, "another-project"),
				kind: "project",
			}),
		).rejects.toMatchObject({ code: "invalid_reference" });
		await resumedRuntime.dispose();
	});

	it("runs Workbench service tools through a session-scoped extension and streams permission decisions", async () => {
		const harness = await createHarness("extension");
		const project: Project = {
			id: "project-1",
			slug: "cv-learning",
			name: "CV Learning",
			description: "",
			status: "active",
			workspacePath: harness.workspace,
			projectFilePath: join(harness.workspace, "PROJECT.md"),
			memoryFilePath: join(harness.workspace, "MEMORY.md"),
			createdAt: "2026-09-15T00:00:00.000Z",
			updatedAt: "2026-09-15T00:00:00.000Z",
		};
		const createdTasks: WorkbenchTask[] = [];
		const approval: Approval = {
			id: "approval-1",
			sessionId: "pi-session",
			runId: "run-extension",
			toolCallId: "shell-1",
			toolName: "powershell",
			operation: { command: "Write-Output should-not-run" },
			status: "pending",
			requestedAt: "2026-09-15T00:00:00.000Z",
			expiresAt: "2026-09-15T00:01:00.000Z",
		};
		const services: WorkbenchExtensionServices = {
			projects: { list: async () => [project] },
			tasks: {
				create: async (input) => {
					const task: WorkbenchTask = {
						id: "task-created",
						projectId: input.projectId,
						title: input.title,
						description: input.description ?? "",
						type: input.type ?? "human",
						status: input.status ?? "todo",
						priority: input.priority ?? 2,
						assignedTo: "me",
						createdAt: "2026-09-15T00:00:00.000Z",
						updatedAt: "2026-09-15T00:00:00.000Z",
						version: 1,
					};
					createdTasks.push(task);
					return task;
				},
				get: async (id) => {
					const task = createdTasks.find((entry) => entry.id === id);
					if (!task) throw new Error("missing task");
					return task;
				},
				list: async () => createdTasks,
				update: async (id) => {
					const task = createdTasks.find((entry) => entry.id === id);
					if (!task) throw new Error("missing task");
					return task;
				},
			},
			memory: {
				propose: async () => {
					throw new Error("not used");
				},
				search: async () => [],
			},
			artifacts: {
				register: async () => {
					throw new Error("not used");
				},
			},
			permissions: {
				requiresApproval: async () => true,
				request: async (input) => ({
					approval: { ...approval, sessionId: input.sessionId, runId: input.runId, toolCallId: input.toolCallId },
					decision: Promise.resolve("denied"),
				}),
				resolve: async () => ({ ...approval, status: "cancelled" }),
			},
			pathPolicy: {
				classify: async (input) => ({ input, absolutePath: input, realPath: input, zone: "workspace" }),
				isProtectedMemoryPath: () => false,
			},
		};
		let currentRunId: string | undefined;
		harness.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task_create", { title: "Review dataset", type: "agent" }, { id: "task-1" }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage(
				fauxToolCall("powershell", { command: "Write-Output should-not-run" }, { id: "shell-1" }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("Handled the denied command safely"),
		]);
		const runtime = await createRuntime(harness, {
			toolNames: ["task_create", "powershell"],
			sessionExtensionFactories: (context) => [
				createWorkbenchExtension({
					services,
					resolveScope: async () => ({ project, sessionId: context.sessionId, runId: currentRunId }),
					onPermissionEvent: context.emitPermissionEvent,
				}),
			],
		});
		const session = await runtime.createSession({ cwd: harness.workspace, kind: "project" });
		currentRunId = "run-extension";
		const events = await collect(
			runtime.sendMessage(
				session.id,
				{ id: "input-extension", text: "Create the task, then run a command" },
				{ runId: currentRunId },
			),
		);
		expect(createdTasks).toHaveLength(1);
		expect(createdTasks[0].projectId).toBe(project.id);
		expect(events).toContainEqual(expect.objectContaining({ type: "permission.requested" }));
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "permission.resolved",
				data: { approvalId: "approval-1", decision: "denied" },
			}),
		);
		expect(events.some((event) => event.type === "run.completed")).toBe(true);
		await runtime.dispose();
	});
});
