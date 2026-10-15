import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { EOL, homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { WorkbenchError } from "./errors.ts";
import { memoryHash, semanticBlocks } from "./semantic-markdown.ts";

export interface ProjectPaths {
	root: string;
	projectFile: string;
	agentsFile: string;
	memoryFile: string;
	filesDir: string;
	artifactsDir: string;
	knowledgeDir: string;
	skillsDir: string;
}

export type PathZone = "workspace" | "internal-state" | "credential" | "external";

export interface ClassifiedPath {
	input: string;
	absolutePath: string;
	realPath: string;
	zone: PathZone;
}

export class WorkbenchPaths {
	readonly root: string;
	readonly workspace: string;
	readonly userMemory: string;
	readonly projects: string;
	readonly memory: string;
	readonly skills: string;
	readonly artifacts: string;
	readonly inbox: string;
	readonly state: string;
	readonly database: string;
	readonly piSessions: string;
	readonly indexes: string;
	readonly logs: string;
	readonly cache: string;
	readonly runtime: string;
	readonly credentials: string;
	readonly mcpSecretsFile: string;
	readonly config: string;
	readonly configFile: string;

	constructor(root: string) {
		if (root.includes("\0")) throw new WorkbenchError("invalid_input", "Workspace root contains a NUL byte");
		this.root = resolve(root);
		if (parse(this.root).root === this.root) {
			throw new WorkbenchError("invalid_input", "A filesystem or share root cannot be used as the Workbench root");
		}
		this.workspace = join(this.root, "workspace");
		this.userMemory = join(this.root, "USER.md");
		this.projects = join(this.workspace, "projects");
		this.memory = join(this.workspace, "memory");
		this.skills = join(this.workspace, "skills");
		this.artifacts = join(this.workspace, "artifacts");
		this.inbox = join(this.workspace, "inbox");
		this.state = join(this.root, "state");
		this.database = join(this.state, "workbench.db");
		this.piSessions = join(this.state, "pi", "sessions");
		this.indexes = join(this.state, "indexes");
		this.logs = join(this.state, "logs");
		this.cache = join(this.state, "cache");
		this.runtime = join(this.state, "runtime");
		this.credentials = join(this.state, "credentials");
		this.mcpSecretsFile = join(this.credentials, "mcp.json");
		this.config = join(this.root, "config");
		this.configFile = join(this.config, "workbench.json");
	}

	/** Memory IDs use logical paths; USER.md belongs to the whole Workbench. */
	memoryFile(relativePath: string): string {
		return relativePath === "USER.md" ? this.userMemory : join(this.workspace, relativePath);
	}

	project(slug: string): ProjectPaths {
		const root = join(this.projects, slug);
		return {
			root,
			projectFile: join(root, "AGENTS.md"),
			agentsFile: join(root, "AGENTS.md"),
			memoryFile: join(root, "AGENTS.md"),
			filesDir: join(root, "files"),
			artifactsDir: join(root, "artifacts"),
			knowledgeDir: join(root, "knowledge"),
			skillsDir: join(root, "skills"),
		};
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch (error) {
		void error;
		return false;
	}
}

async function writeNewFile(path: string, content: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "wx");
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return;
		throw error;
	} finally {
		await handle?.close();
	}
}

export async function writeTextAtomically(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	const handle = await open(temporaryPath, "wx");
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporaryPath, path);
}

export class WorkspaceManager {
	readonly paths: WorkbenchPaths;

	constructor(paths: WorkbenchPaths) {
		this.paths = paths;
	}

	async initialize(): Promise<void> {
		const directories = [
			this.paths.workspace,
			this.paths.projects,
			this.paths.memory,
			this.paths.skills,
			this.paths.artifacts,
			this.paths.inbox,
			this.paths.state,
			this.paths.piSessions,
			this.paths.indexes,
			this.paths.logs,
			this.paths.cache,
			this.paths.runtime,
			this.paths.credentials,
			this.paths.config,
		];
		await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
		await Promise.all([
			writeNewFile(this.paths.userMemory, `# User Memory${EOL}`),
			writeNewFile(join(this.paths.workspace, "MEMORY.md"), `# Global Memory${EOL}`),
			writeNewFile(this.paths.configFile, `{${EOL}  "version": 1${EOL}}${EOL}`),
		]);
	}

