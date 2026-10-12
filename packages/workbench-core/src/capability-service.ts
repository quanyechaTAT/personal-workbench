import { createHash } from "node:crypto";
import type { RuntimeToolBinding } from "@earendil-works/workbench-runtime";
import { isMinimalAssistant } from "./assistant-presets.ts";
import { WorkbenchError } from "./errors.ts";
import type { AgentProfile, McpConnection, McpToolRecord, Project, WorkbenchSkill } from "./models.ts";
import type { McpConnectionRepository, SkillRepository } from "./repositories.ts";

export interface BuiltinToolCapability {
	id: string;
	label: string;
	description: string;
}

export const BUILTIN_TOOL_CAPABILITIES: readonly BuiltinToolCapability[] = [
	{
		id: "browser_use",
		label: "浏览器操作",
		description: "操作独立浏览器会话：页面快照、截图、点击、输入和标签页管理。",
	},
	{ id: "computer_use", label: "桌面操作", description: "按会话权限操作 Windows 窗口、鼠标、键盘并返回屏幕截图。" },
	{ id: "web_search", label: "联网搜索", description: "使用 DeepSeek 原生搜索查询互联网并返回来源链接。" },
	{ id: "knowledge_search", label: "项目知识检索", description: "检索当前项目已建立的文档向量索引。" },
	{ id: "read", label: "Read files", description: "Read text and image files in the allowed workspace." },
	{ id: "write", label: "Write files", description: "Create or replace files in the allowed workspace." },
	{ id: "edit", label: "Edit files", description: "Apply focused edits to text files." },
	{ id: "find", label: "Find files", description: "Find files by name or path pattern." },
	{ id: "grep", label: "Search text", description: "Search file contents." },
	{ id: "ls", label: "List directories", description: "Inspect directory contents." },
	{ id: "powershell", label: "PowerShell", description: "Run a PowerShell command after approval." },
	{
		id: "exec_command",
		label: "启动终端命令",
		description: "在真实终端执行命令，快速返回会话 ID，支持长期服务和交互程序。",
	},
	{ id: "write_stdin", label: "续读与输入终端", description: "读取终端增量输出，或按会话权限发送输入和 Ctrl+C。" },
	{ id: "close_terminal", label: "关闭终端", description: "关闭当前对话的终端及其子进程。" },
	{
		id: "persistent_shell",
		label: "持久终端",
		description: "通过持久 PowerShell 终端执行命令，保留变量与工作目录；遵守会话权限。",
	},
	{
		id: "run_code",
		label: "程序调用工具",
		description: "用 TypeScript 程序组织所选工具的调用，并筛选或合并返回结果。",
	},
	{ id: "assistant_catalog", label: "助手能力目录", description: "查看现有助手以及可绑定的工具、技能与 MCP 能力。" },
	{ id: "assistant_inspect", label: "检查助手", description: "读取助手配置与版本，并检查工具和技能绑定。" },
	{ id: "assistant_create", label: "创建助手", description: "验证并保存一个可在新会话中使用的自定义助手。" },
	{ id: "assistant_update", label: "修改助手", description: "按当前版本验证并更新助手配置。" },
	{ id: "update_plan", label: "开发计划", description: "更新当前开发任务的步骤和进度。" },
	{ id: "verify_changes", label: "验证改动", description: "按会话权限执行检查命令，记录实际退出码和输出。" },
	{
		id: "accept_changes",
		label: "验收改动",
		description: "逐项关联需求与当前通过的检查；缺少检查或检查过期时拒绝验收。",
	},
	{ id: "project_list", label: "List projects", description: "List Workbench projects." },
	{ id: "project_get", label: "Project context", description: "Read the current project." },
	{ id: "task_list", label: "List tasks", description: "List tasks in the session scope." },
	{ id: "task_get", label: "Read task", description: "Read a task in the session scope." },
	{ id: "task_create", label: "Create task", description: "Create a Workbench task." },
	{ id: "task_update", label: "Update task", description: "Change a Workbench task." },
	{ id: "memory_search", label: "Search memory", description: "Search global and current project memory." },
	{ id: "memory_propose", label: "Propose memory", description: "Propose a memory change for user review." },
	{ id: "learning_context", label: "经验提炼依据", description: "读取当前运行的可靠来源、重要事实与可维护技能目录。" },
	{
		id: "skill_manage",
		label: "提炼与修订技能",
		description: "按学习策略保存可复用流程，原位修订已读取的受管理技能。",
	},
	{ id: "artifact_register", label: "Register artifact", description: "Register an output file in the workspace." },
] as const;

