import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from "react-router";
import { api, type Project, type WorkbenchTask } from "./api.ts";
import { ChatPage } from "./chat-page.tsx";
import { ProjectFiles } from "./files-page.tsx";
import { Icons } from "./icons.tsx";
import { label, profileName } from "./labels.ts";
import { ProjectDeleteButton } from "./project-delete.tsx";
import { TaskCleanupDialog, TaskExecutionActions, TaskExecutionDialog } from "./task-dialogs.tsx";
import { EmptyState, ErrorNotice, formatRelative, LoadingBlock, PageHeader, StatusPill } from "./ui.tsx";

export function ProjectsPage() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	const [creating, setCreating] = useState(false);
	const [sourcePath, setSourcePath] = useState("");
	const pickerController = useRef<AbortController | undefined>(undefined);
	useEffect(() => () => pickerController.current?.abort(), []);
	const pickDirectory = useMutation({
		mutationFn: (controller: AbortController) => api.pickProjectDirectory(controller.signal),
		onSuccess: ({ path }, controller) => {
			if (!controller.signal.aborted && path) setSourcePath(path);
		},
	});
	const browse = () => {
		if (pickerController.current && !pickerController.current.signal.aborted && pickDirectory.isPending) return;
		setCreating(true);
		setSourcePath("");
		const controller = new AbortController();
		pickerController.current = controller;
		pickDirectory.mutate(controller);
	};
	const cancel = () => {
		pickerController.current?.abort();
		pickDirectory.reset();
		setSourcePath("");
		setCreating(false);
	};
	const createProject = useMutation({
		mutationFn: () => api.createProject({ sourcePath: sourcePath.trim() }),
		onSuccess: async (project) => {
			setSourcePath("");
			setCreating(false);
			await queryClient.invalidateQueries({ queryKey: ["projects"] });
			navigate(`/projects/${project.id}`);
		},
	});
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (sourcePath.trim() && !pickDirectory.isPending && !createProject.isPending) createProject.mutate();
	};
	return (
		<div className="page-container">
			<PageHeader
				eyebrow="项目工作区"
				title="项目"
				description="每个项目拥有独立的会话、任务、记忆、文件、成果和助手上下文。"
				actions={
					<button
						type="button"
						className="button primary with-icon"
						disabled={pickDirectory.isPending || createProject.isPending}
						onClick={browse}
					>
						<Icons.Plus />
						打开文件夹为项目
					</button>
				}
			/>
			{creating && (
				<form className="create-panel" onSubmit={submit}>
					<div>
						<span className="eyebrow">新建项目</span>
						<h2>选择已有项目文件夹</h2>
					</div>
					<div className="project-directory-picker">
						<label>
							<span>已有项目目录</span>
							<input
								aria-label="已有项目目录"
								value={sourcePath}
								readOnly
								placeholder="点击右侧按钮选择本机文件夹"
							/>
						</label>
						<button
							type="button"
							className="button secondary"
							disabled={createProject.isPending || pickDirectory.isPending}
							onClick={browse}
						>
							{pickDirectory.isPending ? "正在选择…" : "浏览文件夹…"}
						</button>
						<small>项目名称取文件夹名称。助手默认在所选目录工作；会话创建时再选择助手。</small>
						{sourcePath && (
							<label>
								<span>项目名称</span>
								<input
									aria-label="项目名称"
									readOnly
									value={
										sourcePath
											.replace(/[\\/]+$/u, "")
											.split(/[\\/]/u)
											.at(-1) ?? ""
									}
								/>
							</label>
						)}
						{pickDirectory.isPending && <output>请在系统弹窗中选择文件夹；取消会关闭弹窗。</output>}
						{pickDirectory.error && <ErrorNotice error={pickDirectory.error} />}
					</div>
					{createProject.error && <ErrorNotice error={createProject.error} />}
					<div className="form-actions">
						<button
							type="button"
							className="button secondary"
							disabled={createProject.isPending}
							onClick={cancel}
						>
							取消
						</button>
						<button
							type="submit"
							className="button primary"
							disabled={createProject.isPending || pickDirectory.isPending || !sourcePath.trim()}
						>
							创建项目
						</button>
					</div>
				</form>
			)}
			{projects.isLoading && <LoadingBlock label="正在加载项目" />}
			{projects.error && <ErrorNotice error={projects.error} />}
			<div className="project-grid">
				{projects.data?.map((project) => (
					<article className="project-card" key={project.id}>
						<div className="project-card-top">
							<span className="project-glyph">{project.name.slice(0, 2).toUpperCase()}</span>
							<StatusPill value={project.status} />
						</div>
						<h2>
							{project.deletionPending ? (
								project.name
							) : (
								<Link to={`/projects/${project.id}`}>{project.name}</Link>
							)}
						</h2>
						<p>{project.description || "个人工作台项目"}</p>
						<div className="project-meta">
							<span>{project.slug}</span>
							<span>更新于 {formatRelative(project.updatedAt)}</span>
						</div>
						<div className="project-card-actions">
							{project.deletionPending ? (
								<span>删除未完成</span>
							) : (
								<Link to={`/projects/${project.id}`} className="project-open">
									打开工作区 <Icons.Chevron />
								</Link>
							)}
							<ProjectDeleteButton project={project} compact={!project.deletionPending} />
						</div>
					</article>
				))}
			</div>
			{!projects.isLoading && projects.data?.length === 0 && !creating && (
				<EmptyState
					title="创建第一个项目"
					description="项目集中管理助手上下文、会话、任务、记忆和文件。"
					action={
						<button type="button" className="button primary" onClick={browse}>
							创建项目
						</button>
					}
				/>
			)}
		</div>
	);
}

