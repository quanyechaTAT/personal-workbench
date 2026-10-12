import type {
	AgentProfile,
	AgentProfileRepository,
	AgentProfileRevision,
	AssistantMcpToolBinding,
} from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface ProfileRow {
	deleted_at: string | null;
	id: string;
	slug: string;
	name: string;
	description: string;
	system_prompt: string;
	default_model_json: string | null;
	tools_json: string;
	skills_json: string;
	binding_diagnostics_json: string;
	is_builtin: number;
	status: AgentProfile["status"];
	version: number;
	created_at: string;
	updated_at: string;
}

interface SkillBindingRow {
	skill_id: string;
}

interface McpBindingRow {
	connection_id: string;
	tool_name: string;
	definition_hash: string;
	approval: AssistantMcpToolBinding["approval"];
}

interface RevisionRow {
	profile_id: string;
	version: number;
	config_json: string;
	created_at: string;
}

function modelFromJson(json: string | null): AgentProfile["defaultModel"] {
	if (!json) return undefined;
	const value: unknown = JSON.parse(json);
	if (
		typeof value === "object" &&
		value !== null &&
		"provider" in value &&
		typeof value.provider === "string" &&
		"modelId" in value &&
		typeof value.modelId === "string"
	) {
		return { provider: value.provider, modelId: value.modelId };
	}
	return undefined;
}

