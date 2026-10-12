import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { WorkbenchError } from "./errors.ts";
import type { Artifact, ArtifactType } from "./models.ts";
import type { ArtifactRepository } from "./repositories.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";
import type { PathPolicy, WorkbenchPaths } from "./workspace.ts";

export interface RegisterArtifactInput {
	projectId?: string;
	sessionId?: string;
	taskRunId?: string;
	type: ArtifactType;
	name: string;
	workspaceRelativePath: string;
	projectRoot?: string;
	toolCallId?: string;
	idempotencyKey?: string;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	".csv": "text/csv",
	".html": "text/html",
	".json": "application/json",
	".md": "text/markdown",
	".pdf": "application/pdf",
	".svg": "image/svg+xml",
	".txt": "text/plain",
};

export class ArtifactService {
	private readonly paths: WorkbenchPaths;
	private readonly pathPolicy: PathPolicy;
	private readonly repository: ArtifactRepository;
	private readonly system: SystemServices;

	constructor(
		paths: WorkbenchPaths,
		pathPolicy: PathPolicy,
		repository: ArtifactRepository,
		system: SystemServices = defaultSystemServices,
	) {
		this.paths = paths;
		this.pathPolicy = pathPolicy;
		this.repository = repository;
		this.system = system;
	}

	async register(input: RegisterArtifactInput): Promise<Artifact> {
		if (input.idempotencyKey) {
			const existing = await this.repository.getByIdempotencyKey(input.idempotencyKey);
			if (existing) return existing;
		}
		const name = input.name.trim();
		if (!name) throw new WorkbenchError("invalid_input", "Artifact name is required");
		const classified = input.projectRoot
			? await this.pathPolicy.requireProjectFile(input.projectRoot, input.workspaceRelativePath)
			: await this.pathPolicy.requireWorkspace(input.workspaceRelativePath);
		const fileStat = await stat(classified.realPath);
		if (!fileStat.isFile()) throw new WorkbenchError("invalid_input", "Artifacts must reference a regular file");
		const content = await readFile(classified.realPath);
		return this.repository.create({
			id: this.system.id(),
			projectId: input.projectId,
			sessionId: input.sessionId,
			taskRunId: input.taskRunId,
			type: input.type,
			name,
			filePath: classified.realPath,
			relativePath: relative(input.projectRoot ?? this.paths.workspace, classified.realPath).replaceAll("\\", "/"),
			mimeType: MIME_BY_EXTENSION[extname(classified.realPath).toLowerCase()] ?? "application/octet-stream",
			size: fileStat.size,
			sha256: createHash("sha256").update(content).digest("hex"),
			toolCallId: input.toolCallId,
			idempotencyKey: input.idempotencyKey,
			createdAt: toTimestamp(this.system.now()),
		});
	}

	list(projectId?: string): Promise<Artifact[]> {
		return this.repository.list(projectId);
	}
}
