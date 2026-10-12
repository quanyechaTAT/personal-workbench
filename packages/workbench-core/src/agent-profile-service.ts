import { BUILTIN_ASSISTANT_PRESETS } from "./assistant-presets.ts";
import { BUILTIN_TOOL_CAPABILITIES } from "./capability-service.ts";
import {
	DEVELOPMENT_WORKFLOW,
	PREVIOUS_ACCEPTANCE_WORKFLOW,
	PREVIOUS_DEVELOPMENT_WORKFLOW,
} from "./development-workflow.ts";
import { WorkbenchError } from "./errors.ts";
import type { AgentProfile, AssistantMcpToolBinding } from "./models.ts";
import type {
	AgentProfileRepository,
	McpConnectionRepository,
	SettingsRepository,
	SkillRepository,
} from "./repositories.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";

const BUILTIN_TOOLS = new Set(BUILTIN_TOOL_CAPABILITIES.map((tool) => tool.id));

export interface SaveAgentProfileInput {
	name: string;
	description?: string;
	systemPrompt: string;
	defaultModel?: { provider: string; modelId: string };
	tools?: string[];
	skillIds?: string[];
	mcpBindings?: AssistantMcpToolBinding[];
}

export class AgentProfileService {
	private readonly repository: AgentProfileRepository;
	private readonly skills: SkillRepository;
	private readonly connections: McpConnectionRepository;
	private readonly system: SystemServices;
	private readonly settings?: SettingsRepository;
	private readonly modelAvailable?: (model: NonNullable<AgentProfile["defaultModel"]>) => Promise<boolean>;

	constructor(
		repository: AgentProfileRepository,
		skills: SkillRepository,
		connections: McpConnectionRepository,
		system: SystemServices = defaultSystemServices,
		settings?: SettingsRepository,
		modelAvailable?: (model: NonNullable<AgentProfile["defaultModel"]>) => Promise<boolean>,
	) {
		this.repository = repository;
		this.skills = skills;
		this.connections = connections;
		this.system = system;
		this.settings = settings;
		this.modelAvailable = modelAvailable;
	}

	async ensureBuiltins(): Promise<AgentProfile[]> {
		const availableSkills = await this.skills.list({ scope: "global" });
		for (const profile of await this.repository.list()) {
			if (!(await this.repository.getRevision(profile.id, profile.version))) {
				await this.repository.upsert(profile, profile.version);
			}
		}
		const profiles: AgentProfile[] = [];
		for (const definition of BUILTIN_ASSISTANT_PRESETS) {
			const existing = await this.repository.getBySlug(definition.slug);
			if (existing?.isBuiltin) {
				const previousPrompt = !existing.systemPrompt.includes(DEVELOPMENT_WORKFLOW)
					? [PREVIOUS_ACCEPTANCE_WORKFLOW, PREVIOUS_DEVELOPMENT_WORKFLOW].find((prompt) =>
							existing.systemPrompt.includes(prompt),
						)
					: undefined;
				const previousTools = [
					definition.tools.filter((tool) => !["learning_context", "skill_manage"].includes(tool)),
					definition.tools.filter((tool) => tool !== "accept_changes"),
					definition.tools.filter(
						(tool) => !["exec_command", "write_stdin", "close_terminal", "accept_changes"].includes(tool),
					),
					definition.tools.filter(
						(tool) =>
							![
								"exec_command",
								"write_stdin",
								"close_terminal",
								"browser_use",
								"computer_use",
								"accept_changes",
							].includes(tool),
					),
				];
				const upgradeTools = previousTools.some(
					(tools) =>
						existing.tools.length === tools.length && tools.every((tool) => existing.tools.includes(tool)),
				);
				if (!existing.deletedAt && definition.slug !== "minimal" && (Boolean(previousPrompt) || upgradeTools)) {
					const upgraded = await this.repository.upsert(
						{
							...existing,
							tools: upgradeTools ? [...definition.tools] : existing.tools,
							systemPrompt: previousPrompt
								? existing.systemPrompt.replace(previousPrompt, DEVELOPMENT_WORKFLOW)
								: existing.systemPrompt,
							version: existing.version + 1,
							updatedAt: toTimestamp(this.system.now()),
						},
						existing.version,
					);
					if (!upgraded) throw new WorkbenchError("conflict", "Assistant changed during tool upgrade");
					profiles.push(upgraded);
				} else profiles.push(existing);
				continue;
			}
			if (existing) {
				const relocated = await this.repository.upsert(
					{
						...existing,
						slug: await this.availableSlug(existing.slug, existing.id),
						version: existing.version + 1,
						updatedAt: toTimestamp(this.system.now()),
					},
					existing.version,
				);
				if (!relocated) throw new WorkbenchError("conflict", `Could not preserve assistant ${existing.id}`);
			}
			const previous = definition.legacySlug ? await this.repository.getBySlug(definition.legacySlug) : undefined;
			const replaced = previous?.isBuiltin ? previous : undefined;
			const now = toTimestamp(this.system.now());
			const created = await this.repository.upsert(
				{
					id: replaced?.id ?? this.system.id(),
					slug: definition.slug,
					name: definition.name,
					description: definition.description,
					systemPrompt: definition.systemPrompt,
					defaultModel: replaced?.defaultModel,
					tools: [...definition.tools],
					skillIds: availableSkills
						.filter((skill) => (definition.skillSlugs as readonly string[]).includes(skill.slug))
						.map((skill) => skill.id),
					mcpBindings: [],
					status: "active",
					version: (replaced?.version ?? 0) + 1,
					isBuiltin: true,
					createdAt: replaced?.createdAt ?? now,
					updatedAt: now,
				},
				replaced?.version,
			);
			if (!created) throw new WorkbenchError("conflict", `Could not create built-in assistant ${definition.slug}`);
			profiles.push(created);
		}
		const oldDefault = await this.settings?.get("agent.defaultMode");
		const migratedDefault = BUILTIN_ASSISTANT_PRESETS.find(
			(definition) => definition.legacySlug === oldDefault?.value,
		);
		if (oldDefault && migratedDefault)
			await this.settings?.set(
				{
					...oldDefault,
					value: migratedDefault.slug,
					version: oldDefault.version + 1,
					updatedAt: toTimestamp(this.system.now()),
				},
				oldDefault.version,
			);
		return profiles;
	}

