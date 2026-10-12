import type { AgentRuntime, RuntimeModelRef } from "@earendil-works/workbench-runtime";
import { Parse } from "typebox/value";
import type { AgentProfileService } from "./agent-profile-service.ts";
import type { CapabilityService } from "./capability-service.ts";
import { SaveAgentProfileSchema } from "./contracts/profiles.ts";
import { WorkbenchError } from "./errors.ts";
import type { AssistantDraft, AssistantDraftConfig } from "./models.ts";
import type { AssistantDraftRepository } from "./repositories.ts";
import type { CoordinatedRunHandle, RunCoordinator } from "./run-coordinator.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";

export type AssistantDraftEvent =
	| { sequence: number; type: "draft.started"; data: { queued: boolean } }
	| { sequence: number; type: "draft.delta"; data: { delta: string } }
	| { sequence: number; type: "draft.ready"; data: { draft: AssistantDraft } }
	| { sequence: number; type: "draft.failed"; data: { message: string } }
	| { sequence: number; type: "draft.cancelled"; data: Record<string, never> };

interface DraftStream {
	events: AssistantDraftEvent[];
	nextSequence: number;
	completed: boolean;
	waiters: Set<() => void>;
}

interface ActiveDraft {
	handle: CoordinatedRunHandle;
	runtimeSessionId?: string;
}

export class AssistantDraftService {
	private readonly repository: AssistantDraftRepository;
	private readonly profiles: AgentProfileService;
	private readonly capabilities: CapabilityService;
	private readonly runtime: AgentRuntime;
	private readonly coordinator: RunCoordinator;
	private readonly cwd: string;
	private readonly resolveDefaultModel: () => Promise<RuntimeModelRef>;
	private readonly system: SystemServices;
	private readonly streams = new Map<string, DraftStream>();
	private readonly active = new Map<string, ActiveDraft>();
	private readonly creating = new Set<string>();

	constructor(options: {
		repository: AssistantDraftRepository;
		profiles: AgentProfileService;
		capabilities: CapabilityService;
		runtime: AgentRuntime;
		coordinator: RunCoordinator;
		cwd: string;
		resolveDefaultModel(): Promise<RuntimeModelRef>;
		system?: SystemServices;
	}) {
		this.repository = options.repository;
		this.profiles = options.profiles;
		this.capabilities = options.capabilities;
		this.runtime = options.runtime;
		this.coordinator = options.coordinator;
		this.cwd = options.cwd;
		this.resolveDefaultModel = options.resolveDefaultModel;
		this.system = options.system ?? defaultSystemServices;
	}

	async initializeRecovery(): Promise<void> {
		for (const draft of await this.repository.list("generating")) {
			await this.repository.update(
				{
					...draft,
					status: "failed",
					errorMessage: "Draft generation was interrupted by restart",
					version: draft.version + 1,
					updatedAt: toTimestamp(this.system.now()),
				},
				draft.version,
			);
		}
	}

	async start(requirement: string, model?: RuntimeModelRef): Promise<{ draft: AssistantDraft; queued: boolean }> {
		if (!requirement.trim()) throw new WorkbenchError("invalid_input", "Assistant requirement is required");
		const now = toTimestamp(this.system.now());
		const draft = await this.repository.create({
			id: this.system.id(),
			requirement: requirement.trim(),
			status: "generating",
			model,
			version: 1,
			createdAt: now,
			updatedAt: now,
		});
		const stream = this.stream(draft.id);
		const handle = this.coordinator.submit(
			`assistant-draft:${draft.id}`,
			(signal) => this.generate(draft.id, signal),
			{ queueIfBusy: true, resourceKey: `draft:${draft.id}` },
		);
		this.active.set(draft.id, { handle });
		this.publish(stream, "draft.started", { queued: handle.queued });
		void handle.completion.catch(() => undefined);
		return { draft, queued: handle.queued };
	}

	async saveEdits(id: string, input: AssistantDraftConfig, expectedVersion: number): Promise<AssistantDraft> {
		const draft = await this.get(id);
		if (draft.version !== expectedVersion)
			throw new WorkbenchError("conflict", "Assistant draft changed since it was loaded");
		if (draft.status === "generating" || draft.status === "created" || this.creating.has(id))
			throw new WorkbenchError("conflict", "This draft cannot be edited in its current state");
		const config = await this.validate(input);
		const saved = await this.repository.update(
			{
				...draft,
				config,
				status: "ready",
				errorMessage: undefined,
				version: draft.version + 1,
				updatedAt: toTimestamp(this.system.now()),
			},
			expectedVersion,
		);
		if (!saved) throw new WorkbenchError("conflict", "Assistant draft changed since it was loaded");
		return saved;
	}

