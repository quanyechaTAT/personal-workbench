import type { ActivityRecord, JsonValue } from "./models.ts";
import type { ActivityRepository } from "./repositories.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";

export interface RecordActivityInput {
	projectId?: string;
	sessionId?: string;
	runId?: string;
	type: string;
	summary: string;
	metadata?: Record<string, JsonValue>;
}

export class ActivityService {
	private readonly repository: ActivityRepository;
	private readonly system: SystemServices;

	constructor(repository: ActivityRepository, system: SystemServices = defaultSystemServices) {
		this.repository = repository;
		this.system = system;
	}

	record(input: RecordActivityInput): Promise<ActivityRecord> {
		return this.repository.create({
			id: this.system.id(),
			projectId: input.projectId,
			sessionId: input.sessionId,
			runId: input.runId,
			type: input.type,
			summary: input.summary,
			metadata: input.metadata ?? {},
			createdAt: toTimestamp(this.system.now()),
		});
	}

	list(filter?: { projectId?: string; sessionId?: string; limit?: number }): Promise<ActivityRecord[]> {
		return this.repository.list(filter);
	}
}
