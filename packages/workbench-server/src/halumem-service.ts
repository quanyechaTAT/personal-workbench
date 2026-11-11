import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Project, WorkbenchError, writeTextAtomically } from "@earendil-works/workbench-core";
import type { SaveModelProviderInput } from "@earendil-works/workbench-core/contracts";
import type { RuntimeModelRef, RuntimeUsage } from "@earendil-works/workbench-runtime";
import { type Static, Type } from "typebox";
import { createWorkbenchApplication, type WorkbenchApplication } from "./application.ts";

const Identity = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" });
const Scope = { run_id: Identity, user_id: Identity };
export const HaluMemAddSchema = Type.Object(
	{
		...Scope,
		session_id: Identity,
		timestamp: Type.String({ format: "date-time" }),
		dialogue: Type.Array(
			Type.Object(
				{
					role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
					content: Type.String(),
					timestamp: Type.Optional(Type.String({ format: "date-time" })),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 10000 },
		),
	},
	{ additionalProperties: false },
);
export const HaluMemGetSchema = Type.Object({ ...Scope, session_id: Identity }, { additionalProperties: false });
export const HaluMemRetrieveSchema = Type.Object(
	{
		...Scope,
		query: Type.String({ minLength: 1, maxLength: 12000 }),
		top_k: Type.Integer({ minimum: 1, maximum: 50 }),
		generate_answer: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
type AddInput = Static<typeof HaluMemAddSchema>;
type ScopeInput = Static<typeof HaluMemGetSchema>;
type RetrieveInput = Static<typeof HaluMemRetrieveSchema>;
interface MemoryPoint {
	id: string;
	memory: string;
	timestamp: string;
	version?: number;
}
interface Receipt {
	input_hash: string;
	session_id: string;
	workbench_session_id: string;
	workbench_run_id: string;
	review_id?: string;
	status: "processing" | "ready";
	memories: MemoryPoint[];
	diagnostics: unknown[];
	duration_ms?: number;
	extraction_usage?: { input: number; output: number; total: number };
}
interface UserWorkspace {
	application: WorkbenchApplication;
	project: Project;
	directory: string;
}
export interface HaluMemOptions {
	root: string;
	model?: RuntimeModelRef;
	agentDir?: string;
	embeddingEnvFile?: string;
	qaPrompt: string;
	provider?: Omit<SaveModelProviderInput, "expectedVersion">;
	createApplication?: (root: string) => Promise<WorkbenchApplication>;
}

/** Imports the corpus into native Pi history, then uses the unchanged project review and retrieval services. */
export class HaluMemService {
	private readonly options: HaluMemOptions;
	private readonly users = new Map<string, Promise<UserWorkspace>>();
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly controller = new AbortController();
	readonly model: RuntimeModelRef;
	constructor(options: HaluMemOptions) {
		this.options = { ...options, root: resolve(options.root) };
		this.model = options.model ?? { provider: "openai-codex", modelId: "gpt-6-luna" };
	}
	async addDialogue(input: AddInput, external?: AbortSignal): Promise<Receipt> {
		if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(input.session_id))
			throw new WorkbenchError("invalid_input", "Invalid session identity");
		if (!input.dialogue.some((turn) => turn.role === "assistant"))
			throw new WorkbenchError("invalid_input", "Dialogue requires at least one original assistant reply");
		return this.exclusive(input, async () => {
			const signal = AbortSignal.any([
				this.controller.signal,
				AbortSignal.timeout(300000),
				...(external ? [external] : []),
			]);
			const workspace = await this.workspace(input);
			const { application, project, directory } = workspace;
			const path = join(directory, "sessions", `${input.session_id}.json`);
			const inputHash = createHash("sha256")
				.update(
					JSON.stringify({
						timestamp: input.timestamp,
						dialogue: input.dialogue.map(({ role, content, timestamp }) => ({ role, content, timestamp })),
					}),
				)
				.digest("hex");
			let receipt = await this.receipt(path);
			if (receipt && receipt.input_hash !== inputHash)
				throw new WorkbenchError("conflict", "Session ID already contains different dialogue");
			if (receipt?.status === "ready") return receipt;
			const started = performance.now();
			if (!receipt) {
				const session = await application.createSession({
					projectId: project.id,
					profileSlug: "standard",
					model: this.model,
					title: `HaluMem ${input.session_id}`,
				});
				receipt = {
					input_hash: inputHash,
					session_id: input.session_id,
					workbench_session_id: session.id,
					workbench_run_id: randomUUID(),
					status: "processing",
					memories: [],
					diagnostics: [],
				};
				await writeTextAtomically(path, JSON.stringify(receipt));
			}
			const session = await application.services.sessions.get(receipt.workbench_session_id);
			if (typeof session.runtimeRef !== "string")
				throw new WorkbenchError("invalid_input", "HaluMem requires native Pi JSONL history");
			const historyPath = await realpath(session.runtimeRef);
			if (!historyPath.startsWith(`${await realpath(application.paths.piSessions)}${sep}`))
				throw new WorkbenchError("path_denied", "History is outside the evaluation workspace");
			const manager = SessionManager.open(historyPath, application.paths.piSessions);
			const existing = await application.runtime.readTranscriptReference({
				reference: {
					runtime: session.runtime,
					runtimeSessionId: session.runtimeSessionId,
					opaque: session.runtimeRef,
				},
				expectedCwd: session.cwd,
				kind: session.kind,
			});
			if (
				existing.length > input.dialogue.length ||
				existing.some(
					(message, index) =>
						message.role !== input.dialogue[index].role ||
						message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text ?? "")
							.join("\n") !== input.dialogue[index].content,
				)
			)
				throw new WorkbenchError("conflict", "Imported history differs from this request");
			for (const turn of input.dialogue.slice(existing.length)) {
				const timestamp = Date.parse(turn.timestamp ?? input.timestamp);
				if (turn.role === "user") manager.appendMessage({ role: "user", content: turn.content, timestamp });
				else {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: turn.content }],
						api: "openai-completions",
						provider: "halumem-corpus",
						model: "original-dialogue",
						timestamp,
						stopReason: "stop",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					manager.appendMessage(message);
				}
			}
			// Reload the public runtime handle after importing via the native session manager.
			await application.services.sessions.resume(
				session.id,
				{
					systemPrompt: "HaluMem imported dialogue",
					toolNames: [],
					toolBindings: [],
					skillPaths: [],
					appendSystemPrompt: [],
				},
				undefined,
				this.model,
			);
			const transcript = await application.services.sessions.readTranscript(session.id);
			if (!(await application.repositories.agentRuns.get(receipt.workbench_run_id))) {
				await application.repositories.agentRuns.create({
					id: receipt.workbench_run_id,
					sessionId: session.id,
					profileSlug: "standard",
					inputMessageId: transcript[0].id,
					status: "completed",
					model: this.model,
					startedAt: transcript[0].timestamp,
					settledAt: transcript.at(-1)!.timestamp,
				});
			}
			let review = receipt.review_id
				? await application.services.learning.get(receipt.review_id)
				: await application.services.learning.reviewSession(session.id);
			if (["failed", "interrupted", "cancelled"].includes(review.status))
				review = await application.services.learning.retry(review.id);
			receipt.review_id = review.id;
			await writeTextAtomically(path, JSON.stringify(receipt));
			while (
				["queued", "running"].includes(review.status) ||
				review.changes.some(
					(change) => change.status === "applying" || (change.status === "pending" && !change.autoBlockedReason),
				)
			) {
				if (review.changes.some((change) => change.error && ["pending", "applying"].includes(change.status)))
					throw new WorkbenchError(
						"external_failure",
						"Memory application did not complete; inspect the isolated review and retry",
					);
				await delay(100, undefined, { signal });
				review = await application.services.learning.get(review.id);
			}
			if (!["ready", "empty"].includes(review.status))
				throw new WorkbenchError(
					"external_failure",
					`Memory extraction did not complete: ${review.error ?? review.status}`,
				);
			const ids = new Set(
				review.changes
					.filter((change) => change.status === "applied" && change.kind === "memory")
					.flatMap((change) => change.semanticIds ?? []),
			);
			receipt.memories = (await application.services.semantic.list({ project }, true))
				.filter((memory) => ids.has(memory.id))
				.map((memory) => ({
					id: memory.id,
					memory: memory.text,
					timestamp: input.timestamp,
					version: memory.version,
				}));
			receipt.diagnostics = [
				...(review.diagnostics ?? []),
				...review.changes
					.filter((change) => change.autoBlockedReason)
					.map((change) => ({ kind: change.kind, message: change.autoBlockedReason })),
			];
			receipt.extraction_usage = review.usage;
			let times: Record<string, string> = {};
			try {
				times = JSON.parse(await readFile(join(directory, "memory-times.json"), "utf8")) as Record<string, string>;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
			for (const memory of receipt.memories) times[memory.id] = input.timestamp;
			await writeTextAtomically(join(directory, "memory-times.json"), JSON.stringify(times));
			receipt.duration_ms = Math.round(performance.now() - started);
			receipt.status = "ready";
			await writeTextAtomically(join(directory, "latest.json"), JSON.stringify({ session_id: session.id }));
			await writeTextAtomically(path, JSON.stringify(receipt));
			await application.services.sessions.close(session.id);
			return receipt;
		});
	}
	async getDialogueMemory(input: ScopeInput): Promise<Receipt> {
		if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(input.session_id))
			throw new WorkbenchError("invalid_input", "Invalid session identity");
		const directory = this.directory(input);
		const receipt = await this.receipt(join(directory, "sessions", `${input.session_id}.json`));
		if (!receipt) throw new WorkbenchError("not_found", "Dialogue has not been imported");
		if (receipt.status !== "ready")
			throw new WorkbenchError("conflict", "Dialogue extraction is still pending; retry add-dialogue");
		return receipt;
	}
	async retrieveMemory(input: RetrieveInput, external?: AbortSignal) {
		return this.exclusive(input, async () => {
			const signal = AbortSignal.any([
				this.controller.signal,
				AbortSignal.timeout(300000),
				...(external ? [external] : []),
			]);
			try {
				await readFile(join(this.directory(input), "latest.json"), "utf8");
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT")
					throw new WorkbenchError("not_found", "Import a dialogue before retrieving memories");
				throw error;
			}
			const { application, project, directory } = await this.workspace(input);
			const latest = JSON.parse(await readFile(join(directory, "latest.json"), "utf8")) as { session_id: string };
			const start = performance.now();
			const result = await application.services.retrieval.retrieve({
				sessionId: latest.session_id,
				query: input.query,
				signal,
			});
			const facts = new Map(
				(await application.services.semantic.list({ project })).map((memory) => [memory.id, memory]),
			);
			const times = JSON.parse(await readFile(join(directory, "memory-times.json"), "utf8")) as Record<
				string,
				string
			>;
			const memories: MemoryPoint[] = result.memory.fragments
				.filter((fragment) => fragment.layer === "semantic" || fragment.layer === "episodic")
				.slice(0, input.top_k)
				.map((fragment) => ({
					id: fragment.id,
					memory: facts.get(fragment.id)?.text ?? fragment.text,
					timestamp: times[fragment.id] ?? fragment.timestamp ?? "",
					version: fragment.version,
				}));
			const context = memories.map((memory) => `${memory.timestamp}: ${memory.memory}`).join("\n\n");
			const search_duration_ms = Math.round(performance.now() - start);
			let system_response: string | undefined;
			let response_duration_ms: number | undefined;
			let qa_usage: RuntimeUsage | undefined;
			if (input.generate_answer) {
				const session = await application.runtime.createSession({
					cwd: join(directory, "qa"),
					kind: "background",
					model: this.model,
					context: {
						systemPrompt: "Answer the memory question using the supplied reference data.",
						toolNames: [],
						toolBindings: [],
						skillPaths: [],
						appendSystemPrompt: [],
					},
				});
				const answerStarted = performance.now();
				try {
					const prompt = this.options.qaPrompt.replace(/\{(context|question)\}/gu, (_match, field: string) =>
						field === "context" ? context : input.query,
					);
					let complete = false;
					system_response = "";
					for await (const event of application.runtime.sendMessage(
						session.id,
						{ id: randomUUID(), text: prompt },
						{ runId: randomUUID(), signal },
					)) {
						if (event.type === "message.text.delta") system_response += event.data.delta;
						if (event.type === "message.completed" && event.data.usage) qa_usage = event.data.usage;
						if (event.type === "run.completed") complete = true;
						if (event.type === "run.failed" || event.type === "run.aborted")
							throw new WorkbenchError("external_failure", "QA model request failed");
					}
					if (!complete || !system_response.trim())
						throw new WorkbenchError("external_failure", "QA model returned no completed answer");
					response_duration_ms = Math.round(performance.now() - answerStarted);
				} finally {
					await application.runtime.deleteSessionReference({
						reference: session.reference!,
						expectedCwd: session.cwd,
						kind: "background",
					});
				}
			}
			return {
				memories,
				context,
				search_duration_ms,
				system_response,
				response_duration_ms,
				qa_usage,
				retrieval_diagnostics: result.memory.diagnostics,
				model: this.model,
			};
		});
	}
	async close(): Promise<void> {
		this.controller.abort();
		await Promise.allSettled(this.queues.values());
		for (const workspace of this.users.values()) await (await workspace).application.close();
	}
	private directory(input: { run_id: string; user_id: string }): string {
		for (const value of [input.run_id, input.user_id])
			if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value))
				throw new WorkbenchError("invalid_input", "Invalid evaluation identity");
		return join(this.options.root, input.run_id, "users", input.user_id);
	}
	private async receipt(path: string): Promise<Receipt | undefined> {
		try {
			return JSON.parse(await readFile(path, "utf8")) as Receipt;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	}
	private async exclusive<T>(input: { run_id: string; user_id: string }, operation: () => Promise<T>): Promise<T> {
		const key = this.directory(input);
		const pending = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
		this.queues.set(key, pending);
		try {
			return await pending;
		} finally {
			if (this.queues.get(key) === pending) this.queues.delete(key);
		}
	}
	private workspace(input: { run_id: string; user_id: string }): Promise<UserWorkspace> {
		const directory = this.directory(input);
		let pending = this.users.get(directory);
		if (!pending) {
			pending = this.openWorkspace(directory);
			this.users.set(directory, pending);
			void pending.catch(() => this.users.delete(directory));
		}
		return pending;
	}
	private async openWorkspace(directory: string): Promise<UserWorkspace> {
		const dataRoot = join(directory, "application");
		await mkdir(dirname(dataRoot), { recursive: true });
		const application = await (this.options.createApplication?.(dataRoot) ??
			createWorkbenchApplication({
				dataRoot,
				agentDir: this.options.agentDir,
				embeddingEnvFile: this.options.embeddingEnvFile,
			}));
		try {
			await application.services.settings.set("models.default", {
				provider: this.model.provider,
				modelId: this.model.modelId,
			});
			if (this.options.provider) {
				let catalog = await application.services.modelSettings.get();
				if (!catalog.providers.some((provider) => provider.id === this.model.provider))
					catalog = await application.services.modelSettings.importProvider(this.model.provider, catalog.version);
				await application.services.modelSettings.save(this.model.provider, {
					...this.options.provider,
					expectedVersion: catalog.version,
				});
			}
			if (
				!(await application.runtime.listModels()).some(
					(model) =>
						model.available && model.provider === this.model.provider && model.modelId === this.model.modelId,
				)
			)
				throw new WorkbenchError(
					"conflict",
					"The configured gpt-6-luna model is unavailable in the isolated evaluation workspace",
				);
			let project = (await application.services.projects.list()).find((entry) => entry.name === "HaluMem corpus");
			project ??= await application.createProject({ name: "HaluMem corpus" });
			return { application, project, directory };
		} catch (error) {
			await application.close();
			throw error;
		}
	}
}