	async create(input: SaveAgentProfileInput): Promise<AgentProfile> {
		await this.validate(input);
		const now = toTimestamp(this.system.now());
		const id = this.system.id();
		const profile: AgentProfile = {
			id,
			slug: await this.availableSlug(input.name, id),
			name: input.name.trim(),
			description: input.description?.trim() ?? "",
			systemPrompt: input.systemPrompt.trim(),
			defaultModel: input.defaultModel,
			tools: unique(input.tools ?? []),
			skillIds: unique(input.skillIds ?? []),
			mcpBindings: uniqueMcp(input.mcpBindings ?? []),
			status: "active",
			version: 1,
			isBuiltin: false,
			createdAt: now,
			updatedAt: now,
		};
		const created = await this.repository.upsert(profile);
		if (!created) throw new WorkbenchError("conflict", "Assistant could not be created");
		return created;
	}

	async update(id: string, input: SaveAgentProfileInput, expectedVersion: number): Promise<AgentProfile> {
		await this.validate(input);
		const existing = await this.get(id);
		if (existing.version !== expectedVersion)
			throw new WorkbenchError("conflict", "Assistant changed since it was loaded");
		const next: AgentProfile = {
			...existing,
			name: input.name.trim(),
			description: input.description?.trim() ?? "",
			systemPrompt: input.systemPrompt.trim(),
			defaultModel: input.defaultModel,
			tools: unique(input.tools ?? []),
			skillIds: unique(input.skillIds ?? []),
			mcpBindings: uniqueMcp(input.mcpBindings ?? []),
			version: existing.version + 1,
			bindingDiagnostics: [],
			updatedAt: toTimestamp(this.system.now()),
		};
		const saved = await this.repository.upsert(next, expectedVersion);
		if (!saved) throw new WorkbenchError("conflict", "Assistant changed since it was loaded");
		return saved;
	}

	async clone(id: string, name?: string): Promise<AgentProfile> {
		const source = await this.get(id);
		return this.create({
			name: name?.trim() || `${source.name} Copy`,
			description: source.description,
			systemPrompt: source.systemPrompt,
			defaultModel: source.defaultModel,
			tools: source.tools,
			skillIds: source.skillIds,
			mcpBindings: source.mcpBindings,
		});
	}

	async archive(id: string, expectedVersion: number): Promise<AgentProfile> {
		const saved = await this.setStatus(id, "archived", expectedVersion);
		await this.clearDefault(id);
		return saved;
	}

	async delete(id: string, expectedVersion: number): Promise<void> {
		const existing = await this.get(id);
		if (existing.version !== expectedVersion)
			throw new WorkbenchError("conflict", "Assistant changed since it was loaded");
		const now = toTimestamp(this.system.now());
		const saved = await this.repository.upsert(
			{ ...existing, status: "archived", deletedAt: now, version: existing.version + 1, updatedAt: now },
			expectedVersion,
		);
		if (!saved) throw new WorkbenchError("conflict", "Assistant changed since it was loaded");
		await this.clearDefault(id);
	}

	private async clearDefault(id: string): Promise<void> {
		const current = await this.settings?.get("agent.defaultProfileId");
		if (current?.value === id)
			await this.settings?.set(
				{ ...current, value: null, version: current.version + 1, updatedAt: toTimestamp(this.system.now()) },
				current.version,
			);
	}

