import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
	type PathPolicy,
	WorkbenchError,
	type WorkbenchPaths,
	writeTextAtomically,
} from "@earendil-works/workbench-core";

export interface FileEntry {
	name: string;
	path: string;
	type: "directory" | "file";
	size?: number;
	modifiedAt: string;
}

export interface TextFile {
	path: string;
	content: string;
	contentHash: string;
	size: number;
	modifiedAt: string;
}

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export class FileService {
	private readonly paths: WorkbenchPaths;
	private readonly pathPolicy: PathPolicy;
	private readonly maximumBytes: number;

	constructor(paths: WorkbenchPaths, pathPolicy: PathPolicy, maximumBytes = 2 * 1024 * 1024) {
		this.paths = paths;
		this.pathPolicy = pathPolicy;
		this.maximumBytes = maximumBytes;
	}

	private resolveFile(path: string, projectRoot?: string) {
		return projectRoot
			? this.pathPolicy.requireProjectFile(projectRoot, path)
			: this.pathPolicy.requireWorkspace(path);
	}

	async list(path = "", projectRoot?: string): Promise<FileEntry[]> {
		const root = projectRoot ?? this.paths.workspace;
		const classified = await this.resolveFile(path || ".", projectRoot);
		const targetStat = await stat(classified.realPath);
		if (!targetStat.isDirectory()) throw new WorkbenchError("invalid_input", "File listing requires a directory");
		const entries = await readdir(classified.realPath, { withFileTypes: true });
		const output = await Promise.all(
			entries
				.filter((entry) => (entry.isDirectory() || entry.isFile()) && !/^\.env(?:\..+)?$/iu.test(entry.name))
				.map(async (entry): Promise<FileEntry> => {
					const directoryPath = relative(root, classified.realPath).replaceAll("\\", "/");
					const child = await this.resolveFile(
						directoryPath ? `${directoryPath}/${entry.name}` : entry.name,
						projectRoot,
					);
					const metadata = await stat(child.realPath);
					return {
						name: entry.name,
						path: relative(root, child.realPath).replaceAll("\\", "/"),
						type: entry.isDirectory() ? "directory" : "file",
						size: entry.isFile() ? metadata.size : undefined,
						modifiedAt: metadata.mtime.toISOString(),
					};
				}),
		);
		return output.sort((left, right) =>
			left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1,
		);
	}

	async read(path: string, projectRoot?: string): Promise<TextFile> {
		if (!projectRoot && resolve(this.paths.workspace, path) === resolve(this.paths.workspace, "USER.md"))
			throw new WorkbenchError("not_found", "工作区没有 USER.md，请通过记忆入口查看工作台用户偏好");
		const classified = await this.resolveFile(path, projectRoot);
		const metadata = await stat(classified.realPath);
		if (!metadata.isFile()) throw new WorkbenchError("invalid_input", "File preview requires a regular file");
		if (metadata.size > this.maximumBytes) throw new WorkbenchError("invalid_input", "File is too large to preview");
		const content = await readFile(classified.realPath, "utf8");
		if (content.includes("\0")) throw new WorkbenchError("invalid_input", "Binary files cannot be edited as text");
		return {
			path: relative(projectRoot ?? this.paths.workspace, classified.realPath).replaceAll("\\", "/"),
			content,
			contentHash: hash(content),
			size: metadata.size,
			modifiedAt: metadata.mtime.toISOString(),
		};
	}

	async write(path: string, content: string, expectedHash?: string, projectRoot?: string): Promise<TextFile> {
		if (Buffer.byteLength(content, "utf8") > this.maximumBytes) {
			throw new WorkbenchError("invalid_input", "File is too large to edit in Workbench");
		}
		const classified = projectRoot
			? await this.pathPolicy.requireProjectFile(projectRoot, path)
			: await this.pathPolicy.requireAgentWrite(path);
		if (expectedHash !== undefined) {
			const current = await readFile(classified.absolutePath, "utf8").catch((error: unknown) => {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
				throw error;
			});
			if (hash(current) !== expectedHash) throw new WorkbenchError("conflict", "File changed since it was loaded");
		}
		await writeTextAtomically(classified.absolutePath, content);
		return this.read(path, projectRoot);
	}

	isManagedMemory(path: string): boolean {
		return this.pathPolicy.isProtectedMemoryPath(resolve(this.paths.workspace, path));
	}
}
