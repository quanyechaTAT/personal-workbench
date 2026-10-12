import { cp, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { WorkbenchError } from "./errors.ts";
import type { Project, SkillImport, SkillImportCandidate, SkillScope, WorkbenchSkill } from "./models.ts";
import type { ProjectRepository, SkillImportRepository, SkillRepository } from "./repositories.ts";
import { inspectSkillFiles } from "./skill-files.ts";
import type { SkillCatalogReader, SkillSourceStager } from "./skill-ports.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";
import { PathPolicy, type WorkbenchPaths, writeTextAtomically } from "./workspace.ts";

export interface PreviewSkillImportInput {
	source: "local" | "git";
	location: string;
	ref?: string;
	subdirectory?: string;
	scope: SkillScope;
	projectId?: string;
}

/** File swaps have a recovery journal; their metadata commits in one database transaction. */
export class SkillImportService {
	private readonly paths: WorkbenchPaths;
	private readonly imports: SkillImportRepository;
	private readonly skills: SkillRepository;
	private readonly projects: ProjectRepository;
	private readonly catalog: SkillCatalogReader;
	private readonly stager: SkillSourceStager;
	private readonly system: SystemServices;
	private applying = false;

	constructor(options: {
		paths: WorkbenchPaths;
		imports: SkillImportRepository;
		skills: SkillRepository;
		projects: ProjectRepository;
		catalog: SkillCatalogReader;
		stager: SkillSourceStager;
		system?: SystemServices;
	}) {
		this.paths = options.paths;
		this.imports = options.imports;
		this.skills = options.skills;
		this.projects = options.projects;
		this.catalog = options.catalog;
		this.stager = options.stager;
		this.system = options.system ?? defaultSystemServices;
	}

	async preview(input: PreviewSkillImportInput): Promise<SkillImport> {
		if (input.scope === "global" && input.projectId)
			throw new WorkbenchError("invalid_input", "Global Skills cannot specify a project");
		if (input.scope === "project" && !input.projectId)
			throw new WorkbenchError("invalid_input", "Project Skills require a project");
		if (input.projectId) await this.requireProject(input.projectId);
		if (!input.location.trim()) throw new WorkbenchError("invalid_input", "Skill source location is required");
		const id = this.system.id();
		const stagingPath = join(this.paths.cache, "skill-imports", id);
		await mkdir(stagingPath, { recursive: true });
		try {
			const staged = await this.stager.stage({ ...input, location: input.location.trim(), stagingPath });
			const parsed = await this.catalog.readDirectory(stagingPath, "path");
			const candidates: SkillImportCandidate[] = [];
			for (const skill of parsed.skills) {
				validateSlug(skill.name);
				const manifest = await inspectSkillFiles(skill.baseDir);
				candidates.push({
					slug: skill.name,
					name: skill.name,
					description: skill.description,
					relativePath: safeRelative(stagingPath, skill.baseDir),
					files: manifest.files.map((file) => file.path),
					contentHash: manifest.hash,
					diagnostics: parsed.diagnostics
						.filter((diagnostic) => !diagnostic.path || diagnostic.path === skill.filePath)
						.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`),
				});
			}
			if (candidates.length === 0)
				throw new WorkbenchError("invalid_input", "No valid Pi Skills were found in the source");
			if (new Set(candidates.map((candidate) => candidate.slug.toLowerCase())).size !== candidates.length)
				throw new WorkbenchError("conflict", "Source contains duplicate Skill names");
			const now = toTimestamp(this.system.now());
			return await this.imports.create({
				id,
				source: input.source,
				sourceLocation: input.location.trim(),
				sourceRef: input.ref,
				sourceCommit: staged.commit,
				sourceSubdirectory: input.subdirectory,
				scope: input.scope,
				projectId: input.projectId,
				stagingPath,
				candidates,
				status: "preview",
				createdAt: now,
				updatedAt: now,
			});
		} catch (error) {
			await this.stager.remove(stagingPath);
			throw error;
		}
	}

	async previewUpdate(skillId: string): Promise<SkillImport> {
		const skill = await this.skills.get(skillId);
		if (!skill || !skill.sourceUrl || (skill.sourceKind !== "git" && skill.sourceKind !== "local"))
			throw new WorkbenchError("invalid_input", "This Skill has no import source to update");
		const before = await inspectSkillFiles(dirname(skill.path));
		if (!skill.importedHash || before.hash !== skill.importedHash)
			throw new WorkbenchError(
				"conflict",
				"This Skill has local edits. Resolve them before updating from its source",
			);
		const preview = await this.preview({
			source: skill.sourceKind,
			location: skill.sourceUrl,
			ref: skill.sourceRef,
			subdirectory: skill.sourceSubdirectory,
			scope: skill.scope,
			projectId: skill.projectId,
		});
		const candidate = preview.candidates.find((value) => value.slug === skill.slug);
		if (!candidate) {
			await this.discardPreview(preview.id);
			throw new WorkbenchError("not_found", "The source no longer contains this Skill");
		}
		const after = await inspectSkillFiles(resolve(preview.stagingPath, candidate.relativePath));
		const oldFiles = new Map(before.files.map((file) => [file.path, file.sha256]));
		const newFiles = new Map(after.files.map((file) => [file.path, file.sha256]));
		const changes: NonNullable<SkillImportCandidate["update"]>["changes"] = [];
		for (const [path, hash] of newFiles) {
			if (!oldFiles.has(path)) changes.push({ path, kind: "added" });
			else if (oldFiles.get(path) !== hash) changes.push({ path, kind: "changed" });
		}
		for (const path of oldFiles.keys()) if (!newFiles.has(path)) changes.push({ path, kind: "removed" });
		return this.imports.update({
			...preview,
			candidates: [{ ...candidate, update: { skillId, expectedHash: before.hash, changes } }],
		});
	}

	async readPreviewFile(id: string, slug: string, path: string): Promise<{ before?: string; after?: string }> {
		const value = await this.get(id);
		if (value.status !== "preview") throw new WorkbenchError("conflict", "Import preview is no longer available");
		const candidate = value.candidates.find((entry) => entry.slug === slug);
		if (
			!candidate ||
			(!candidate.files.includes(path) && !candidate.update?.changes.some((change) => change.path === path))
		)
			throw new WorkbenchError("not_found", "File is not in the import manifest");
		const afterRoot = resolve(value.stagingPath, candidate.relativePath);
		safeRelative(value.stagingPath, afterRoot);
		const beforeSkill = candidate.update ? await this.skills.get(candidate.update.skillId) : undefined;
		async function text(root: string): Promise<string | undefined> {
			const file = resolve(root, path);
			safeRelative(root, file);
			if (!(await exists(file))) return undefined;
			await inspectSkillFiles(root);
			if ((await lstat(file)).size > 256_000) return "[File exceeds the 256 KB preview limit]";
			const content = await readFile(file, "utf8");
			return content.includes("\0") ? "[Binary file]" : content;
		}
		return { before: beforeSkill ? await text(dirname(beforeSkill.path)) : undefined, after: await text(afterRoot) };
	}

	async commitImport(id: string, slugs: string[]): Promise<{ import: SkillImport; skills: WorkbenchSkill[] }> {
		if (this.applying) throw new WorkbenchError("conflict", "Another Skill import is being applied");
		this.applying = true;
		try {
			return await this.apply(id, slugs);
		} finally {
			this.applying = false;
		}
	}

	private async apply(id: string, slugs: string[]): Promise<{ import: SkillImport; skills: WorkbenchSkill[] }> {
		const current = await this.get(id);
		if (current.status !== "preview") throw new WorkbenchError("conflict", `Skill import is ${current.status}`);
		const selected = current.candidates.filter((candidate) => slugs.includes(candidate.slug));
		if (!selected.length || selected.length !== new Set(slugs).size)
			throw new WorkbenchError("invalid_input", "Select valid Skills to import");
		const targetRoot = await this.targetRoot(current);
		await mkdir(targetRoot, { recursive: true });
		const imported: WorkbenchSkill[] = [];
		for (const candidate of selected) {
			if (candidate.diagnostics.some((value) => /^(error|collision):/u.test(value)))
				throw new WorkbenchError("invalid_input", "Resolve Skill parser errors first");
			const source = resolve(current.stagingPath, candidate.relativePath);
			safeRelative(current.stagingPath, source);
			const manifest = await inspectSkillFiles(source);
			if (manifest.hash !== candidate.contentHash)
				throw new WorkbenchError("conflict", "Import source changed since preview");
			const destination = join(targetRoot, candidate.slug);
			const previous = candidate.update ? await this.skills.get(candidate.update.skillId) : undefined;
			if (candidate.update) {
				if (
					!previous ||
					resolve(dirname(previous.path)) !== resolve(destination) ||
					(await inspectSkillFiles(destination)).hash !== candidate.update.expectedHash
				)
					throw new WorkbenchError("conflict", "Skill changed since update preview");
			} else if (await exists(destination))
				throw new WorkbenchError("conflict", `Skill directory already exists: ${candidate.slug}`);
			const now = toTimestamp(this.system.now());
			imported.push({
				id: previous?.id ?? this.system.id(),
				slug: candidate.slug,
				name: candidate.name,
				description: candidate.description,
				scope: current.scope,
				projectId: current.projectId,
				enabled: previous?.enabled ?? true,
				path: join(destination, "SKILL.md"),
				sourceHash: manifest.hash,
				importedHash: manifest.hash,
				isBuiltin: false,
				sourceKind: current.source,
				sourceUrl: current.sourceLocation,
				sourceRef: current.sourceRef,
				sourceCommit: current.sourceCommit,
				sourceSubdirectory: current.sourceSubdirectory,
				diagnostics: candidate.diagnostics,
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
			});
		}
		await writeTextAtomically(this.journal(current), JSON.stringify(selected.map((candidate) => candidate.slug)));
		try {
			for (const candidate of selected) {
				const destination = join(targetRoot, candidate.slug);
				const temporary = `${destination}.import-${id}`;
				await cp(resolve(current.stagingPath, candidate.relativePath), temporary, {
					recursive: true,
					force: false,
					errorOnExist: true,
					verbatimSymlinks: true,
				});
				if ((await inspectSkillFiles(temporary)).hash !== candidate.contentHash)
					throw new WorkbenchError("conflict", "Skill changed while copying");
				if (candidate.update) await rename(destination, `${destination}.backup-${id}`);
				await rename(temporary, destination);
			}
			const completed = await this.imports.commit(
				{ ...current, status: "committed", updatedAt: toTimestamp(this.system.now()) },
				imported,
			);
			// A committed transaction must not be rolled back if subsequent cache cleanup fails.
			await this.cleanup(completed, selected, false);
			return { import: completed, skills: imported };
		} catch (error) {
			if ((await this.get(id)).status === "committed") return { import: await this.get(id), skills: imported };
			await this.cleanup(current, selected, true);
			await this.imports.update({
				...current,
				status: "failed",
				errorMessage: error instanceof Error ? error.message : String(error),
				updatedAt: toTimestamp(this.system.now()),
			});
			throw error;
		}
	}

	async discardPreview(id: string): Promise<SkillImport> {
		if (this.applying) throw new WorkbenchError("conflict", "A Skill import is being applied");
		const current = await this.get(id);
		if (current.status === "committed") throw new WorkbenchError("conflict", "Committed imports cannot be discarded");
		await this.stager.remove(current.stagingPath);
		return this.imports.update({ ...current, status: "discarded", updatedAt: toTimestamp(this.system.now()) });
	}

	async recoverPendingImports(): Promise<void> {
		for (const value of await this.imports.list()) {
			if (await exists(this.journal(value))) {
				const slugs: unknown = JSON.parse(await readFile(this.journal(value), "utf8"));
				if (!Array.isArray(slugs) || !slugs.every((slug): slug is string => typeof slug === "string"))
					throw new WorkbenchError("storage_failure", "Invalid Skill recovery journal");
				await this.cleanup(
					value,
					value.candidates.filter((candidate) => slugs.includes(candidate.slug)),
					value.status !== "committed",
				);
				if (value.status !== "committed")
					await this.imports.update({
						...value,
						status: "failed",
						errorMessage: "Interrupted import was rolled back; preview the source again",
						updatedAt: toTimestamp(this.system.now()),
					});
			} else if (value.status === "preview" && !(await exists(value.stagingPath))) {
				await this.imports.update({
					...value,
					status: "failed",
					errorMessage: "Import staging directory is missing",
					updatedAt: toTimestamp(this.system.now()),
				});
			}
		}
	}

	private async cleanup(value: SkillImport, selected: SkillImportCandidate[], rollback: boolean): Promise<void> {
		const root = await this.targetRoot(value);
		for (const candidate of selected) {
			validateSlug(candidate.slug);
			const destination = join(root, candidate.slug);
			const backup = `${destination}.backup-${value.id}`;
			if (rollback && ((await exists(backup)) || !candidate.update)) {
				if (await exists(destination)) {
					if ((await inspectSkillFiles(destination)).hash !== candidate.contentHash)
						throw new WorkbenchError("conflict", `Recovery preserved externally edited Skill: ${candidate.slug}`);
					await rm(destination, { recursive: true, force: true });
				}
				if (await exists(backup)) await rename(backup, destination);
			} else if (!rollback) await rm(backup, { recursive: true, force: true });
			await rm(`${destination}.import-${value.id}`, { recursive: true, force: true });
		}
		await this.stager.remove(value.stagingPath);
		await rm(this.journal(value), { force: true });
	}

	async get(id: string): Promise<SkillImport> {
		const value = await this.imports.get(id);
		if (!value) throw new WorkbenchError("not_found", `Skill import not found: ${id}`);
		return value;
	}

	private journal(value: SkillImport): string {
		return `${value.stagingPath}.journal.json`;
	}
	private async targetRoot(value: SkillImport): Promise<string> {
		const project = value.projectId ? await this.requireProject(value.projectId) : undefined;
		const root =
			value.scope === "global" ? this.paths.skills : join(this.paths.project(project!.slug).root, "skills");
		await new PathPolicy(this.paths).requireWorkspace(relative(this.paths.workspace, root));
		return root;
	}
	private async requireProject(id: string): Promise<Project> {
		const project = await this.projects.get(id);
		if (!project) throw new WorkbenchError("not_found", `Project not found: ${id}`);
		return project;
	}
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(
		() => true,
		(error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
			throw error;
		},
	);
}

function safeRelative(root: string, child: string): string {
	const value = relative(resolve(root), resolve(child));
	if (value.startsWith("..") || isAbsolute(value))
		throw new WorkbenchError("path_denied", "Skill path escapes its directory");
	return value;
}

function validateSlug(slug: string): void {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(slug))
		throw new WorkbenchError("invalid_input", `Invalid Skill name: ${slug}`);
}
