import { randomUUID } from "node:crypto";
import type {
	RunCoordinator,
	SessionRepository,
	SessionService,
	TaskCleanupSelection,
	TaskService,
	WorkbenchSession,
	WorkbenchTask,
} from "@earendil-works/workbench-core";
import type { AgentEventBroker } from "./event-broker.ts";
import type { StructuredLogger } from "./logger.ts";

export class TaskCleanupService {
	private readonly options: {
		tasks: TaskService;
		sessions: SessionService;
		sessionRepository: SessionRepository;
		events: AgentEventBroker;
		coordinator: RunCoordinator;
		logger: StructuredLogger;
		compact(): void;
		forgetDiagnostics(id: string): void;
	};

	constructor(options: TaskCleanupService["options"]) {
		this.options = options;
	}

	async preview(filter: { projectId?: string; completedBefore: string }) {
		const candidates = await this.options.tasks.cleanupCandidates(filter);
		const tasks = candidates.slice(0, 500);
		const sessions = await this.ownedSessions(tasks);
		return {
			tasks,
			totalTaskCount: candidates.length,
			sessionCount: sessions.length,
			sessions: sessions.map((session) => ({ id: session.id, title: session.title })),
		};
	}

	async cleanup(selection: TaskCleanupSelection[], deleteHistory: boolean) {
		let result = { deletedTasks: 0, deletedSessions: 0, compacted: false };
		const maintenance = this.options.coordinator.submit(
			`task-cleanup-${randomUUID()}`,
			async () => {
				await this.options.tasks.requestCleanup(selection, deleteHistory);
				const selectedIds = new Set(selection.map((item) => item.id));
				const pending = (await this.options.tasks.pendingCleanups()).filter((task) => selectedIds.has(task.id));
				result = await this.finish(pending);
			},
			{ queueIfBusy: false },
		);
		await maintenance.completion;
		return result;
	}

	async recover(): Promise<void> {
		let recovered = false;
		for (const task of await this.options.tasks.pendingCleanups()) {
			try {
				await this.finish([task], false);
				recovered = true;
			} catch (error) {
				await this.options.logger.log("error", {
					operation: "task.cleanup.recovery",
					taskId: task.id,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (recovered) this.options.compact();
	}

	private async ownedSessions(tasks: WorkbenchTask[]): Promise<WorkbenchSession[]> {
		const selected = new Set(tasks.map((task) => task.id));
		const runs = await this.options.tasks.listRuns();
		const sessions = await this.options.sessionRepository.list();
		return sessions.filter(
			(session) =>
				session.kind === "background" &&
				runs.some((run) => run.sessionId === session.id && selected.has(run.taskId)) &&
				!runs.some((run) => run.sessionId === session.id && !selected.has(run.taskId)),
		);
	}

	private async finish(tasks: WorkbenchTask[], compact = true) {
		let deletedSessions = 0;
		const historyTasks = tasks.filter((task) => task.cleanupDeleteHistory);
		for (const session of await this.ownedSessions(historyTasks)) {
			await this.options.sessions.delete(session.id);
			this.options.events.forgetSession(session.id);
			this.options.forgetDiagnostics(session.id);
			this.options.forgetDiagnostics(session.runtimeSessionId);
			deletedSessions++;
		}
		for (const task of tasks) await this.options.tasks.completeCleanup(task.id);
		if (compact) this.options.compact();
		await this.options.logger.log("task.cleanup", { deletedTasks: tasks.length, deletedSessions });
		return { deletedTasks: tasks.length, deletedSessions, compacted: compact };
	}
}
