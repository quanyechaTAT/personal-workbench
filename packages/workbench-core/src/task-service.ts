import { WorkbenchError } from "./errors.ts";
import type { TaskCleanupSelection, TaskRun, TaskRunStatus, TaskStatus, TaskType, WorkbenchTask } from "./models.ts";
import type { TaskRepository, TaskRunRepository } from "./repositories.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";

export interface CreateTaskInput {
	projectId?: string;
	parentId?: string;
	title: string;
	description?: string;
	type?: TaskType;
	status?: TaskStatus;
	priority?: number;
	assignedTo?: string;
	dueAt?: string;
}

export interface UpdateTaskInput {
	title?: string;
	description?: string;
	status?: TaskStatus;
	priority?: number;
	assignedTo?: string;
	dueAt?: string | null;
	expectedVersion: number;
}

function validatePriority(priority: number): void {
	if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
		throw new WorkbenchError("invalid_input", "Task priority must be an integer from 0 to 4");
	}
}

export class TaskService {
	private readonly repository: TaskRepository;
	private readonly runs: TaskRunRepository | undefined;
	private readonly system: SystemServices;

	constructor(repository: TaskRepository, system: SystemServices = defaultSystemServices, runs?: TaskRunRepository) {
		this.repository = repository;
		this.system = system;
		this.runs = runs;
	}

	async create(input: CreateTaskInput): Promise<WorkbenchTask> {
		const title = input.title.trim();
		if (!title) throw new WorkbenchError("invalid_input", "Task title is required");
		const priority = input.priority ?? 2;
		validatePriority(priority);
		if (input.parentId) {
			const parent = await this.get(input.parentId);
			if (parent.cleanupRequestedAt) throw new WorkbenchError("conflict", "父任务正在清理，不能新增子任务");
			if (parent.projectId !== input.projectId) {
				throw new WorkbenchError("invalid_input", "Parent and child tasks must belong to the same project");
			}
		}
		const now = toTimestamp(this.system.now());
		return this.repository.create({
			id: this.system.id(),
			projectId: input.projectId,
			parentId: input.parentId,
			title,
			description: input.description?.trim() ?? "",
			type: input.type ?? "human",
			status: input.status ?? "todo",
			priority,
			assignedTo: input.assignedTo?.trim() || (input.type === "agent" ? "personal-agent" : "me"),
			dueAt: input.dueAt,
			createdAt: now,
			updatedAt: now,
			completedAt: input.status === "done" ? now : undefined,
			version: 1,
		});
	}

	async get(id: string): Promise<WorkbenchTask> {
		const task = await this.repository.get(id);
		if (!task) throw new WorkbenchError("not_found", `Task not found: ${id}`);
		return this.withExecution(task, this.runs ? await this.runs.list(id) : []);
	}

	async list(filter: { projectId?: string; status?: TaskStatus } = {}): Promise<WorkbenchTask[]> {
		const runs = this.runs ? await this.runs.list() : [];
		const grouped = new Map<string, TaskRun[]>();
		for (const run of runs) {
			const group = grouped.get(run.taskId) ?? [];
			group.push(run);
			grouped.set(run.taskId, group);
		}
		return (await this.repository.list(filter)).map((task) => this.withExecution(task, grouped.get(task.id) ?? []));
	}

	async update(id: string, input: UpdateTaskInput): Promise<WorkbenchTask> {
		const current = await this.get(id);
		if (current.cleanupRequestedAt) throw new WorkbenchError("conflict", "该任务正在清理，不能修改");
		if (current.execution?.status === "queued" || current.execution?.status === "running")
			throw new WorkbenchError("conflict", "请先在任务会话中停止助手，再修改任务");
		return this.applyUpdate(current, input);
	}

	private async applyUpdate(
		current: WorkbenchTask,
		input: UpdateTaskInput,
		assignedProfileId?: string,
	): Promise<WorkbenchTask> {
		if (input.priority !== undefined) validatePriority(input.priority);
		if (input.title !== undefined && !input.title.trim()) {
			throw new WorkbenchError("invalid_input", "Task title cannot be empty");
		}
		const now = toTimestamp(this.system.now());
		const status = input.status ?? current.status;
		const updated: WorkbenchTask = {
			...current,
			type: assignedProfileId ? "agent" : current.type,
			title: input.title?.trim() ?? current.title,
			description: input.description?.trim() ?? current.description,
			status,
			priority: input.priority ?? current.priority,
			assignedTo: assignedProfileId ?? input.assignedTo?.trim() ?? current.assignedTo,
			dueAt: input.dueAt === null ? undefined : (input.dueAt ?? current.dueAt),
			updatedAt: now,
			completedAt: status === "done" ? (current.completedAt ?? now) : undefined,
			version: current.version + 1,
		};
		const saved = await this.repository.update(updated, input.expectedVersion);
		if (!saved) throw new WorkbenchError("conflict", "Task changed since it was loaded");
		return saved;
	}

	async assertRunnable(id: string, expectedVersion?: number): Promise<WorkbenchTask> {
		const task = await this.get(id);
		if (expectedVersion !== undefined && expectedVersion !== task.version)
			throw new WorkbenchError("conflict", "任务已变化，请刷新后重新交给助手");
		if (task.cleanupRequestedAt || ["running", "done", "cancelled"].includes(task.status))
			throw new WorkbenchError("conflict", "该任务正在执行、已完成、已取消或正在清理");
		if (task.execution?.status === "queued" || task.execution?.status === "running")
			throw new WorkbenchError("conflict", "该任务已有排队或执行中的运行");
		return task;
	}

	async startAgentRun(id: string, sessionId: string): Promise<TaskRun> {
		const queued = await this.queueAgentRun(id, sessionId);
		return this.beginAgentRun(queued.id);
	}