function stringArray(json: string): string[] {
	const value: unknown = JSON.parse(json);
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

export class SqliteAgentProfileRepository implements AgentProfileRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async upsert(profile: AgentProfile, expectedVersion?: number): Promise<AgentProfile | undefined> {
		return this.database.transaction(() => {
			const existing = this.database.prepare("SELECT version FROM agent_profiles WHERE id = ?").get(profile.id) as
				| { version: number }
				| undefined;
			if (expectedVersion !== undefined && existing?.version !== expectedVersion) return undefined;
			if (existing) {
				const result = this.database
					.prepare(
						`UPDATE agent_profiles SET
              slug = ?, name = ?, description = ?, system_prompt = ?, default_model_json = ?,
              tools_json = ?, skills_json = ?, is_builtin = ?, status = ?, version = ?, updated_at = ?
            WHERE id = ? AND version = ?`,
					)
					.run(
						profile.slug,
						profile.name,
						profile.description,
						profile.systemPrompt,
						profile.defaultModel ? JSON.stringify(profile.defaultModel) : null,
						JSON.stringify(profile.tools),
						JSON.stringify(profile.skillIds),
						profile.isBuiltin ? 1 : 0,
						profile.status,
						profile.version,
						profile.updatedAt,
						profile.id,
						existing.version,
					);
				if (result.changes !== 1) return undefined;
			} else {
				this.database
					.prepare(
						`INSERT INTO agent_profiles(
              id, slug, name, description, system_prompt, default_model_json, tools_json, skills_json,
              is_builtin, created_at, updated_at, status, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						profile.id,
						profile.slug,
						profile.name,
						profile.description,
						profile.systemPrompt,
						profile.defaultModel ? JSON.stringify(profile.defaultModel) : null,
						JSON.stringify(profile.tools),
						JSON.stringify(profile.skillIds),
						profile.isBuiltin ? 1 : 0,
						profile.createdAt,
						profile.updatedAt,
						profile.status,
						profile.version,
					);
			}
			this.replaceBindings(profile);
			this.database
				.prepare("UPDATE agent_profiles SET binding_diagnostics_json = ?, deleted_at = ? WHERE id = ?")
				.run(JSON.stringify(profile.bindingDiagnostics ?? []), profile.deletedAt ?? null, profile.id);
			this.database
				.prepare(
					`INSERT OR REPLACE INTO agent_profile_revisions(profile_id, version, config_json, created_at)
           VALUES (?, ?, ?, ?)`,
				)
				.run(profile.id, profile.version, JSON.stringify(profile), profile.updatedAt);
			return profile;
		});
	}

	async get(id: string): Promise<AgentProfile | undefined> {
		const row = this.database.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as ProfileRow | undefined;
		return row ? this.mapProfile(row) : undefined;
	}

	async getBySlug(slug: string): Promise<AgentProfile | undefined> {
		const row = this.database.prepare("SELECT * FROM agent_profiles WHERE slug = ?").get(slug) as
			| ProfileRow
			| undefined;
		return row ? this.mapProfile(row) : undefined;
	}

	async list(filter?: { status?: AgentProfile["status"] }): Promise<AgentProfile[]> {
		const rows = (filter?.status
			? this.database
					.prepare("SELECT * FROM agent_profiles WHERE deleted_at IS NULL AND status = ? ORDER BY name")
					.all(filter.status)
			: this.database
					.prepare("SELECT * FROM agent_profiles WHERE deleted_at IS NULL ORDER BY status, name")
					.all()) as unknown as ProfileRow[];
		return rows.map((row) => this.mapProfile(row));
	}

	async getRevision(id: string, version: number): Promise<AgentProfileRevision | undefined> {
		const row = this.database
			.prepare("SELECT * FROM agent_profile_revisions WHERE profile_id = ? AND version = ?")
			.get(id, version) as RevisionRow | undefined;
		if (!row) return undefined;
		return {
			profileId: row.profile_id,
			version: row.version,
			config: JSON.parse(row.config_json) as AgentProfile,
			createdAt: row.created_at,
		};
	}

	private mapProfile(row: ProfileRow): AgentProfile {
		const skillRows = this.database
			.prepare("SELECT skill_id FROM agent_profile_skills WHERE profile_id = ? ORDER BY skill_id")
			.all(row.id) as unknown as SkillBindingRow[];
		const mcpRows = this.database
			.prepare(
				`SELECT connection_id, tool_name, definition_hash, approval
         FROM agent_profile_mcp_tools WHERE profile_id = ? ORDER BY connection_id, tool_name`,
			)
			.all(row.id) as unknown as McpBindingRow[];
		const revision = this.database
			.prepare("SELECT 1 FROM agent_profile_revisions WHERE profile_id = ? LIMIT 1")
			.get(row.id);
		const legacySkillSlugs = !revision && skillRows.length === 0 ? stringArray(row.skills_json) : [];
		const legacySkillIds: string[] = [];
		const bindingDiagnostics = stringArray(row.binding_diagnostics_json);
		for (const slug of legacySkillSlugs) {
			const matches = this.database.prepare("SELECT id FROM skills WHERE slug = ?").all(slug) as unknown as Array<{
				id: string;
			}>;
			if (matches.length === 1) legacySkillIds.push(matches[0].id);
			else
				bindingDiagnostics.push(
					`Legacy Skill '${slug}' has ${matches.length} matches. Select the intended Skill and save this assistant.`,
				);
		}
		return {
			id: row.id,
			deletedAt: row.deleted_at ?? undefined,
			slug: row.slug,
			name: row.name,
			description: row.description,
			systemPrompt: row.system_prompt,
			defaultModel: modelFromJson(row.default_model_json),
			tools: stringArray(row.tools_json),
			skillIds: skillRows.length > 0 ? skillRows.map((value) => value.skill_id) : legacySkillIds,
			bindingDiagnostics,
			mcpBindings: mcpRows.map((value) => ({
				connectionId: value.connection_id,
				toolName: value.tool_name,
				approvedDefinitionHash: value.definition_hash,
				approval: value.approval,
			})),
			isBuiltin: row.is_builtin === 1,
			status: row.status,
			version: row.version,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private replaceBindings(profile: AgentProfile): void {
		this.database.prepare("DELETE FROM agent_profile_skills WHERE profile_id = ?").run(profile.id);
		const insertSkill = this.database.prepare("INSERT INTO agent_profile_skills(profile_id, skill_id) VALUES (?, ?)");
		for (const skillId of profile.skillIds) insertSkill.run(profile.id, skillId);
		this.database.prepare("DELETE FROM agent_profile_mcp_tools WHERE profile_id = ?").run(profile.id);
		const insertMcp = this.database.prepare(
			`INSERT INTO agent_profile_mcp_tools(
         profile_id, connection_id, tool_name, definition_hash, approval
       ) VALUES (?, ?, ?, ?, ?)`,
		);
		for (const binding of profile.mcpBindings) {
			insertMcp.run(
				profile.id,
				binding.connectionId,
				binding.toolName,
				binding.approvedDefinitionHash,
				binding.approval,
			);
		}
	}
}
