import { basename } from "node:path";
import { WorkbenchError } from "./errors.ts";
import type { Project, ProjectStatus } from "./models.ts";
import type { ProjectRepository } from "./repositories.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";
import { PathPolicy, type WorkspaceManager } from "./workspace.ts";

export interface CreateProjectInput {
	name?: string;
	description?: string;
	status?: Extract<ProjectStatus, "active" | "paused">;
	sourcePath?: string;
	defaultProfileId?: string;
}

export function projectSlug(name: string, fallbackId?: string): string {
	const slug = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.replace(/-{2,}/gu, "-");
	if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(slug)) {
		const fallback = `project-${fallbackId ?? ""}`;
		if (name.trim() && fallbackId && /^[a-z0-9][a-z0-9-]{1,63}$/u.test(fallback)) return fallback;
		throw new WorkbenchError("invalid_input", "Project name must produce a 2-64 character ASCII slug");
	}
	return slug;
}

export class ProjectService {
	private readonly repository: ProjectRepository;
	private readonly workspace: WorkspaceManager;
	private readonly system: SystemServices;
	private readonly pathPolicy: PathPolicy;

	constructor(
		repository: ProjectRepository,
		workspace: WorkspaceManager,
		system: SystemServices = defaultSystemServices,
		pathPolicy = new PathPolicy(workspace.paths, [workspace.paths.credentials]),
	) {
		this.repository = repository;
		this.workspace = workspace;
		this.system = system;
		this.pathPolicy = pathPolicy;
	}

	async create(input: CreateProjectInput): Promise<Project> {
		const sourcePath =
			input.sourcePath === undefined
				? undefined
				: await this.pathPolicy.validateProjectSource(input.sourcePath.trim());
		const name = sourcePath ? basename(sourcePath) : input.name?.trim();
		if (!name) throw new WorkbenchError("invalid_input", "请选择已有项目文件夹");
		if (
			sourcePath &&
			(await this.repository.list()).some(
				(project) => project.sourcePath && samePath(project.sourcePath, sourcePath),
			)
		)
			throw new WorkbenchError("conflict", "该本机目录已关联项目，请打开已有项目");
		const id = this.system.id();
		let slug = projectSlug(name, id);
		if (await this.repository.getBySlug(slug)) slug = projectSlug(`project-${id}`, id);
		const now = toTimestamp(this.system.now());
		const paths = this.workspace.paths.project(slug);
		const project: Project = {
			id,
			slug,
			name,
			description: input.description?.trim() ?? "",
			status: "creating",
			workspacePath: paths.root,
			sourcePath,
			defaultProfileId: input.defaultProfileId,
			projectFilePath: paths.projectFile,
			memoryFilePath: paths.memoryFile,
			createdAt: now,
			updatedAt: now,
		};
		await this.repository.create(project);
		try {
			await this.workspace.prepareProject(id, slug, name, project.description);
			return this.repository.setStatus(id, input.status ?? "active", toTimestamp(this.system.now()));
		} catch (error) {
			await this.repository.setStatus(id, "failed", toTimestamp(this.system.now()));
			throw new WorkbenchError("storage_failure", `Could not create project ${name}`, { cause: error });
		}
	}

	async get(id: string): Promise<Project> {
		const project = await this.repository.get(id);
		if (!project) throw new WorkbenchError("not_found", `Project not found: ${id}`);
		if (await this.repository.isDeleting(id))
			throw new WorkbenchError("conflict", "项目正在删除，不能继续使用；可在项目列表重试删除");
		return project;
	}

	validateSource(path: string): Promise<string> {
		return this.pathPolicy.validateProjectSource(path);
	}

	async list(status?: ProjectStatus): Promise<Project[]> {
		const deleting = new Set((await this.repository.pendingDeletions()).map((intent) => intent.project.id));
		return (await this.repository.list(status)).filter((project) => !deleting.has(project.id));
	}

	async assertSourceAvailable(project: Project): Promise<void> {
		if (!project.sourcePath) return;
		const actual = await this.pathPolicy.validateProjectSource(project.sourcePath);
		if (!samePath(actual, project.sourcePath))
			throw new WorkbenchError("path_denied", "项目目录的实际位置已变化，请重新关联项目");
	}

	async recoverCreating(): Promise<Project[]> {
		const recovered: Project[] = [];
		for (const project of await this.repository.list("creating")) {
			if (await this.repository.isDeleting(project.id)) continue;
			const state = await this.workspace.recoverPreparedProject(project.id, project.slug);
			const status = state === "ready" ? "active" : "failed";
			recovered.push(await this.repository.setStatus(project.id, status, toTimestamp(this.system.now())));
		}
		return recovered;
	}
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
