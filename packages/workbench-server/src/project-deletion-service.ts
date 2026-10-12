import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	type ProjectDeletion,
	type ProjectRepository,
	type RunCoordinator,
	type SessionRepository,
	type SessionService,
	WorkbenchError,
	type WorkbenchPaths,
} from "@earendil-works/workbench-core";
import type { StructuredLogger } from "./logger.ts";

export class ProjectDeletionService {
	private readonly options: {
		paths: WorkbenchPaths;
		projects: ProjectRepository;
		sessionRepository: SessionRepository;
		sessions: SessionService;
		coordinator: RunCoordinator;
		logger: StructuredLogger;
		isBusy(projectId: string): Promise<boolean>;
		closeBrowser(sessionId: string): Promise<void>;
		compact(): void;
	};
	constructor(options: ProjectDeletionService["options"]) {
		this.options = options;
	}
	preview(id: string) {
		return this.options.projects.previewDeletion(id);
	}
	async delete(id: string, expectedFingerprint: string) {
		let result: Awaited<ReturnType<ProjectDeletionService["finish"]>> | undefined;
		const handle = this.options.coordinator.submit(
			`project-delete-${randomUUID()}`,
			async () => {
				if (await this.options.isBusy(id))
					throw new WorkbenchError("conflict", "请等待项目后台复盘、上传和索引结束，或取消文档处理后再删除");
				const scope = await this.options.projects.inspectDeletion(id);
				// Validate every destination before persisting intent or deleting any session.
				for (const path of this.targets(scope)) await this.validateTarget(path);
				const intent = await this.options.projects.beginDeletion(id, expectedFingerprint);
				result = await this.finish(intent);
			},
			{ queueIfBusy: false },
		);
		await handle.completion;
		if (!result) throw new WorkbenchError("conflict", "项目删除已取消");
		return result;
	}
	async recover(): Promise<void> {
		for (const intent of await this.options.projects.pendingDeletions()) {
			try {
				await this.finish(intent);
			} catch (error) {
				await this.options.logger.log("error", {
					operation: "project.delete.recovery",
					projectId: intent.project.id,
					message: error instanceof WorkbenchError ? error.message : "项目删除未完成，可在项目列表重试",
				});
			}
		}
	}
	private targets(intent: ProjectDeletion): string[] {
		const { paths } = this.options;
		const segment = (value: string) => {
			if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) throw new WorkbenchError("path_denied", "项目删除引用无效");
			return value;
		};
		const project = intent.project;
		const root = paths.project(segment(project.slug)).root;
		if (normalized(root) !== normalized(project.workspacePath))
			throw new WorkbenchError("path_denied", "项目工作台目录与受管理位置不一致");
		if (project.sourcePath && contained(root, project.sourcePath))
			throw new WorkbenchError("path_denied", "本机源目录位于删除范围内，已停止删除");
		const targets = [
			root,
			join(paths.projects, `.${project.slug}.creating-${segment(project.id)}`),
			join(paths.memory, "history", "workspace-v1", "projects", project.slug),
		];
		for (const session of intent.sessions) {
			targets.push(
				join(paths.inbox, "chat-attachments", segment(session.id)),
				join(paths.workspace, "chats", session.id),
			);
		}
		for (const id of intent.reviewIds) targets.push(join(paths.runtime, "reviews", segment(id)));
		for (const id of intent.runIds) targets.push(join(paths.runtime, "checkpoints", segment(id)));
		for (const id of intent.semanticIds) targets.push(join(paths.memory, "history", segment(id)));
		for (const id of intent.importIds)
			targets.push(
				join(paths.cache, "skill-imports", segment(id)),
				join(paths.cache, "skill-imports", `${id}.journal.json`),
			);
		for (const path of intent.memoryPaths) {
			if (!path.startsWith(`projects/${project.slug}/`))
				throw new WorkbenchError("path_denied", "项目记忆历史引用超出范围");
			targets.push(join(paths.memory, "history", "files", createHash("sha256").update(path).digest("hex")));
		}
		return [...new Set(targets)];
	}
	private async validateTarget(path: string): Promise<void> {
		const root = resolve(this.options.paths.root),
			target = resolve(path);
		const offset = relative(root, target);
		if (!offset || !contained(root, target))
			throw new WorkbenchError("path_denied", "删除路径超出工作台受管理数据目录");
		const actualRoot = await realpath(root);
		for (const part of [
			root,
			...offset.split(/[\\/]/u).map((_name, index, names) => join(root, ...names.slice(0, index + 1))),
		]) {
			const info = await lstat(part).catch((error: unknown) => {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
					return undefined;
				throw error;
			});
			if (!info) return;
			if (info.isSymbolicLink() || !contained(actualRoot, await realpath(part)))
				throw new WorkbenchError("path_denied", "删除路径包含链接或已离开数据目录，请先移除该链接后重试");
		}
		// Refuse nested junctions before deleting anything. Never traverse a source-directory link.
		const inspect = async (entry: string): Promise<void> => {
			const info = await lstat(entry);
			if (info.isSymbolicLink())
				throw new WorkbenchError("path_denied", "受管理目录包含链接，请先移除该链接后重试删除");
			if (info.isDirectory()) for (const name of await readdir(entry)) await inspect(join(entry, name));
		};
		await inspect(target);
	}
	private async finish(intent: ProjectDeletion) {
		const targets = this.targets(intent);
		for (const target of targets) await this.validateTarget(target);
		for (const session of intent.sessions) {
			if (await this.options.sessionRepository.get(session.id)) await this.options.sessions.delete(session.id);
			await this.options.closeBrowser(session.id);
		}
		for (const target of targets) {
			await this.validateTarget(target);
			await rm(target, { recursive: true, force: true });
		}
		await this.options.projects.finishDeletion(intent.project.id);
		let compacted = false;
		try {
			this.options.compact();
			compacted = true;
		} catch {
			await this.options.logger.log("error", {
				operation: "project.delete.compact",
				projectId: intent.project.id,
				message: "数据已删除，数据库空间回收未完成",
			});
		}
		await this.options.logger.log("project.delete", {
			projectId: intent.project.id,
			counts: intent.preview.counts,
			compacted,
		});
		return { deleted: true as const, projectId: intent.project.id, sessions: intent.sessions, compacted };
	}
}
function normalized(path: string): string {
	return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}
function contained(root: string, target: string): boolean {
	const offset = relative(normalized(root), normalized(target));
	return (
		offset === "" ||
		(offset !== ".." && !offset.startsWith(`..\\`) && !offset.startsWith("../") && !isAbsolute(offset))
	);
}
