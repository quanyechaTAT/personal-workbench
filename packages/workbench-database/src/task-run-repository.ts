import type { TaskRun, TaskRunRepository, TaskRunStatus } from "@earendil-works/workbench-core";
import { WorkbenchError } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface TaskRunRow {
	id: string;
	task_id: string;
	session_id: string | null;
	agent_run_id: string | null;
	status: TaskRunStatus;
	started_at: string;
	finished_at: string | null;
	error_code: string | null;
	summary: string | null;
	created_at: string;
}

function mapTaskRun(row: TaskRunRow): TaskRun {
	return {
		id: row.id,
		taskId: row.task_id,
		sessionId: row.session_id ?? undefined,
		agentRunId: row.agent_run_id ?? undefined,
		status: row.status,
		startedAt: row.started_at,
		finishedAt: row.finished_at ?? undefined,
		errorCode: row.error_code ?? undefined,
		summary: row.summary ?? undefined,
		createdAt: row.created_at,
	};
}

export class SqliteTaskRunRepository implements TaskRunRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async create(run: TaskRun): Promise<TaskRun> {
		this.database
			.prepare(
				`INSERT INTO task_runs(
					id, task_id, session_id, agent_run_id, status, started_at, finished_at, error_code, summary, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				run.id,
				run.taskId,
				run.sessionId ?? null,
				run.agentRunId ?? null,
				run.status,
				run.startedAt,
				run.finishedAt ?? null,
				run.errorCode ?? null,
				run.summary ?? null,
				run.createdAt,
			);
		return run;
	}

	async get(id: string): Promise<TaskRun | undefined> {
		const row = this.database.prepare("SELECT * FROM task_runs WHERE id = ?").get(id) as TaskRunRow | undefined;
		return row ? mapTaskRun(row) : undefined;
	}

	async list(taskId?: string): Promise<TaskRun[]> {
		const rows = taskId
			? (this.database
					.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC")
					.all(taskId) as unknown as TaskRunRow[])
			: (this.database.prepare("SELECT * FROM task_runs ORDER BY created_at DESC").all() as unknown as TaskRunRow[]);
		return rows.map(mapTaskRun);
	}

	async update(
		id: string,
		status: TaskRunStatus,
		input: { agentRunId?: string; finishedAt?: string; errorCode?: string; summary?: string },
	): Promise<TaskRun> {
		const result = this.database
			.prepare(
				`UPDATE task_runs SET status = ?, agent_run_id = coalesce(?, agent_run_id), finished_at = ?,
					error_code = ?, summary = ? WHERE id = ?`,
			)
			.run(
				status,
				input.agentRunId ?? null,
				input.finishedAt ?? null,
				input.errorCode ?? null,
				input.summary ?? null,
				id,
			);
		if (result.changes !== 1) throw new WorkbenchError("not_found", `Task run not found: ${id}`);
		const run = await this.get(id);
		if (!run) throw new WorkbenchError("storage_failure", `Task run disappeared after update: ${id}`);
		return run;
	}

	async markRunningInterrupted(finishedAt: string): Promise<TaskRun[]> {
		const running = (
			this.database
				.prepare("SELECT * FROM task_runs WHERE status IN ('queued','running')")
				.all() as unknown as TaskRunRow[]
		).map(mapTaskRun);
		this.database
			.prepare("UPDATE task_runs SET status = 'interrupted', finished_at = ? WHERE status IN ('queued','running')")
			.run(finishedAt);
		return running.map((run) => ({ ...run, status: "interrupted", finishedAt }));
	}
}