export function ProjectLayout() {
	const { projectId } = useParams();
	const project = useQuery({
		queryKey: ["project", projectId],
		queryFn: () => api.project(projectId!),
		enabled: Boolean(projectId),
	});
	if (project.isLoading) return <LoadingBlock label="正在打开项目" />;
	if (project.error)
		return (
			<div className="page-container">
				<ErrorNotice error={project.error} />
			</div>
		);
	if (!project.data) return null;
	return (
		<div className="project-layout">
			<header className="project-header">
				<div className="project-title">
					<span className="project-glyph">{project.data.name.slice(0, 2).toUpperCase()}</span>
					<div>
						<span className="eyebrow">项目工作区</span>
						<h1>{project.data.name}</h1>
						<span className="project-source-path" title={project.data.sourcePath ?? project.data.workspacePath}>
							{project.data.sourcePath ?? project.data.workspacePath}
						</span>
					</div>
					<StatusPill value={project.data.status} />
					<ProjectDeleteButton project={project.data} />
				</div>
				<nav className="project-tabs">
					<NavLink end to=".">
						概览
					</NavLink>
					<NavLink to="chat">对话</NavLink>
					<NavLink to="tasks">任务</NavLink>
					<NavLink to="files">文件</NavLink>
					<NavLink to="memory">记忆</NavLink>
					<NavLink to="knowledge">知识库</NavLink>
				</nav>
			</header>
			<div className="project-content">
				<Outlet context={project.data} />
			</div>
		</div>
	);
}

function useProject(): Project {
	return useOutletContext<Project>();
}

