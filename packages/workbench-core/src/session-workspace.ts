import { lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkbenchError } from "./errors.ts";
import type { WorkbenchSession } from "./models.ts";
import type { SettingsService } from "./settings-service.ts";
import { type PathPolicy, type WorkbenchPaths, writeTextAtomically } from "./workspace.ts";

export type SessionWorkspaceDisposition = "keep" | "delete" | "migrate";

/** Only the exact owned chats/<id> tree can be moved or deleted; project source roots are never targets. */
export class SessionWorkspaceService {
	private readonly paths: WorkbenchPaths;
	private readonly policy: PathPolicy;
	private readonly settings: SettingsService;
	constructor(paths: WorkbenchPaths, policy: PathPolicy, settings: SettingsService) {
		this.paths = paths;
		this.policy = policy;
		this.settings = settings;
	}
	path(id: string): string {
		if (!/^[a-z0-9-]{1,128}$/iu.test(id)) throw new WorkbenchError("invalid_input", "会话工作区 ID 无效");
		return `chats/${id}`;
	}
	async ensure(id: string, projectId?: string): Promise<string> {
		const path = this.path(id);
		const target = await this.checked(path);
		await mkdir(target, { recursive: true });
		await this.checked(path);
		const marker = join(target, ".workbench-session.json");
		const existing = await this.marker(target);
		if (existing && existing !== id) throw new WorkbenchError("conflict", "会话目录已属于其他会话");
		if (!existing)
			await writeTextAtomically(
				marker,
				JSON.stringify({ sessionId: id, projectId, createdAt: new Date().toISOString() }, null, 2),
			);
		return target;
	}
	async describe(id: string) {
		const action = (await this.settings.get(`session.workspaceDisposition.${id}`))?.value ?? "migrate";
		return {
			path: join(this.paths.workspace, this.path(id)),
			migrationPath: join(this.paths.workspace, "archive", this.path(id)),
			action,
		};
	}
	async validateDeletion(
		session: WorkbenchSession,
		selected?: SessionWorkspaceDisposition,
	): Promise<SessionWorkspaceDisposition> {
		const action = selected ?? (await this.describe(session.id)).action;
		if (!["keep", "delete", "migrate"].includes(String(action)))
			throw new WorkbenchError("invalid_input", "会话工作区处理方式无效");
		if (action === "keep") return action;
		const relative = this.path(session.id);
		const source = await this.checked(relative);
		const exists = await lstat(source).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		});
		if (!exists) return action as SessionWorkspaceDisposition; // A completed move/delete is idempotent during crash recovery.
		if ((await this.marker(source)) !== session.id)
			throw new WorkbenchError("path_denied", "工作区缺少所属会话标记，保留原目录");
		await this.checkTree(source);
		if (action === "migrate") {
			const destination = await this.checked(`archive/${relative}`);
			const occupied = await lstat(destination).catch((error: unknown) => {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
					return undefined;
				throw error;
			});
			if (occupied) throw new WorkbenchError("conflict", "迁移目标已存在，保留双方目录");
		}
		return action as SessionWorkspaceDisposition;
	}
	async finishDeletion(session: WorkbenchSession, selected?: SessionWorkspaceDisposition): Promise<void> {
		const action = await this.validateDeletion(session, selected);
		if (action === "keep") return;
		const relative = this.path(session.id);
		const source = await this.checked(relative);
		try {
			await lstat(source);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		if (action === "delete") await rm(await this.checked(relative), { recursive: true });
		else {
			const destination = await this.checked(`archive/${relative}`);
			await mkdir(dirname(destination), { recursive: true });
			await rename(await this.checked(relative), await this.checked(`archive/${relative}`));
		}
	}
	private async checked(path: string): Promise<string> {
		const target = await this.policy.requireWorkspace(path);
		// An 8.3 alias can resolve to a different spelling without being a link.
		// Inspect every ancestor so junctions remain forbidden, including on missing targets.
		let current = target.absolutePath;
		while (true) {
			const metadata = await lstat(current).catch((error: unknown) => {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
					return undefined;
				throw error;
			});
			if (metadata?.isSymbolicLink()) throw new WorkbenchError("path_denied", "会话工作区不能通过链接迁移或删除");
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
		return target.absolutePath;
	}
	private async checkTree(path: string): Promise<void> {
		// The root has already passed exact ownership and containment checks. Inspect
		// metadata only, including .env files, without reading contents or following links.
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink()) throw new WorkbenchError("path_denied", "会话工作区包含链接，请先移除链接");
		if (metadata.isDirectory()) for (const entry of await readdir(path)) await this.checkTree(join(path, entry));
	}
	private async marker(root: string): Promise<string | undefined> {
		const file = join(root, ".workbench-session.json");
		const metadata = await lstat(file).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		});
		if (!metadata) return undefined;
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096)
			throw new WorkbenchError("path_denied", "会话工作区标记无效");
		const value: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!value || typeof value !== "object" || !("sessionId" in value) || typeof value.sessionId !== "string")
			throw new WorkbenchError("invalid_input", "会话工作区标记损坏");
		return value.sessionId;
	}
}
