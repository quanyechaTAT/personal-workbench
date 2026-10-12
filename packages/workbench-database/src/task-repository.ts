import {
	type TaskCleanupSelection,
	type TaskRepository,
	type TaskStatus,
	WorkbenchError,
	type WorkbenchTask,
} from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface TaskRow {
	id: string;
	project_id: string | null;
	parent_id: string | null;
	title: string;
	description: string;
	type: WorkbenchTask["type"];
	status: WorkbenchTask["status"];
	priority: number;
	assigned_to: string;
	due_at: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
	version: number;
	cleanup_requested_at: string | null;
	cleanup_delete_history: number;
}

function mapTask(row: TaskRow): WorkbenchTask {
	return {
		id: row.id,
		projectId: row.project_id ?? undefined,
		parentId: row.parent_id ?? undefined,
		title: row.title,
		description: row.description,
		type: row.type,
		status: row.status,
		priority: row.priority,
		assignedTo: row.assigned_to,
		dueAt: row.due_at ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at ?? undefined,
		version: row.version,
		cleanupRequestedAt: row.cleanup_requested_at ?? undefined,
		cleanupDeleteHistory: row.cleanup_delete_history === 1,
	};
}

export class SqliteTaskRepository implements TaskRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async create(task: WorkbenchTask): Promise<WorkbenchTask> {
		if (task.parentId) {
			const parent = this.database.prepare("SELECT cleanup_requested_at FROM tasks WHERE id = ?").get(task.parentId);
			if (!parent || parent.cleanup_requested_at)
				throw new WorkbenchError("conflict", "父任务已删除或正在清理，不能新增子任务");
		}
		this.database
			.prepare(
				`INSERT INTO tasks(
          id, project_id, parent_id, title, description, type, status, priority, assigned_to,
          due_at, created_at, updated_at, completed_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				task.id,
				task.projectId ?? null,
				task.parentId ?? null,
				task.title,
				task.description,
				task.type,
				task.status,
				task.priority,
				task.assignedTo,
				task.dueAt ?? null,
				task.createdAt,
				task.updatedAt,
				task.completedAt ?? null,
				task.version,
			);
		return task;
	}

	async get(id: string): Promise<WorkbenchTask | undefined> {
		const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
		return row ? mapTask(row) : undefined;
	}

	async list(filter: { projectId?: string; status?: TaskStatus }): Promise<WorkbenchTask[]> {
		let rows: TaskRow[];
		if (filter.projectId && filter.status) {
			rows = this.database
				.prepare("SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY priority DESC, created_at DESC")
				.all(filter.projectId, filter.status) as unknown as TaskRow[];
		} else if (filter.projectId) {
			rows = this.database
				.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY priority DESC, created_at DESC")
				.all(filter.projectId) as unknown as TaskRow[];
		} else if (filter.status) {
			rows = this.database
				.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at DESC")
				.all(filter.status) as unknown as TaskRow[];
		} else {
			rows = this.database
				.prepare("SELECT * FROM tasks ORDER BY priority DESC, created_at DESC")
				.all() as unknown as TaskRow[];
		}
		return rows.map(mapTask);
	}

	async update(task: WorkbenchTask, expectedVersion: number): Promise<WorkbenchTask | undefined> {
		const result = this.database
			.prepare(
				`UPDATE tasks SET
          title = ?, description = ?, status = ?, priority = ?, assigned_to = ?, due_at = ?, type = ?,
          updated_at = ?, completed_at = ?, version = ?
        WHERE id = ? AND version = ? AND cleanup_requested_at IS NULL`,
			)
			.run(
				task.title,
				task.description,
				task.status,
				task.priority,
				task.assignedTo,
				task.dueAt ?? null,
				task.type,
				task.updatedAt,
				task.completedAt ?? null,
				task.version,
				task.id,
				expectedVersion,
			);
		return result.changes === 1 ? task : undefined;
	}

	async requestCleanup(selection: TaskCleanupSelection[], deleteHistory: boolean, requestedAt: string): Promise<void> {
		this.database.transaction(() => {
			for (const item of selection) {
				const task = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(item.id) as TaskRow | undefined;
				if (!task || task.version !== item.expectedVersion || task.status !== "done" || task.cleanup_requested_at)
					throw new WorkbenchError("conflict", "清理范围中的任务已变化，请重新预览");
				if (
					this.database
						.prepare("SELECT id FROM task_runs WHERE task_id = ? AND status IN ('queued','running') LIMIT 1")
						.get(item.id)
				)
					throw new WorkbenchError("conflict", "任务仍有正在执行的运行，不能清理");
				if (
					this.database
						.prepare("SELECT id FROM tasks WHERE parent_id = ? AND status <> 'done' LIMIT 1")
						.get(item.id)
				)
					throw new WorkbenchError("conflict", "任务还有未完成的子任务，不能清理");
				this.database
					.prepare(
						"UPDATE tasks SET cleanup_requested_at = ?, cleanup_delete_history = ?, version = version + 1 WHERE id = ?",
					)
					.run(requestedAt, deleteHistory ? 1 : 0, item.id);
			}
		});
	}

	async completeCleanup(id: string): Promise<void> {
		this.database.transaction(() => {
			const task = this.database
				.prepare("SELECT id FROM tasks WHERE id = ? AND cleanup_requested_at IS NOT NULL AND status = 'done'")
				.get(id);
			if (!task) throw new WorkbenchError("conflict", "任务没有待完成的清理操作");
			this.database.prepare("UPDATE tasks SET parent_id = NULL WHERE parent_id = ?").run(id);
			this.database
				.prepare(
					"UPDATE artifacts SET task_run_id = NULL WHERE task_run_id IN (SELECT id FROM task_runs WHERE task_id = ?)",
				)
				.run(id);
			this.database
				.prepare(
					"UPDATE agent_runs SET task_run_id = NULL WHERE task_run_id IN (SELECT id FROM task_runs WHERE task_id = ?)",
				)
				.run(id);
			this.database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
		});
	}
}