	async setDefault(id: string): Promise<void> {
		const profile = await this.get(id);
		if (profile.status !== "active") throw new WorkbenchError("conflict", "The default assistant must be active");
		if (!this.settings) throw new WorkbenchError("conflict", "Assistant settings are unavailable");
		const current = await this.settings.get("agent.defaultProfileId");
		const saved = await this.settings.set(
			{
				key: "agent.defaultProfileId",
				value: id,
				version: (current?.version ?? 0) + 1,
				updatedAt: toTimestamp(this.system.now()),
			},
			current?.version,
		);
		if (!saved) throw new WorkbenchError("conflict", "Default assistant changed concurrently");
	}

	restore(id: string, expectedVersion: number): Promise<AgentProfile> {
		return this.setStatus(id, "active", expectedVersion);
	}

	async get(id: string): Promise<AgentProfile> {
		const profile = await this.repository.get(id);
		if (!profile || profile.deletedAt) throw new WorkbenchError("not_found", `Assistant not found: ${id}`);
		return profile;
	}

	async getBySlug(slug: string): Promise<AgentProfile> {
		const profile = await this.repository.getBySlug(slug);
		if (!profile || profile.deletedAt) throw new WorkbenchError("not_found", `Assistant not found: ${slug}`);
		return profile;
	}

	list(includeArchived = false): Promise<AgentProfile[]> {
		return this.repository.list(includeArchived ? undefined : { status: "active" });
	}

	async getRevision(id: string, version: number) {
		const revision = await this.repository.getRevision(id, version);
		if (!revision) throw new WorkbenchError("not_found", `Assistant revision not found: ${id}@${version}`);
		return revision;
	}

	private async setStatus(id: string, status: AgentProfile["status"], expectedVersion: number): Promise<AgentProfile> {
		const existing = await this.get(id);
		if (existing.version !== expectedVersion)
			throw new WorkbenchError("conflict", "Assistant changed since it was loaded");
		const next = {
			...existing,
			status,
			version: existing.version + 1,
			updatedAt: toTimestamp(this.system.now()),
		};
		const saved = await this.repository.upsert(next, expectedVersion);
		if (!saved) throw new WorkbenchError("conflict", "Assistant changed since it was loaded");
		return saved;
	}

	private async validate(input: SaveAgentProfileInput): Promise<void> {
		if (input.defaultModel && this.modelAvailable && !(await this.modelAvailable(input.defaultModel)))
			throw new WorkbenchError("invalid_input", "The selected assistant model is not available or authenticated");
		if (!input.name.trim()) throw new WorkbenchError("invalid_input", "Assistant name is required");
		if (!input.systemPrompt.trim()) throw new WorkbenchError("invalid_input", "Assistant instructions are required");
		const unknownTool = (input.tools ?? []).find((tool) => !BUILTIN_TOOLS.has(tool));
		if (unknownTool) throw new WorkbenchError("invalid_input", `Unknown built-in tool: ${unknownTool}`);
		for (const skillId of unique(input.skillIds ?? [])) {
			if (!(await this.skills.get(skillId)))
				throw new WorkbenchError("invalid_input", `Skill not found: ${skillId}`);
		}
		for (const binding of uniqueMcp(input.mcpBindings ?? [])) {
			const connection = await this.connections.get(binding.connectionId);
			if (!connection)
				throw new WorkbenchError("invalid_input", `MCP connection not found: ${binding.connectionId}`);
			const tool = (await this.connections.listTools(binding.connectionId)).find(
				(candidate) => candidate.name === binding.toolName,
			);
			if (!tool) throw new WorkbenchError("invalid_input", `MCP tool not found: ${binding.toolName}`);
			if (tool.diagnostic) throw new WorkbenchError("invalid_input", `MCP tool unavailable: ${tool.diagnostic}`);
			if (tool.definitionHash !== binding.approvedDefinitionHash) {
				throw new WorkbenchError("conflict", `MCP tool definition changed: ${binding.toolName}`);
			}
		}
	}

	private async availableSlug(name: string, id: string): Promise<string> {
		const base =
			name
				.trim()
				.toLowerCase()
				.normalize("NFKD")
				.replace(/[^a-z0-9]+/gu, "-")
				.replace(/^-+|-+$/gu, "") || `assistant-${id.slice(0, 8)}`;
		let slug = base;
		let suffix = 2;
		while (await this.repository.getBySlug(slug)) slug = `${base}-${suffix++}`;
		return slug;
	}
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueMcp(values: AssistantMcpToolBinding[]): AssistantMcpToolBinding[] {
	const result = new Map<string, AssistantMcpToolBinding>();
	for (const value of values) result.set(`${value.connectionId}\0${value.toolName}`, value);
	return [...result.values()];
}