const BUILTIN_TOOL_IDS = new Set(BUILTIN_TOOL_CAPABILITIES.map((tool) => tool.id));

export interface CapabilityCatalog {
	builtinTools: readonly BuiltinToolCapability[];
	skills: WorkbenchSkill[];
	connections: Array<{ connection: McpConnection; tools: McpToolRecord[] }>;
}

export interface CapabilityDiagnostic {
	code: string;
	message: string;
	capabilityId?: string;
}

export interface ResolvedCapabilities {
	builtinToolNames: string[];
	skills: WorkbenchSkill[];
	toolBindings: RuntimeToolBinding[];
	diagnostics: CapabilityDiagnostic[];
	fingerprint: string;
}

export class CapabilityService {
	private readonly skills: SkillRepository;
	private readonly connections: McpConnectionRepository;
	private readonly projectSkills?: (projectId: string) => Promise<WorkbenchSkill[]>;

	constructor(
		skills: SkillRepository,
		connections: McpConnectionRepository,
		projectSkills?: (projectId: string) => Promise<WorkbenchSkill[]>,
	) {
		this.skills = skills;
		this.connections = connections;
		this.projectSkills = projectSkills;
	}

	async getCatalog(projectId?: string): Promise<CapabilityCatalog> {
		const allSkills = await this.skills.list();
		const connections = await this.connections.list();
		return {
			builtinTools: BUILTIN_TOOL_CAPABILITIES,
			skills: allSkills.filter(
				(skill) => skill.scope === "global" || (skill.scope === "project" && skill.projectId === projectId),
			),
			connections: await Promise.all(
				connections.map(async (connection) => ({
					connection,
					tools: await this.connections.listTools(connection.id),
				})),
			),
		};
	}

	async validateBindings(profile: AgentProfile, project?: Pick<Project, "id">): Promise<CapabilityDiagnostic[]> {
		return (await this.resolveForSession(profile, project)).diagnostics;
	}

	async invocableSkills(projectId?: string): Promise<WorkbenchSkill[]> {
		return (await this.getCatalog(projectId)).skills.filter(
			(skill) => skill.enabled && !skill.diagnostics.some((value) => /^(error|collision):/u.test(value)),
		);
	}

