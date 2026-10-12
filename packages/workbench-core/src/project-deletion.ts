import type { Project } from "./models.ts";

export interface ProjectDeletionPreview {
	projectId: string;
	name: string;
	workspacePath: string;
	sourcePath?: string;
	fingerprint: string;
	pending: boolean;
	counts: {
		sessions: number;
		tasks: number;
		artifacts: number;
		skills: number;
		facts: number;
		episodes: number;
		documents: number;
		reviews: number;
	};
}

/** Durable deletion intent. Paths are revalidated before touching the filesystem. */
export interface ProjectDeletion {
	project: Project;
	preview: ProjectDeletionPreview;
	sessions: Array<{ id: string; runtimeSessionId: string }>;
	taskIds: string[];
	runIds: string[];
	reviewIds: string[];
	semanticIds: string[];
	memoryPaths: string[];
	importIds: string[];
	resourceIds: string[];
}