	async createProfile(id: string): Promise<AssistantDraft> {
		if (this.creating.has(id)) throw new WorkbenchError("conflict", "This draft is already being saved");
		this.creating.add(id);
		try {
			const draft = await this.get(id);
			if (draft.status === "created") return draft;
			if (draft.status !== "ready" || !draft.config)
				throw new WorkbenchError("conflict", "Assistant draft is not ready");
			const profile = await this.profiles.create(draft.config);
			const saved = await this.repository.update(
				{
					...draft,
					status: "created",
					createdProfileId: profile.id,
					version: draft.version + 1,
					updatedAt: toTimestamp(this.system.now()),
				},
				draft.version,
			);
			if (!saved) throw new WorkbenchError("conflict", "Assistant draft changed since it was loaded");
			return saved;
		} finally {
			this.creating.delete(id);
		}
	}

	async cancel(id: string): Promise<AssistantDraft> {
		const draft = await this.get(id);
		if (draft.status !== "generating") return draft;
		const active = this.active.get(id);
		if (active?.handle.cancel()) {
			this.active.delete(id);
			return this.markCancelled(draft);
		}
		active?.handle.abort();
		await active?.handle.completion;
		return this.get(id);
	}

	async get(id: string): Promise<AssistantDraft> {
		const draft = await this.repository.get(id);
		if (!draft) throw new WorkbenchError("not_found", `Assistant draft not found: ${id}`);
		return draft;
	}

	async *subscribe(id: string, after = 0): AsyncIterable<AssistantDraftEvent> {
		const draft = await this.get(id);
		const stream = this.stream(id);
		if (!this.active.has(id) && draft.status !== "generating") {
			if (stream.events.length === 0) {
				if (draft.status === "ready" || draft.status === "created") this.publish(stream, "draft.ready", { draft });
				else if (draft.status === "cancelled") this.publish(stream, "draft.cancelled", {});
				else this.publish(stream, "draft.failed", { message: draft.errorMessage ?? "Draft generation failed" });
			}
			stream.completed = true;
		}
		let cursor = Math.max(0, Math.trunc(after));
		while (true) {
			for (const event of stream.events) {
				if (event.sequence <= cursor) continue;
				yield event;
				cursor = event.sequence;
			}
			if (stream.completed) return;
			await new Promise<void>((resolve) => stream.waiters.add(resolve));
		}
	}

