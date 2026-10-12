import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
	Model,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkbenchApplication, type WorkbenchApplication } from "../src/application.ts";
import { WorkbenchHttpServer } from "../src/http-server.ts";

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

interface RunningWorkbench {
	application: WorkbenchApplication;
	server: WorkbenchHttpServer;
	request(path: string, init?: RequestInit): Promise<Response>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startWorkbench(
	dataRoot: string,
	agentDir: string,
	modelRuntime: ModelRuntime,
	defaultModel: Model<Api>,
): Promise<RunningWorkbench> {
	const application = await createWorkbenchApplication({
		dataRoot,
		agentDir,
		pi: { modelRuntime, defaultModel },
	});
	const server = new WorkbenchHttpServer(application, { port: 0, token: "e2e-token" });
	const started = await server.start();
	return {
		application,
		server,
		request: (path, init = {}) =>
			fetch(`${started.origin}${path}`, {
				...init,
				headers: { authorization: "Bearer e2e-token", "content-type": "application/json", ...init.headers },
			}),
	};
}

async function closeWorkbench(workbench: RunningWorkbench): Promise<void> {
	await workbench.server.close();
	await workbench.application.close();
}

function streamedText(payload: string): string {
	return payload
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)) as { type: string; data: { delta?: string } })
		.filter((event) => event.type === "message.text.delta")
		.map((event) => event.data.delta ?? "")
		.join("");
}

describe("Personal Workbench end-to-end", () => {
	test("persists a Pi project run with files, tools, task, artifact, memory, and resumable conversation", async () => {
		const root = await mkdtemp(join(tmpdir(), "personal-workbench e2e 中文-"));
		const projectParent = await mkdtemp(join(tmpdir(), "personal-workbench source-"));
		const sourcePath = join(projectParent, "CV Learning");
		await mkdir(join(sourcePath, "artifacts"), { recursive: true });
		cleanups.push(() => rm(projectParent, { recursive: true, force: true }));
		const agentDir = join(root, "credentials", "pi-agent");
		await mkdir(agentDir, { recursive: true });
		cleanups.push(() => rm(root, { recursive: true, force: true }));

		const faux = registerFauxProvider({ provider: "workbench-e2e", tokenSize: { min: 1, max: 1 } });
		cleanups.push(async () => faux.unregister());
		const credentials = new MemoryCredentialStore();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
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

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"write",
					{
						path: "artifacts/learning-plan.md",
						content: "# CV Learning Plan\n\nStart with image classification.\n",
					},
					{ id: "write-plan" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"artifact_register",
					{
						type: "document",
						name: "CV Learning Plan",
						workspaceRelativePath: "artifacts/learning-plan.md",
					},
					{ id: "register-plan" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"task_create",
					{ title: "Run the first image classification experiment", type: "human", priority: 1 },
					{ id: "create-task" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"memory_propose",
					{
						kind: "project",
						proposedText: "Begin CV Learning with image classification before detection.",
						reason: "This is the agreed learning sequence.",
					},
					{ id: "propose-memory" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The CV Learning workspace is prepared."),
		]);

		const first = await startWorkbench(root, agentDir, modelRuntime, model);
		cleanups.push(() => closeWorkbench(first));
		const projectResponse = await first.request("/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ sourcePath }),
		});
		expect(projectResponse.status).toBe(201);
		const project = (await projectResponse.json()) as { id: string };
		const sessionResponse = await first.request("/api/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: project.id, profileSlug: "standard", title: "Plan CV learning" }),
		});
		expect(sessionResponse.status).toBe(201);
		const session = (await sessionResponse.json()) as { id: string };
		const messageResponse = await first.request(`/api/v1/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "Prepare the project plan, task, artifact, and memory proposal." }),
		});
		const run = (await messageResponse.json()) as { runId: string };
		const streamText = await (await first.request(`/api/v1/runs/${run.runId}/events`)).text();
		expect(streamText).toContain("event: message.text.delta");
		expect(streamText).toContain("event: tool.completed");
		expect(streamedText(streamText)).toContain("The CV Learning workspace is prepared.");
		expect(streamText).toContain("event: run.completed");
		const rawEvents = (await (await first.request("/api/v1/developer/events?stage=raw.pi")).json()) as Array<{
			stage: string;
			type: string;
		}>;
		expect(rawEvents.some((event) => event.stage === "raw.pi" && event.type === "agent_end")).toBe(true);

		const tasks = (await (await first.request(`/api/v1/tasks?projectId=${project.id}`)).json()) as Array<{
			title: string;
		}>;
		expect(tasks.map((task) => task.title)).toContain("Run the first image classification experiment");
		const artifacts = (await (await first.request(`/api/v1/artifacts?projectId=${project.id}`)).json()) as Array<{
			name: string;
			relativePath: string;
		}>;
		expect(artifacts).toContainEqual(
			expect.objectContaining({
				name: "CV Learning Plan",
				relativePath: "artifacts/learning-plan.md",
			}),
		);
		const candidates = (await (await first.request("/api/v1/memory/candidates")).json()) as Array<{
			id: string;
			status: string;
		}>;
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.status).toBe("pending");
		const accepted = await first.request(`/api/v1/memory/candidates/${candidates[0]?.id}/accept`, {
			method: "POST",
		});
		expect(accepted.status).toBe(200);
		expect(await readFile(join(sourcePath, "artifacts", "learning-plan.md"), "utf8")).toContain(
			"image classification",
		);

		await closeWorkbench(first);
		faux.setResponses([fauxAssistantMessage("Continuing yesterday's CV Learning work from the saved session.")]);
		const second = await startWorkbench(root, agentDir, modelRuntime, model);
		cleanups.push(() => closeWorkbench(second));
		const restoredProjects = (await (await second.request("/api/v1/projects")).json()) as Array<{ id: string }>;
		expect(restoredProjects.map((entry) => entry.id)).toContain(project.id);
		const restoredTasks = (await (await second.request(`/api/v1/tasks?projectId=${project.id}`)).json()) as Array<{
			title: string;
		}>;
		expect(restoredTasks).toHaveLength(1);
		const restoredArtifacts = (await (
			await second.request(`/api/v1/artifacts?projectId=${project.id}`)
		).json()) as Array<{ name: string }>;
		expect(restoredArtifacts).toHaveLength(1);
		expect(await readFile(join(root, "workspace", "projects", "cv-learning", "MEMORY.md"), "utf8")).toContain(
			"Begin CV Learning with image classification",
		);
		const resume = await second.request(`/api/v1/sessions/${session.id}/resume`, { method: "POST" });
		expect(resume.status).toBe(200);
		const continueResponse = await second.request(`/api/v1/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "继续这个项目昨天的工作。" }),
		});
		const continuedRun = (await continueResponse.json()) as { runId: string };
		const continuedStream = await (await second.request(`/api/v1/runs/${continuedRun.runId}/events`)).text();
		expect(streamedText(continuedStream)).toContain(
			"Continuing yesterday's CV Learning work from the saved session.",
		);
		const transcript = (await (await second.request(`/api/v1/sessions/${session.id}/transcript`)).json()) as Array<{
			content: Array<{ text?: string }>;
		}>;
		expect(transcript.some((message) => message.content.some((content) => content.text?.includes("昨天")))).toBe(
			true,
		);
		await closeWorkbench(second);
	});
});