	async resolveForSession(
		profile: AgentProfile,
		project?: Pick<Project, "id">,
		explicitSkillId?: string,
	): Promise<ResolvedCapabilities> {
		const catalog = await this.getCatalog(project?.id);
		const diagnostics: CapabilityDiagnostic[] = (profile.bindingDiagnostics ?? []).map((message) => ({
			code: "legacy_skill_binding",
			message,
		}));
		const builtinToolNames = profile.tools.filter((toolName) => {
			if (BUILTIN_TOOL_IDS.has(toolName)) return true;
			diagnostics.push({
				code: "builtin_tool_missing",
				message: `Unknown built-in tool: ${toolName}`,
				capabilityId: toolName,
			});
			return false;
		});
		const skillsById = new Map(catalog.skills.map((skill) => [skill.id, skill]));
		const selectedSkills: WorkbenchSkill[] = [];
		const learnedSkills =
			project && !isMinimalAssistant(profile) ? ((await this.projectSkills?.(project.id)) ?? []) : [];
		for (const skillId of new Set([...profile.skillIds, ...learnedSkills.map((skill) => skill.id)])) {
			const skill = skillsById.get(skillId);
			if (!skill) {
				diagnostics.push({
					code: "skill_unavailable",
					message: `Skill is not available in this project: ${skillId}`,
					capabilityId: skillId,
				});
				continue;
			}
			if (
				!skill.enabled ||
				skill.diagnostics.some((value) => value.startsWith("error:") || value.startsWith("collision:"))
			) {
				diagnostics.push({
					code: skill.enabled ? "skill_invalid" : "skill_disabled",
					message: skill.enabled ? `Skill has diagnostics: ${skill.name}` : `Skill is disabled: ${skill.name}`,
					capabilityId: skill.id,
				});
				continue;
			}
			selectedSkills.push(skill);
		}
		if (explicitSkillId) {
			const explicit = catalog.skills.find(
				(skill) =>
					skill.id === explicitSkillId &&
					skill.enabled &&
					!skill.diagnostics.some((value) => /^(error|collision):/u.test(value)),
			);
			if (!explicit) throw new WorkbenchError("invalid_input", "选择的技能已停用、无效或不属于当前项目，请重新选择");
			// Native Pi commands resolve by name. An explicit ID wins over a default of the same name.
			for (let index = selectedSkills.length - 1; index >= 0; index--) {
				if (selectedSkills[index].name === explicit.name) selectedSkills.splice(index, 1);
			}
			selectedSkills.push(explicit);
		}
		const connectionMap = new Map(catalog.connections.map((entry) => [entry.connection.id, entry]));
		const skillNames = new Set<string>();
		for (const skill of selectedSkills) {
			if (skillNames.has(skill.name))
				diagnostics.push({
					code: "skill_name_collision",
					message: `Multiple selected Skills have the name ${skill.name}`,
					capabilityId: skill.id,
				});
			skillNames.add(skill.name);
		}
		const toolBindings: RuntimeToolBinding[] = [];
		for (const binding of profile.mcpBindings) {
			const entry = connectionMap.get(binding.connectionId);
			if (!entry || !entry.connection.enabled) {
				diagnostics.push({
					code: "mcp_connection_unavailable",
					message: `MCP connection is missing or disabled: ${binding.connectionId}`,
					capabilityId: `${binding.connectionId}:${binding.toolName}`,
				});
				continue;
			}
			const tool = entry.tools.find((candidate) => candidate.name === binding.toolName);
			if (tool?.diagnostic) {
				diagnostics.push({
					code: "mcp_tool_schema",
					message: `${entry.connection.name}/${tool.name}: ${tool.diagnostic}`,
				});
				continue;
			}
			if (!tool) {
				diagnostics.push({
					code: "mcp_tool_missing",
					message: `MCP tool is no longer available: ${entry.connection.name}/${binding.toolName}`,
					capabilityId: `${binding.connectionId}:${binding.toolName}`,
				});
				continue;
			}
			if (tool.definitionHash !== binding.approvedDefinitionHash) {
				diagnostics.push({
					code: "mcp_tool_changed",
					message: `MCP tool definition changed and must be approved again: ${entry.connection.name}/${tool.name}`,
					capabilityId: `${binding.connectionId}:${binding.toolName}`,
				});
				continue;
			}
			const id = `${binding.connectionId}:${tool.name}`;
			toolBindings.push({
				providerId: "mcp",
				resourceId: binding.connectionId,
				resourceToolName: tool.name,
				approval: binding.approval,
				descriptor: {
					id,
					name: internalToolName(entry.connection.name, tool.name, id),
					label: `${entry.connection.name} / ${tool.title ?? tool.name}`,
					description: tool.description || `MCP tool ${tool.name} from ${entry.connection.name}`,
					inputSchema: tool.inputSchema,
					definitionHash: tool.definitionHash,
				},
			});
		}
		const fingerprint = this.fingerprint({
			profileId: profile.id,
			profileVersion: profile.version,
			projectId: project?.id,
			connections: profile.mcpBindings.map((binding) => ({
				id: binding.connectionId,
				version: connectionMap.get(binding.connectionId)?.connection.version,
			})),
			builtinToolNames,
			skills: selectedSkills.map((skill) => ({ id: skill.id, hash: skill.sourceHash })),
			tools: toolBindings.map((binding) => ({
				id: binding.descriptor.id,
				hash: binding.descriptor.definitionHash,
				approval: binding.approval,
			})),
		});
		return { builtinToolNames, skills: selectedSkills, toolBindings, diagnostics, fingerprint };
	}

	fingerprint(value: unknown): string {
		return createHash("sha256").update(stableJson(value)).digest("hex");
	}

	assertUsable(resolved: ResolvedCapabilities): void {
		if (resolved.diagnostics.length === 0) return;
		throw new WorkbenchError(
			"conflict",
			`Assistant capabilities are unavailable: ${resolved.diagnostics.map((value) => value.message).join("; ")}`,
		);
	}
}

function internalToolName(connectionName: string, toolName: string, id: string): string {
	const readable = `${connectionName}_${toolName}`
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9_]+/gu, "_")
		.replace(/^_+|_+$/gu, "")
		.slice(0, 38);
	const suffix = createHash("sha256").update(id).digest("hex").slice(0, 10);
	return `mcp_${readable || "tool"}_${suffix}`;
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, sortValue(entry)]),
	);
}