	async queueAgentRun(
		id: string,
		sessionId: string,
		assignment?: { profileId: string; expectedVersion: number },
	): Promise<TaskRun> {
		const task = await this.assertRunnable(id, assignment?.expectedVersion);
		if (!assignment && task.type !== "agent")
			throw new WorkbenchError("invalid_input", "Only agent tasks can be run");
		if (["running", "done", "cancelled"].includes(task.status)) {
			throw new WorkbenchError("conflict", `Task cannot start while it is ${task.status}`);
		}
		const runs = this.requireRuns();
		if ((await runs.list(task.id)).some((run) => run.status === "queued" || run.status === "running")) {
			throw new WorkbenchError("conflict", "Task already has an active run");
		}
		const now = toTimestamp(this.system.now());
		if (assignment)
			await this.applyUpdate(task, { expectedVersion: assignment.expectedVersion }, assignment.profileId);
		return runs.create({
			id: this.system.id(),
			taskId: task.id,
			sessionId,
			status: "queued",
			startedAt: now,
			createdAt: now,
		});
	}

	async beginAgentRun(runId: string, agentRunId?: string): Promise<TaskRun> {
		const runs = this.requireRuns();
		const run = await runs.get(runId);
		if (!run) throw new WorkbenchError("not_found", `Task run not found: ${runId}`);
		if (run.status === "running") return run;
		if (run.status !== "queued") throw new WorkbenchError("conflict", `Task run is ${run.status}`);
		const task = await this.get(run.taskId);
		if (["running", "done", "cancelled"].includes(task.status)) {
			throw new WorkbenchError("conflict", `Task cannot start while it is ${task.status}`);
		}
		try {
			await this.applyUpdate(task, { status: "running", expectedVersion: task.version });
			return runs.update(run.id, "running", { agentRunId });
		} catch (error) {
			await runs.update(run.id, "failed", {
				finishedAt: toTimestamp(this.system.now()),
				summary: "Task state update failed",
			});
			throw error;
		}
	}

	async settleAgentRun(
		runId: string,
		status: Extract<TaskRunStatus, "review" | "failed" | "cancelled" | "interrupted">,
		input: { agentRunId?: string; errorCode?: string; summary?: string; verificationRequired?: boolean } = {},
	): Promise<TaskRun> {
		const runs = this.requireRuns();
		const run = await runs.get(runId);
		if (!run) throw new WorkbenchError("not_found", `Task run not found: ${runId}`);
		if (run.status !== "running" && run.status !== "queued") return run;
		const task = await this.get(run.taskId);
		const taskStatus: TaskStatus =
			status === "review"
				? input.verificationRequired
					? "blocked"
					: "review"
				: status === "cancelled"
					? "cancelled"
					: status === "failed"
						? "failed"
						: "blocked";
		await this.applyUpdate(task, { status: taskStatus, expectedVersion: task.version });
		const { verificationRequired: _verificationRequired, ...result } = input;
		return runs.update(run.id, status, { ...result, finishedAt: toTimestamp(this.system.now()) });
	}

	listRuns(taskId?: string): Promise<TaskRun[]> {
		return this.requireRuns().list(taskId);
	}

	async cleanupCandidates(filter: { projectId?: string; completedBefore: string }): Promise<WorkbenchTask[]> {
		const cutoff = Date.parse(filter.completedBefore);
		if (!Number.isFinite(cutoff)) throw new WorkbenchError("invalid_input", "清理日期无效");
		const all = await this.list();
		const blockedParents = new Set(
			all.filter((task) => task.parentId && task.status !== "done").map((task) => task.parentId),
		);
		return all.filter(
			(task) =>
				task.status === "done" &&
				!task.cleanupRequestedAt &&
				(!filter.projectId || task.projectId === filter.projectId) &&
				task.completedAt &&
				Date.parse(task.completedAt) <= cutoff &&
				!blockedParents.has(task.id) &&
				task.execution?.status !== "queued" &&
				task.execution?.status !== "running",
		);
	}

	async requestCleanup(selection: TaskCleanupSelection[], deleteHistory: boolean): Promise<void> {
		if (
			!selection.length ||
			selection.length > 500 ||
			new Set(selection.map((item) => item.id)).size !== selection.length
		)
			throw new WorkbenchError("invalid_input", "请选择 1–500 个不同的已完成任务");
		await this.repository.requestCleanup(selection, deleteHistory, toTimestamp(this.system.now()));
	}

	async pendingCleanups(): Promise<WorkbenchTask[]> {
		return (await this.repository.list({})).filter((task) => task.cleanupRequestedAt);
	}

	completeCleanup(id: string): Promise<void> {
		return this.repository.completeCleanup(id);
	}

	async initializeRecovery(): Promise<void> {
		if (!this.runs) return;
		const interrupted = await this.runs.markRunningInterrupted(toTimestamp(this.system.now()));
		for (const run of interrupted) {
			const task = await this.get(run.taskId);
			if (task.status === "running")
				await this.applyUpdate(task, { status: "blocked", expectedVersion: task.version });
		}
	}

	private withExecution(task: WorkbenchTask, runs: TaskRun[]): WorkbenchTask {
		const latest = runs.find((run) => run.status === "queued" || run.status === "running") ?? runs[0];
		return {
			...task,
			execution: latest
				? { status: latest.status, sessionId: latest.sessionId, agentRunId: latest.agentRunId }
				: undefined,
		};
	}

	private requireRuns(): TaskRunRepository {
		if (!this.runs) throw new WorkbenchError("not_found", "Task run storage is not configured");
		return this.runs;
	}
}