	async prepareProject(id: string, slug: string, name: string, description: string): Promise<ProjectPaths> {
		const target = this.paths.project(slug);
		const temporaryRoot = join(this.paths.projects, `.${slug}.creating-${id}`);
		if (await exists(target.root)) throw new WorkbenchError("conflict", `Project directory already exists: ${slug}`);
		await mkdir(temporaryRoot, { recursive: false });
		const temporary: ProjectPaths = {
			root: temporaryRoot,
			projectFile: join(temporaryRoot, "AGENTS.md"),
			agentsFile: join(temporaryRoot, "AGENTS.md"),
			memoryFile: join(temporaryRoot, "AGENTS.md"),
			filesDir: join(temporaryRoot, "files"),
			artifactsDir: join(temporaryRoot, "artifacts"),
			knowledgeDir: join(temporaryRoot, "knowledge"),
			skillsDir: join(temporaryRoot, "skills"),
		};
		await Promise.all([
			mkdir(temporary.filesDir),
			mkdir(temporary.artifactsDir),
			mkdir(temporary.knowledgeDir),
			mkdir(temporary.skillsDir),
			writeNewFile(
				temporary.projectFile,
				`<!-- workbench-project-context -->${EOL}${[
					`# ${name}`,
					"",
					"## Goal",
					"",
					"## Description",
					"",
					description,
					"",
					"## Current status",
					"",
					"Active",
					"",
					"## Constraints",
					"",
					"## Current focus",
					"",
				].join(EOL)}<!-- /workbench-project-context -->${EOL}${EOL}## 项目经验${EOL}`,
			),
		]);
		await rename(temporary.root, target.root);
		return target;
	}

	async recoverPreparedProject(id: string, slug: string): Promise<"ready" | "missing"> {
		const target = this.paths.project(slug).root;
		if (await exists(target)) return "ready";
		const temporary = join(this.paths.projects, `.${slug}.creating-${id}`);
		if (!(await exists(temporary))) return "missing";
		await rename(temporary, target);
		return "ready";
	}

	async readWorkspaceText(relativePath: string): Promise<string> {
		return readFile(join(this.paths.workspace, relativePath), "utf8");
	}

	/** Called under the application instance lock, after recovering earlier Memory writes. */
	async consolidateLegacyMemory(policy: PathPolicy, projectSlugs: readonly string[]): Promise<void> {
		await this.relocateUserMemory(policy);
		for (const [source, target] of [
			["AGENTS.md", "MEMORY.md"],
			["IDENTITY.md", "USER.md"],
		])
			await this.mergeLegacyDocument(policy, source, target, false);
		for (const slug of projectSlugs) {
			const prefix = `projects/${slug}`;
			const skills = await policy.requireWorkspace(`${prefix}/skills`);
			await mkdir(skills.absolutePath, { recursive: true });
			await policy.requireWorkspace(`${prefix}/skills`);
			const oldProject = await this.migrationText(policy, `${prefix}/PROJECT.md`);
			const oldMemory = await this.migrationText(policy, `${prefix}/MEMORY.md`);
			if (oldProject === undefined && oldMemory === undefined) continue;
			const target = `${prefix}/AGENTS.md`;
			const existing = await this.migrationText(policy, target);
			if (existing?.trim() && !existing.includes("<!-- workbench-project-context -->")) {
				await this.backupMigrationText(policy, target, existing);
				if ((await this.migrationText(policy, target)) !== existing)
					throw new WorkbenchError("conflict", "项目文档在迁移期间变化，保留原件");
				const selected = await policy.requireWorkspace(target);
				await writeTextAtomically(
					selected.absolutePath,
					`<!-- workbench-project-context -->\n${existing.trim()}\n<!-- /workbench-project-context -->\n`,
				);
			}
			await this.mergeLegacyDocument(policy, `${prefix}/PROJECT.md`, target, true);
			await this.mergeLegacyDocument(policy, `${prefix}/MEMORY.md`, target, false);
		}
	}

	private async migrationText(policy: PathPolicy, path: string, memoryTarget = false): Promise<string | undefined> {
		const selected = memoryTarget ? await policy.requireMemory(path) : await policy.requireWorkspace(path);
		const metadata = await lstat(selected.absolutePath).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		});
		if (!metadata) return undefined;
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2 * 1024 * 1024)
			throw new WorkbenchError("path_denied", "旧工作台文档必须是工作区内的普通文本文件，最多 2 MiB");
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				await readFile(selected.absolutePath),
			);
		} catch {
			throw new WorkbenchError("invalid_input", "旧工作台文档不是 UTF-8 文本，保留原件");
		}
		if (content.includes("\0")) throw new WorkbenchError("invalid_input", "旧工作台文档不是文本，保留原件");
		return content;
	}

	private async relocateUserMemory(policy: PathPolicy): Promise<void> {
		const original = await this.migrationText(policy, "USER.md");
		if (original === undefined) return;
		await this.backupMigrationText(policy, "workspace/USER.md", original, "user-root-v2");
		const before = (await this.migrationText(policy, "USER.md", true)) ?? "";
		await this.backupMigrationText(policy, "root/USER.md", before, "user-root-v2");
		const marker = `<!-- workbench-user-root-v2 ${JSON.stringify({ source: "workspace/USER.md", hash: memoryHash(original) })} -->`;
		const targetBlocks = semanticBlocks(before, "user", "USER.md");
		let addition = original;
		for (const block of semanticBlocks(original, "user", "USER.md").reverse()) {
			const existing = targetBlocks.find((value) => value.record.id === block.record.id);
			if (!existing) continue;
			const sourceText = original.slice(block.start, block.end).replaceAll("\r\n", "\n");
			if (sourceText !== before.slice(existing.start, existing.end).replaceAll("\r\n", "\n"))
				throw new WorkbenchError("conflict", "两份 USER.md 中同一条目存在不同版本；已备份，请先整理冲突后重启");
			addition = addition.slice(0, block.start) + addition.slice(block.end);
		}
		addition = addition.replace(/^# User Memory\s*\r?\n/u, "").trim();
		const normalized = (text: string) => text.replaceAll("\r\n", "\n").trim();
		// Preserve bytes (and pending candidate hashes) when migrating into the bootstrap document.
		const after =
			!before.trim() || /^# User Memory\s*$/u.test(before)
				? original
				: !addition || before.includes(marker) || normalized(before).includes(normalized(addition))
					? before
					: `${before.trimEnd()}\n\n${marker}\n## 由旧工作区迁入的用户偏好\n\n${addition}\n`;
		if (Buffer.byteLength(after, "utf8") > 2 * 1024 * 1024)
			throw new WorkbenchError("invalid_input", "USER.md 合并后超过 2 MiB，保留两份原件，请先整理");
		semanticBlocks(after, "user", "USER.md");
		if (
			(await this.migrationText(policy, "USER.md")) !== original ||
			((await this.migrationText(policy, "USER.md", true)) ?? "") !== before
		)
			throw new WorkbenchError("conflict", "USER.md 在迁移期间变化，保留原件和备份");
		if (after !== before) await writeTextAtomically((await policy.requireMemory("USER.md")).absolutePath, after);
		if (
			(await this.migrationText(policy, "USER.md")) !== original ||
			(await this.migrationText(policy, "USER.md", true)) !== after
		)
			throw new WorkbenchError("conflict", "USER.md 在迁移期间变化，保留旧工作区文件");
		await unlink((await policy.requireWorkspace("USER.md")).absolutePath);
	}

	private async backupMigrationText(
		policy: PathPolicy,
		source: string,
		content: string,
		version = "workspace-v1",
	): Promise<void> {
		const selected = await policy.requireWorkspace(`memory/history/${version}/${source}.${memoryHash(content)}.md`);
		await mkdir(dirname(selected.absolutePath), { recursive: true });
		await policy.requireWorkspace(relative(this.paths.workspace, selected.absolutePath));
		await writeNewFile(selected.absolutePath, content);
		if ((await this.migrationText(policy, relative(this.paths.workspace, selected.absolutePath))) !== content)
			throw new WorkbenchError("conflict", "旧文档备份已变化，保留源文件并停止合并");
	}

	private async mergeLegacyDocument(
		policy: PathPolicy,
		source: string,
		target: string,
		context: boolean,
	): Promise<void> {
		const original = await this.migrationText(policy, source);
		if (original === undefined) return;
		await this.backupMigrationText(policy, source, original);
		const before = (await this.migrationText(policy, target, true)) ?? "";
		const marker = `<!-- workbench-workspace-merge-v1 ${JSON.stringify({ source, hash: memoryHash(original) })} -->`;
		let body = original.replace(/^# (?:Workbench Instructions|Personal Agent Identity)\s*\r?\n/u, "").trim();
		if (source === "AGENTS.md" || source === "IDENTITY.md")
			body = body
				.replaceAll("<!-- workbench-semantic", "<!-- legacy-workbench-semantic")
				.replaceAll("<!-- /workbench-semantic", "<!-- /legacy-workbench-semantic");
		const normalized = (text: string) => text.replaceAll("\r\n", "\n").trim();
		const duplicate = body && normalized(before).includes(normalized(body));
		const addition =
			body && !duplicate
				? context
					? `<!-- workbench-project-context -->\n${body}\n<!-- /workbench-project-context -->`
					: `## 由 ${basename(source)} 迁入（旧内容，未新增确认）\n\n${body}`
				: "";
		const after =
			!body || before.includes(marker)
				? before
				: `${before.trimEnd()}\n\n${marker}${addition ? `\n${addition}` : ""}\n`;
		if (Buffer.byteLength(after, "utf8") > 2 * 1024 * 1024)
			throw new WorkbenchError("invalid_input", "合并后文档超过 2 MiB，保留源文件，请先整理");
		if (target.startsWith("projects/")) semanticBlocks(after, "project", target);
		if (after !== before && before) await this.backupMigrationText(policy, target, before);
		if (((await this.migrationText(policy, target, true)) ?? "") !== before)
			throw new WorkbenchError("conflict", "合并目标已被修改，保留旧文档");
		if (after !== before) {
			const selected = await policy.requireMemory(target);
			await writeTextAtomically(selected.absolutePath, after);
		}
		if (
			(await this.migrationText(policy, source)) !== original ||
			(await this.migrationText(policy, target, true)) !== after
		)
			throw new WorkbenchError("conflict", "文档在合并期间变化，保留源文件和备份");
		const selected = await policy.requireWorkspace(source);
		await unlink(selected.absolutePath);
	}
}

async function canonicalCandidate(path: string): Promise<string> {
	let cursor = resolve(path);
	const missingSegments: string[] = [];
	while (!(await exists(cursor))) {
		const parent = dirname(cursor);
		if (parent === cursor) throw new WorkbenchError("path_denied", `Cannot resolve path: ${path}`);
		missingSegments.unshift(basename(cursor));
		cursor = parent;
	}
	const canonicalParent = await realpath(cursor);
	return resolve(canonicalParent, ...missingSegments);
}

function inside(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function normalizeForComparison(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class PathPolicy {
	private readonly paths: WorkbenchPaths;
	private readonly credentialRoots: string[];

	constructor(paths: WorkbenchPaths, credentialRoots: string[] = []) {
		this.paths = paths;
		this.credentialRoots = credentialRoots.map(normalizeForComparison);
	}

	async classify(
		input: string,
		basePath = this.paths.workspace,
		projectRoots: readonly string[] = [],
	): Promise<ClassifiedPath> {
		if (input.includes("\0")) throw new WorkbenchError("path_denied", "Paths cannot contain NUL bytes");
		if (/^(?:\\\\[.?]\\|[a-zA-Z]:[^\\/])/u.test(input)) {
			throw new WorkbenchError("path_denied", "Device namespace and drive-relative paths are not supported");
		}
		const absolutePath = isAbsolute(input) ? resolve(input) : resolve(basePath, input);
		const realPath = await canonicalCandidate(absolutePath);
		const comparisonPath = normalizeForComparison(realPath);
		const workspaceRoot = normalizeForComparison(await canonicalCandidate(this.paths.workspace));
		const stateRoot = normalizeForComparison(await canonicalCandidate(this.paths.state));
		const credentialRoots = await Promise.all(
			this.credentialRoots.map(async (root) => normalizeForComparison(await canonicalCandidate(root))),
		);
		const credential = credentialRoots.some((root) => inside(root, comparisonPath));
		const projectCredential = [absolutePath, realPath].some((path) => /^\.env(?:\..+)?$/iu.test(basename(path)));
		const additionalRoots = await Promise.all(
			projectRoots.map(async (root) => {
				const canonical = normalizeForComparison(await canonicalCandidate(root));
				if (canonical !== normalizeForComparison(root))
					throw new WorkbenchError("path_denied", "项目目录的实际位置已变化，请重新关联项目");
				return canonical;
			}),
		);
		const zone: PathZone =
			credential || projectCredential
				? "credential"
				: inside(stateRoot, comparisonPath)
					? "internal-state"
					: inside(workspaceRoot, comparisonPath) || additionalRoots.some((root) => inside(root, comparisonPath))
						? "workspace"
						: "external";
		return { input, absolutePath, realPath, zone };
	}

	async validateProjectSource(input: string): Promise<string> {
		if (!isAbsolute(input)) throw new WorkbenchError("invalid_input", "请选择已有项目的绝对目录路径");
		const classified = await this.classify(input);
		let metadata: Awaited<ReturnType<typeof stat>>;
		try {
			metadata = await stat(classified.realPath);
		} catch (error) {
			throw new WorkbenchError("invalid_input", "已有项目目录不存在或无法访问", { cause: error });
		}
		if (!metadata.isDirectory()) throw new WorkbenchError("invalid_input", "已有项目路径必须是目录");
		const root = normalizeForComparison(classified.realPath);
		const protectedRoots = await Promise.all(
			[this.paths.root, ...this.credentialRoots].map(async (path) =>
				normalizeForComparison(await canonicalCandidate(path)),
			),
		);
		if (
			root === normalizeForComparison(parse(root).root) ||
			root === normalizeForComparison(homedir()) ||
			protectedRoots.some((path) => inside(root, path) || inside(path, root))
		)
			throw new WorkbenchError(
				"path_denied",
				"请指定具体的项目目录，不能使用磁盘根目录、用户主目录、凭证或工作台内部目录",
			);
		return classified.realPath;
	}

	async requireProjectFile(root: string, path: string): Promise<ClassifiedPath> {
		if (isAbsolute(path)) throw new WorkbenchError("path_denied", "项目文件路径必须相对于项目目录");
		const classified = await this.classify(path || ".", root, [root]);
		if (
			classified.zone !== "workspace" ||
			!inside(normalizeForComparison(root), normalizeForComparison(classified.realPath))
		)
			throw new WorkbenchError("path_denied", "文件路径越过项目边界");
		if (this.isProtectedMemoryPath(classified.absolutePath))
			throw new WorkbenchError("path_denied", "长期记忆须通过记忆页面修改");
		return classified;
	}

	async requireWorkspace(relativePath: string): Promise<ClassifiedPath> {
		if (isAbsolute(relativePath)) throw new WorkbenchError("path_external", "Expected a workspace-relative path");
		const classified = await this.classify(relativePath);
		if (classified.zone !== "workspace") {
			throw new WorkbenchError("path_denied", "Path escapes the Workbench workspace");
		}
		return classified;
	}

	/** The only root-level document exposed to Memory services; never grants access to state/config. */
	async requireMemory(relativePath: string): Promise<ClassifiedPath> {
		if (relativePath !== "USER.md") return this.requireWorkspace(relativePath);
		const classified = await this.classify(this.paths.userMemory);
		const expected = join(await canonicalCandidate(this.paths.root), "USER.md");
		if (
			classified.zone === "credential" ||
			normalizeForComparison(classified.realPath) !== normalizeForComparison(expected)
		)
			throw new WorkbenchError("path_denied", "工作台 USER.md 必须位于数据根目录，不能通过链接访问其他文件");
		const metadata = await lstat(classified.absolutePath).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		});
		if (metadata && (!metadata.isFile() || metadata.isSymbolicLink()))
			throw new WorkbenchError("path_denied", "工作台 USER.md 必须是普通文本文件");
		return classified;
	}

	isProtectedMemoryPath(path: string): boolean {
		const fromWorkspace = relative(this.paths.workspace, resolve(path)).replaceAll("\\", "/");
		return (
			normalizeForComparison(resolve(path)) === normalizeForComparison(this.paths.userMemory) ||
			/^(?:USER|MEMORY|AGENTS|IDENTITY)\.md$/iu.test(fromWorkspace) ||
			/^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(fromWorkspace) ||
			/^memory\/history\//u.test(fromWorkspace) ||
			/^(?:projects\/[^/]+\/)?memory\/main\.md$/iu.test(fromWorkspace) ||
			/^projects\/[^/]+\/(?:AGENTS|MEMORY|PROJECT)\.md$/iu.test(fromWorkspace)
		);
	}

	async requireAgentWrite(relativePath: string): Promise<ClassifiedPath> {
		const classified = await this.requireWorkspace(relativePath);
		if (this.isProtectedMemoryPath(classified.absolutePath)) {
			throw new WorkbenchError("path_denied", "Long-term memory changes require the Memory service");
		}
		return classified;
	}
}