export function ProjectOverview() {
	const project = useProject();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
	const [profileId, setProfileId] = useState("");
	const selectedProfile = profiles.data?.find((profile) => profile.id === profileId);
	const launch = useMutation({
		mutationFn: () => api.createSession({ projectId: project.id, profileId }),
		onSuccess: async (session) => {
			await queryClient.invalidateQueries({ queryKey: ["sessions"] });
			navigate(`chat?session=${session.id}`);
		},
	});
	const tasks = useQuery({ queryKey: ["tasks", project.id], queryFn: () => api.tasks(project.id) });
	const sessions = useQuery({ queryKey: ["sessions", project.id], queryFn: () => api.sessions(project.id) });
	const artifacts = useQuery({ queryKey: ["artifacts", project.id], queryFn: () => api.artifacts(project.id) });
	return (
		<div className="project-overview">
			<section className="project-hero">
				<div>
					<span className="eyebrow">当前重点</span>
					<h2>{project.description || "确定项目的下一个目标。"}</h2>
					<p>
						助手工作目录： <code>{project.sourcePath ?? project.workspacePath}</code>
					</p>
					{project.sourcePath && (
						<p>
							工作台资料目录：<code>{project.workspacePath}</code>
						</p>
					)}
				</div>
				<div className="project-start-controls">
					<label>
						启动助手预设
						<select
							value={profileId}
							aria-label="启动助手预设"
							disabled={launch.isPending}
							onChange={(event) => setProfileId(event.target.value)}
						>
							<option value="">请选择助手预设</option>
							{profiles.data?.map((profile) => (
								<option key={profile.id} value={profile.id}>
									{profileName(profile)}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						className="button primary with-icon"
						disabled={!selectedProfile || launch.isPending}
						onClick={() => launch.mutate()}
					>
						<Icons.Spark />
						{launch.isPending ? "正在启动…" : "启动助手"}
					</button>
				</div>
			</section>
			{launch.error && <ErrorNotice error={launch.error} />}
			{profiles.error && <ErrorNotice error={profiles.error} />}
			<div className="metric-row">
				<div>
					<span>未完成任务</span>
					<strong>{tasks.data?.filter((task) => !["done", "cancelled"].includes(task.status)).length ?? 0}</strong>
				</div>
				<div>
					<span>会话</span>
					<strong>{sessions.data?.length ?? 0}</strong>
				</div>
				<div>
					<span>成果</span>
					<strong>{artifacts.data?.length ?? 0}</strong>
				</div>
				<div>
					<span>最近活跃</span>
					<strong className="metric-copy">{formatRelative(project.updatedAt)}</strong>
				</div>
			</div>
			<div className="overview-grid">
				<section className="content-card">
					<div className="card-heading">
						<h3>接下来要做</h3>
						<Link to="tasks">查看全部</Link>
					</div>
					{tasks.data?.slice(0, 5).map((task) => (
						<div className="compact-row" key={task.id}>
							<span className={`task-check ${task.status === "done" ? "checked" : ""}`}>
								{task.status === "done" && <Icons.Check />}
							</span>
							<span>
								<strong>{task.title}</strong>
								<small>
									{label(task.status)} · 优先级 {task.priority}
								</small>
							</span>
						</div>
					))}
					{tasks.data?.length === 0 && <p className="quiet-copy">暂无任务。</p>}
				</section>
				<section className="content-card">
					<div className="card-heading">
						<h3>最近会话</h3>
						<Link to="chat">打开对话</Link>
					</div>
					{sessions.data?.slice(0, 5).map((session) => (
						<Link to={`chat?session=${session.id}`} className="compact-row" key={session.id}>
							<span className="round-icon">
								<Icons.Chat />
							</span>
							<span>
								<strong>{label(session.title)}</strong>
								<small>{formatRelative(session.lastActiveAt)}</small>
							</span>
							<StatusPill value={session.status} />
						</Link>
					))}
					{sessions.data?.length === 0 && <p className="quiet-copy">暂无项目会话。</p>}
				</section>
			</div>
		</div>
	);
}

export function ProjectChat() {
	const project = useProject();
	return <ChatPage lockedProjectId={project.id} />;
}

export function ProjectTasks() {
	const queryClient = useQueryClient();
	const project = useProject();
	const tasks = useQuery({
		queryKey: ["tasks", project.id],
		queryFn: () => api.tasks(project.id),
		refetchInterval: 3000,
	});
	const [title, setTitle] = useState("");
	const [delegate, setDelegate] = useState<WorkbenchTask>();
	const [cleaning, setCleaning] = useState(false);
	const update = useMutation({
		mutationFn: (task: WorkbenchTask) => api.updateTask(task, { status: task.status === "done" ? "todo" : "done" }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
	});
	const create = useMutation({
		mutationFn: () => api.createTask({ projectId: project.id, title }),
		onSuccess: async () => {
			setTitle("");
			await queryClient.invalidateQueries({ queryKey: ["tasks", project.id] });
		},
	});
	return (
		<div className="project-subpage">
			<div className="subpage-heading">
				<div>
					<span className="eyebrow">项目任务</span>
					<h2>推进 {project.name} 的工作</h2>
				</div>
				<form
					className="quick-add"
					onSubmit={(event) => {
						event.preventDefault();
						if (title.trim()) create.mutate();
					}}
				>
					<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="添加任务…" />
					<button type="submit" className="icon-button" aria-label="添加任务">
						<Icons.Plus />
					</button>
				</form>
			</div>
			<button type="button" className="button secondary" onClick={() => setCleaning(true)}>
				清理已完成任务
			</button>
			{create.error && <ErrorNotice error={create.error} />}
			{update.error && <ErrorNotice error={update.error} />}
			{tasks.error && <ErrorNotice error={tasks.error} />}
			{tasks.isLoading && <LoadingBlock label="正在加载任务" />}
			<div className="task-list-card">
				{tasks.data?.map((task) => (
					<div className="task-row" key={task.id}>
						<button
							type="button"
							className={`task-check ${task.status === "done" ? "checked" : ""}`}
							aria-label={task.status === "done" ? `重新打开 ${task.title}` : `确认完成 ${task.title}`}
							disabled={
								update.isPending ||
								Boolean(task.cleanupRequestedAt) ||
								task.execution?.status === "queued" ||
								task.execution?.status === "running"
							}
							onClick={() => update.mutate(task)}
						>
							{task.status === "done" && <Icons.Check />}
						</button>
						<span>
							<strong>{task.title}</strong>
							<small>{task.description || `${label(task.type)}任务`}</small>
						</span>
						<StatusPill value={task.status} />
						<span className="priority-label">P{task.priority}</span>
						<TaskExecutionActions task={task} onDelegate={() => setDelegate(task)} />
					</div>
				))}
				{tasks.data?.length === 0 && <EmptyState title="暂无任务" description="为项目添加下一步任务。" />}
			</div>
			{delegate && <TaskExecutionDialog task={delegate} project={project} onClose={() => setDelegate(undefined)} />}
			{cleaning && <TaskCleanupDialog projectId={project.id} onClose={() => setCleaning(false)} />}
		</div>
	);
}

export function ProjectFilesRoute() {
	const project = useProject();
	return (
		<div className="project-subpage file-subpage">
			<ProjectFiles slug={project.slug} projectId={project.id} sourcePath={project.sourcePath} />
		</div>
	);
}

export function ProjectMemory() {
	const queryClient = useQueryClient();
	const project = useProject();
	const path = `projects/${project.slug}/AGENTS.md`;
	const file = useQuery({ queryKey: ["file", path], queryFn: () => api.file(path) });
	const [draft, setDraft] = useState<string>();
	const content = draft ?? file.data?.content ?? "";
	const save = useMutation({
		mutationFn: () =>
			api.editMemory({
				path,
				content,
				expectedHash: file.data!.contentHash,
				kind: "project",
				projectId: project.id,
			}),
		onSuccess: async () => {
			setDraft(undefined);
			await queryClient.invalidateQueries({ queryKey: ["file", path] });
		},
	});
	return (
		<div className="project-subpage memory-workspace">
			<div className="subpage-heading">
				<div>
					<span className="eyebrow">Markdown 原文</span>
					<h2>项目记忆</h2>
					<p>
						项目概况、约束与经验统一保存在 AGENTS.md，后台自动提炼重要信息。可复用流程保存在工作台资料的 skills
						文件夹中。
					</p>
				</div>
				<button
					type="button"
					className="button primary"
					disabled={!file.data || draft === undefined || save.isPending}
					onClick={() => save.mutate()}
				>
					保存记忆
				</button>
			</div>
			{file.isLoading && <LoadingBlock label="正在加载记忆" />}
			{file.error && <ErrorNotice error={file.error} />}
			{save.error && <ErrorNotice error={save.error} />}
			{file.data && (
				<textarea
					className="memory-editor"
					value={content}
					onChange={(event) => setDraft(event.target.value)}
					spellCheck={false}
				/>
			)}
		</div>
	);
}

export { ProjectKnowledge } from "./knowledge-page.tsx";