	private async generate(id: string, signal: AbortSignal): Promise<void> {
		let draft = await this.get(id);
		const stream = this.stream(id);
		let runtimeSessionId: string | undefined;
		try {
			const model = draft.model ?? (await this.resolveDefaultModel());
			const catalog = await this.capabilities.getCatalog();
			const session = await this.runtime.createSession({
				cwd: this.cwd,
				kind: "background",
				model,
				context: {
					systemPrompt:
						"Create a Personal Workbench assistant configuration. Return only one JSON object matching the requested fields. Do not claim capabilities that are absent from the supplied catalog.",
					toolNames: [],
					skillPaths: [],
				},
			});
			runtimeSessionId = session.id;
			const active = this.active.get(id);
			if (active) active.runtimeSessionId = session.id;
			const prompt = draftPrompt(draft.requirement, model, catalog);
			let raw = await this.generateText(session.id, prompt, stream, signal);
			let config: AssistantDraftConfig;
			try {
				config = await this.validate(parseDraft(raw));
			} catch (firstError) {
				raw = await this.generateText(
					session.id,
					`Your previous JSON was invalid: ${firstError instanceof Error ? firstError.message : String(firstError)}\nReturn one corrected JSON object only.`,
					stream,
					signal,
				);
				config = await this.validate(parseDraft(raw));
			}
			draft = await this.get(id);
			if (draft.status !== "generating") return;
			const saved = await this.repository.update(
				{
					...draft,
					status: "ready",
					config,
					model,
					errorMessage: undefined,
					version: draft.version + 1,
					updatedAt: toTimestamp(this.system.now()),
				},
				draft.version,
			);
			if (!saved) throw new WorkbenchError("conflict", "Assistant draft changed during generation");
			this.publish(stream, "draft.ready", { draft: saved });
		} catch (error) {
			draft = await this.get(id);
			if (draft.status === "cancelled") return;
			if (signal.aborted) {
				await this.markCancelled(draft);
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			const failed = await this.repository.update(
				{
					...draft,
					status: "failed",
					errorMessage: message,
					version: draft.version + 1,
					updatedAt: toTimestamp(this.system.now()),
				},
				draft.version,
			);
			if (failed) this.publish(stream, "draft.failed", { message });
		} finally {
			if (runtimeSessionId) await this.runtime.releaseSession(runtimeSessionId).catch(() => undefined);
			this.active.delete(id);
			stream.completed = true;
			this.wake(stream);
		}
	}

	private async generateText(
		runtimeSessionId: string,
		prompt: string,
		stream: DraftStream,
		signal: AbortSignal,
	): Promise<string> {
		let text = "";
		signal.throwIfAborted();
		let failure: string | undefined;
		for await (const event of this.runtime.sendMessage(
			runtimeSessionId,
			{ id: this.system.id(), text: prompt },
			{ runId: this.system.id(), signal },
		)) {
			if (signal.aborted) throw new WorkbenchError("conflict", "Assistant draft generation was cancelled");
			if (event.type === "message.text.delta") {
				text += event.data.delta;
				this.publish(stream, "draft.delta", { delta: event.data.delta });
			} else if (event.type === "run.failed") failure = event.data.message;
			else if (event.type === "run.aborted")
				throw new WorkbenchError("conflict", "Assistant draft generation was cancelled");
		}
		if (failure) throw new WorkbenchError("conflict", failure);
		if (!text.trim()) throw new WorkbenchError("invalid_input", "Model returned an empty assistant draft");
		return text;
	}

	private async validate(value: unknown): Promise<AssistantDraftConfig> {
		const parsed = Parse(SaveAgentProfileSchema, value);
		const config: AssistantDraftConfig = {
			name: parsed.name.trim(),
			description: parsed.description?.trim() ?? "",
			systemPrompt: parsed.systemPrompt.trim(),
			defaultModel: parsed.defaultModel,
			tools: parsed.tools ?? [],
			skillIds: parsed.skillIds ?? [],
			mcpBindings: parsed.mcpBindings ?? [],
		};
		const resolved = await this.capabilities.resolveForSession({
			id: "draft",
			slug: "draft",
			...config,
			status: "active",
			version: 1,
			isBuiltin: false,
			createdAt: "",
			updatedAt: "",
		});
		this.capabilities.assertUsable(resolved);
		return config;
	}

	private async markCancelled(draft: AssistantDraft): Promise<AssistantDraft> {
		const saved = await this.repository.update(
			{
				...draft,
				status: "cancelled",
				version: draft.version + 1,
				updatedAt: toTimestamp(this.system.now()),
			},
			draft.version,
		);
		if (!saved) return this.get(draft.id);
		const stream = this.stream(draft.id);
		this.publish(stream, "draft.cancelled", {});
		stream.completed = true;
		this.wake(stream);
		return saved;
	}

	private stream(id: string): DraftStream {
		let stream = this.streams.get(id);
		if (!stream) {
			stream = { events: [], nextSequence: 1, completed: false, waiters: new Set() };
			this.streams.set(id, stream);
		}
		return stream;
	}

	private publish<T extends AssistantDraftEvent["type"]>(
		stream: DraftStream,
		type: T,
		data: Extract<AssistantDraftEvent, { type: T }>["data"],
	): void {
		stream.events.push({ sequence: stream.nextSequence++, type, data } as AssistantDraftEvent);
		if (stream.events.length > 500) stream.events.splice(0, stream.events.length - 500);
		this.wake(stream);
	}

	private wake(stream: DraftStream): void {
		for (const waiter of stream.waiters) waiter();
		stream.waiters.clear();
	}
}

function parseDraft(raw: string): unknown {
	const trimmed = raw.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)?.[1];
	const source = fenced ?? trimmed;
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new WorkbenchError("invalid_input", `Model output is not valid JSON: ${String(error)}`);
	}
	return value;
}

function draftPrompt(
	requirement: string,
	model: RuntimeModelRef,
	catalog: Awaited<ReturnType<CapabilityService["getCatalog"]>>,
): string {
	const capabilityCatalog = {
		builtinTools: catalog.builtinTools.map((tool) => ({ id: tool.id, description: tool.description })),
		skills: catalog.skills
			.filter(
				(skill) =>
					skill.enabled &&
					!skill.diagnostics.some((value) => value.startsWith("error:") || value.startsWith("collision:")),
			)
			.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description })),
		mcpTools: catalog.connections
			.filter((entry) => entry.connection.enabled)
			.flatMap((entry) =>
				entry.tools
					.filter((tool) => !tool.diagnostic)
					.map((tool) => ({
						connectionId: entry.connection.id,
						connectionName: entry.connection.name,
						toolName: tool.name,
						description: tool.description,
						approvedDefinitionHash: tool.definitionHash,
						approval: "ask",
					})),
			),
	};
	return [
		"User requirement:",
		requirement,
		"",
		`Selected model: ${model.provider}/${model.modelId}`,
		"Available capability catalog:",
		JSON.stringify(capabilityCatalog, null, 2),
		"",
		"Return exactly this JSON shape:",
		'{"name":"...","description":"...","systemPrompt":"...","defaultModel":{"provider":"...","modelId":"..."},"tools":[],"skillIds":[],"mcpBindings":[]}',
	].join("\n");
}
