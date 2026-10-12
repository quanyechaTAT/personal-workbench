import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useMemo, useState } from "react";
import { api, type WorkbenchTask } from "./api.ts";
import { Icons } from "./icons.tsx";
import { TaskCleanupDialog, TaskExecutionActions, TaskExecutionDialog } from "./task-dialogs.tsx";
import { EmptyState, ErrorNotice, LoadingBlock, PageHeader } from "./ui.tsx";

const COLUMNS: Array<{ status: WorkbenchTask["status"]; label: string }> = [
	{ status: "backlog", label: "待规划" },
	{ status: "todo", label: "待办" },
	{ status: "running", label: "执行中" },
	{ status: "blocked", label: "等待处理" },
	{ status: "review", label: "待确认" },
	{ status: "done", label: "已完成" },
	{ status: "failed", label: "失败" },
	{ status: "cancelled", label: "已取消" },
];

export function TasksPage() {
	const queryClient = useQueryClient();
	const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks(), refetchInterval: 3000 });
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	const [creating, setCreating] = useState(false);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [projectId, setProjectId] = useState("");
	const [type, setType] = useState<"human" | "agent">("human");
	const [priority, setPriority] = useState(2);
	const [filterProject, setFilterProject] = useState("");
	const [delegate, setDelegate] = useState<WorkbenchTask>();
	const [cleaning, setCleaning] = useState(false);
	const create = useMutation({
		mutationFn: () => api.createTask({ title, description, projectId: projectId || undefined, type, priority }),
		onSuccess: async () => {
			setTitle("");
			setDescription("");
			setCreating(false);
			await queryClient.invalidateQueries({ queryKey: ["tasks"] });
		},
	});
	const update = useMutation({
		mutationFn: ({ task, status }: { task: WorkbenchTask; status: WorkbenchTask["status"] }) =>
			api.updateTask(task, { status }),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tasks"] }),
	});
	const visibleTasks = useMemo(
		() => tasks.data?.filter((task) => !filterProject || task.projectId === filterProject) ?? [],
		[tasks.data, filterProject],
	);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (title.trim()) create.mutate();
	};
	return (
		<div className="page-container task-page">
			<PageHeader
				eyebrow="任务执行"
				title="任务"
				description="集中管理人工与助手任务。助手任务需要手动启动，完成后等待你确认。"
				actions={
					<>
						<button type="button" className="button secondary" onClick={() => setCleaning(true)}>
							清理已完成任务
						</button>
						<select
							className="filter-select"
							value={filterProject}
							onChange={(event) => setFilterProject(event.target.value)}
						>
							<option value="">全部项目</option>
							{projects.data?.map((project) => (
								<option key={project.id} value={project.id}>
									{project.name}
								</option>
							))}
						</select>
						<button type="button" className="button primary with-icon" onClick={() => setCreating(true)}>
							<Icons.Plus />
							新建任务
						</button>
					</>
				}
			/>
			{creating && (
				<form className="create-panel task-create" onSubmit={submit}>
					<div>
						<span className="eyebrow">新建任务</span>
						<h2>明确任务目标</h2>
					</div>
					<label>
						<span>标题</span>
						<input
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="例如：检查评估结果"
						/>
					</label>
					<label>
						<span>项目</span>
						<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
							<option value="">个人</option>
							{projects.data?.map((project) => (
								<option key={project.id} value={project.id}>
									{project.name}
								</option>
							))}
						</select>
					</label>
					<label>
						<span>执行者</span>
						<select value={type} onChange={(event) => setType(event.target.value as "human" | "agent")}>
							<option value="human">我</option>
							<option value="agent">个人助手</option>
						</select>
					</label>
					<label>
						<span>优先级</span>
						<select value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
							{[0, 1, 2, 3, 4].map((value) => (
								<option value={value} key={value}>
									P{value}
								</option>
							))}
						</select>
					</label>
					<label className="wide-field">
						<span>描述</span>
						<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
					</label>
					{create.error && <ErrorNotice error={create.error} />}
					<div className="form-actions">
						<button type="button" className="button secondary" onClick={() => setCreating(false)}>
							取消
						</button>
						<button type="submit" className="button primary" disabled={!title.trim() || create.isPending}>
							创建任务
						</button>
					</div>
				</form>
			)}
			{tasks.isLoading && <LoadingBlock label="正在加载任务" />}
			{tasks.error && <ErrorNotice error={tasks.error} />}
			{update.error && <ErrorNotice error={update.error} />}
			<div className="task-board">
				{COLUMNS.map((column) => {
					const columnTasks = visibleTasks.filter((task) => task.status === column.status);
					return (
						<section className="task-column" key={column.status}>
							<header>
								<div>
									<span className={`status-dot column-${column.status}`} />
									<strong>{column.label}</strong>
								</div>
								<span>{columnTasks.length}</span>
							</header>
							<div>
								{columnTasks.map((task) => (
									<article className="task-card" key={task.id}>
										<div className="task-card-title">
											<span className={`owner-badge owner-${task.type}`}>
												{task.type === "agent" ? <Icons.Spark /> : "我"}
											</span>
											<strong>{task.title}</strong>
										</div>
										{task.description && <p>{task.description}</p>}
										<div className="task-card-meta">
											<span>
												{projects.data?.find((project) => project.id === task.projectId)?.name ?? "个人"}
											</span>
											<span>P{task.priority}</span>
										</div>
										<div className="task-card-actions">
											<select
												aria-label={`任务状态 ${task.title}`}
												disabled={
													update.isPending ||
													Boolean(task.cleanupRequestedAt) ||
													task.execution?.status === "queued" ||
													task.execution?.status === "running"
												}
												value={task.status}
												onChange={(event) =>
													update.mutate({ task, status: event.target.value as WorkbenchTask["status"] })
												}
											>
												{COLUMNS.map((option) => (
													<option key={option.status} value={option.status}>
														{option.label}
													</option>
												))}
											</select>
											<TaskExecutionActions task={task} onDelegate={() => setDelegate(task)} />
										</div>
									</article>
								))}
							</div>
						</section>
					);
				})}
			</div>
			{!tasks.isLoading && visibleTasks.length === 0 && !creating && (
				<EmptyState title="当前没有任务" description="为自己创建任务，或把项目任务交给个人助手。" />
			)}
			{delegate && (
				<TaskExecutionDialog
					task={delegate}
					project={projects.data?.find((project) => project.id === delegate.projectId)}
					onClose={() => setDelegate(undefined)}
				/>
			)}
			{cleaning && <TaskCleanupDialog projectId={filterProject || undefined} onClose={() => setCleaning(false)} />}
		</div>
	);
}
