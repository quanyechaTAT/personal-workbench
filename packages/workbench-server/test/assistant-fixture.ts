import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createWorkbenchApplication } from "../src/application.ts";
import { WorkbenchHttpServer } from "../src/http-server.ts";
import type { SystemFolderReader } from "../src/system-folders.ts";

class TestCredentials implements CredentialStore {
	private readonly entries = new Map<string, Credential>();
	async read(id: string) {
		return this.entries.get(id);
	}
	async list(): Promise<readonly CredentialInfo[]> {
		return [...this.entries].map(([providerId, value]) => ({ providerId, type: value.type }));
	}
	async modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
		const value = await fn(this.entries.get(id));
		if (value) this.entries.set(id, value);
		else this.entries.delete(id);
		return value;
	}
	async delete(id: string) {
		this.entries.delete(id);
	}
}

/** Real Pi + SQLite + HTTP. Only model responses are supplied deterministically. */
export async function createAssistantFixture(
	staticRoot?: string,
	options: {
		modelInput?: ("text" | "image")[];
		modelContextWindow?: number;
		tokensPerSecond?: number;
		systemFolders?: SystemFolderReader;
		pickDirectory?: (signal: AbortSignal) => Promise<string | undefined>;
		pickSkillFile?: (signal: AbortSignal) => Promise<string | undefined>;
		openLoginUrl?: (url: string) => Promise<void>;
		generateTitle?: false | ((sessionId: string, prompt: string, signal: AbortSignal) => Promise<string | undefined>);
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "workbench-assistants 中文 "));
	const agentDir = join(root, "pi-agent");
	await mkdir(agentDir);
	const faux = registerFauxProvider({
		provider: `wb-${Date.now()}`,
		models:
			options.modelInput || options.modelContextWindow
				? [{ id: "fixture-model", input: options.modelInput, contextWindow: options.modelContextWindow }]
				: undefined,
		tokenSize: { min: 1, max: 3 },
		tokensPerSecond: options.tokensPerSecond,
	});
	const model = faux.getModel();
	const credentials = new TestCredentials();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "fixture-only" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
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
	async function start() {
		const application = await createWorkbenchApplication({
			dataRoot: join(root, "data"),
			embeddingEnvFile: join(root, "system.env"),
			agentDir,
			pi: { modelRuntime, defaultModel: model },
			systemFolders: options.systemFolders,
		});
		// Background learning has its own explicit fixtures, separate from conversation response queues.
		if (!(await application.services.settings.get("learning.schedule")))
			await application.services.settings.set("learning.schedule", { memoryInterval: 0, skillInterval: 0 });
		if (!(await application.services.settings.get("memory.checkpointReviewEnabled")))
			await application.services.settings.set("memory.checkpointReviewEnabled", false);
		// Isolate auxiliary metadata requests from the faux provider's conversation response queue.
		if (options.generateTitle !== false)
			application.runtime.generateSessionTitle =
				options.generateTitle ??
				(async (_id, prompt) =>
					prompt
						.trim()
						.split(/\r?\n/u)[0]
						.replace(/^#+\s*/u, ""));
		const server = new WorkbenchHttpServer(application, {
			port: 0,
			token: "assistant-fixture-token",
			staticRoot,
			pickDirectory: options.pickDirectory,
			pickSkillFile: options.pickSkillFile,
			openLoginUrl: options.openLoginUrl ?? (async () => undefined),
		});
		const address = await server.start();
		return { application, server, address };
	}
	let active = await start();
	return {
		root,
		embeddingEnvFile: join(root, "system.env"),
		faux,
		model,
		modelRuntime,
		get application() {
			return active.application;
		},
		get address() {
			return active.address;
		},
		async request(path: string, init?: RequestInit) {
			return fetch(`${active.address.origin}/api/v1${path}`, {
				...init,
				headers: {
					authorization: "Bearer assistant-fixture-token",
					"content-type": "application/json",
					...init?.headers,
				},
			});
		},
		async restart() {
			await active.server.close();
			await active.application.close();
			active = await start();
		},
		async close() {
			await active.server.close();
			await active.application.close();
			faux.unregister();
			await rm(root, { recursive: true, force: true });
		},
	};
}
