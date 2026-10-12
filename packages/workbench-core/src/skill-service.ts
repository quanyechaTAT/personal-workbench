import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { WorkbenchError } from "./errors.ts";
import type { Project, SkillScope, WorkbenchSkill } from "./models.ts";
import type { SkillRepository } from "./repositories.ts";
import { inspectSkillFiles } from "./skill-files.ts";
import type { SkillCatalogReader } from "./skill-ports.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";
import { PathPolicy, type WorkbenchPaths, writeTextAtomically } from "./workspace.ts";

export interface CreateSkillInput {
	slug: string;
	name: string;
	description: string;
	instructions?: string;
	scope: SkillScope;
	project?: Pick<Project, "id" | "slug">;
}

export class SkillService {
	private readonly paths: WorkbenchPaths;
	private readonly repository: SkillRepository;
	private readonly system: SystemServices;
	private readonly catalog: SkillCatalogReader;

	constructor(
		paths: WorkbenchPaths,
		repository: SkillRepository,
		catalog: SkillCatalogReader,
		system: SystemServices = defaultSystemServices,
	) {
		this.paths = paths;
		this.repository = repository;
		this.system = system;
		this.catalog = catalog;
	}

	async discover(scope: SkillScope, project?: Pick<Project, "id" | "slug">): Promise<WorkbenchSkill[]> {
		if (scope === "project" && !project)
			throw new WorkbenchError("invalid_input", "Project Skill discovery requires a project");
		const root = scope === "global" ? this.paths.skills : join(this.paths.project(project!.slug).root, "skills");
		await this.assertManagedPath(root);
		await readdir(root).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
			throw error;
		});
		const result = await this.catalog.readDirectory(root, scope === "global" ? "user" : "project");
		const discovered: WorkbenchSkill[] = [];
		for (const parsed of result.skills) {
			const skillPath = parsed.filePath;
			await this.assertManagedPath(skillPath);
			const manifest = await inspectSkillFiles(dirname(skillPath));
			const slug =
				basename(skillPath) === "SKILL.md" ? basename(dirname(skillPath)) : basename(skillPath, extname(skillPath));
			const diagnostics = result.diagnostics
				.filter((diagnostic) => !diagnostic.path || diagnostic.path === skillPath)
				.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`);
			const now = toTimestamp(this.system.now());
			const existing = (await this.repository.list({ scope, projectId: project?.id })).find(
				(skill) => skill.slug === slug,
			);
			discovered.push(
				await this.repository.upsert({
					id: existing?.id ?? this.system.id(),
					slug,
					name: parsed.name,
					description: parsed.description,
					scope,
					projectId: project?.id,
					enabled: existing?.enabled ?? true,
					path: skillPath,
					sourceHash: manifest.hash,
					importedHash: existing?.importedHash,
					isBuiltin: existing?.isBuiltin ?? false,
					sourceKind: existing?.sourceKind ?? "workspace",
					sourceUrl: existing?.sourceUrl,
					sourceRef: existing?.sourceRef,
					sourceCommit: existing?.sourceCommit,
					sourceSubdirectory: existing?.sourceSubdirectory,
					diagnostics,
					createdAt: existing?.createdAt ?? now,
					updatedAt: now,
				}),
			);
		}
		for (const previous of await this.repository.list({ scope, projectId: project?.id })) {
			if (!discovered.some((skill) => skill.id === previous.id))
				await this.repository.upsert({
					...previous,
					diagnostics: ["error: Skill file is missing or was rejected by the Pi parser"],
					updatedAt: toTimestamp(this.system.now()),
				});
		}
		return discovered;
	}

	list(filter?: { scope?: SkillScope; projectId?: string }): Promise<WorkbenchSkill[]> {
		return this.repository.list(filter);
	}

	async get(id: string): Promise<WorkbenchSkill> {
		const skill = await this.repository.get(id);
		if (!skill) throw new WorkbenchError("not_found", `Skill not found: ${id}`);
		return skill;
	}

	async create(input: CreateSkillInput): Promise<WorkbenchSkill> {
		validateSkillSlug(input.slug);
		if (!input.name.trim() || !input.description.trim()) {
			throw new WorkbenchError("invalid_input", "Skill name and description are required");
		}
		if (input.scope === "project" && !input.project)
			throw new WorkbenchError("invalid_input", "Project Skill requires a project");
		if (input.scope === "global" && input.project)
			throw new WorkbenchError("invalid_input", "Global Skill cannot specify a project");
		const root =
			input.scope === "global" ? this.paths.skills : join(this.paths.project(input.project!.slug).root, "skills");
		const directory = join(root, input.slug);
		await this.assertManagedPath(directory);
		await mkdir(root, { recursive: true });
		const exists = await stat(directory).then(
			() => true,
			() => false,
		);
		if (exists) throw new WorkbenchError("conflict", `Skill directory already exists: ${input.slug}`);
		await mkdir(directory, { recursive: false });
		const content = [
			"---",
			`name: ${input.slug}`,
			`description: ${yamlScalar(input.description.trim())}`,
			"---",
			"",
			`# ${input.name.trim()}`,
			"",
			input.instructions?.trim() || "Describe how this Skill should guide the agent.",
			"",
		].join("\n");
		await writeTextAtomically(join(directory, "SKILL.md"), content);
		const discovered = await this.discover(input.scope, input.project);
		const skill = discovered.find((value) => value.slug === input.slug);
		if (!skill) {
			await rm(directory, { recursive: true, force: true });
			throw new WorkbenchError("invalid_input", "Pi did not recognize the new Skill");
		}
		return skill;
	}

	async readContent(id: string): Promise<{ content: string; hash: string }> {
		const skill = await this.get(id);
		await this.assertManagedPath(skill.path);
		const content = await readFile(skill.path, "utf8");
		return { content, hash: createHash("sha256").update(content).digest("hex") };
	}

	async saveContent(id: string, content: string, expectedHash: string): Promise<WorkbenchSkill> {
		const skill = await this.get(id);
		await this.assertManagedPath(skill.path);
		const current = await readFile(skill.path, "utf8");
		const currentHash = createHash("sha256").update(current).digest("hex");
		if (currentHash !== expectedHash) throw new WorkbenchError("conflict", "Skill changed since it was loaded");
		const validationRoot = join(this.paths.cache, "skill-validation", `${skill.id}-${Date.now()}`);
		try {
			const directory = join(validationRoot, skill.slug);
			await mkdir(directory, { recursive: true });
			await writeTextAtomically(join(directory, "SKILL.md"), content);
			const result = await this.catalog.readDirectory(validationRoot, "path");
			const parsed = result.skills.find((value) => value.filePath.endsWith("SKILL.md"));
			const errors = result.diagnostics.filter((diagnostic) => diagnostic.type === "error");
			if (!parsed || errors.length > 0) {
				throw new WorkbenchError(
					"invalid_input",
					`Invalid Skill: ${errors.map((error) => error.message).join("; ") || "missing valid metadata"}`,
				);
			}
			await writeTextAtomically(skill.path, content);
			return this.repository.upsert({
				...skill,
				name: parsed.name,
				description: parsed.description,
				sourceHash: (await inspectSkillFiles(dirname(skill.path))).hash,
				diagnostics: result.diagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`),
				updatedAt: toTimestamp(this.system.now()),
			});
		} finally {
			await rm(validationRoot, { recursive: true, force: true });
		}
	}

	async setEnabled(id: string, enabled: boolean): Promise<WorkbenchSkill> {
		const skill = await this.repository.setEnabled(id, enabled, toTimestamp(this.system.now()));
		if (!skill) throw new WorkbenchError("not_found", `Skill not found: ${id}`);
		return skill;
	}

	private async assertManagedPath(path: string): Promise<void> {
		const fromWorkspace = relative(resolve(this.paths.workspace), resolve(path));
		if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
			throw new WorkbenchError("path_denied", "Skill file is outside the Workbench workspace");
		}
		await new PathPolicy(this.paths).requireWorkspace(fromWorkspace);
	}
}

function validateSkillSlug(value: string): void {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value)) {
		throw new WorkbenchError("invalid_input", "Skill slug must use lowercase letters, numbers, and single hyphens");
	}
}

function yamlScalar(value: string): string {
	return JSON.stringify(value);
}
