import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type WorkbenchTask } from "./api.ts";
import { Icons } from "./icons.tsx";
import { label } from "./labels.ts";
import { ErrorNotice, formatRelative, LoadingBlock, StatusPill } from "./ui.tsx";

export function HomePage() {
	const queryClient = useQueryClient();
	const home = useQuery({ queryKey: ["home"], queryFn: api.home, refetchInterval: 30_000 });
	const updateTask = useMutation({
		mutationFn: (task: WorkbenchTask) => api.updateTask(task, { status: task.status === "done" ? "todo" : "done" }),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["home"] }),
				queryClient.invalidateQueries({ queryKey: ["tasks"] }),
			]);
		},
	});
	if (home.isLoading) return <LoadingBlock label="正在打开工作台" />;
	if (home.error)
		return (
			<div className="page-container">
				<ErrorNotice error={home.error} />
			</div>
		);
	const data = home.data;
	if (!data) return null;
	const projectName = (id?: string) => data.projects.find((project) => project.id === id)?.name ?? "普通会话";
	return (
		<div className="page-container home-page">
			<header className="home-heading">
				<div>
					<span className="home-date">
						{new Intl.DateTimeFormat("zh-CN", { weekday: "long", month: "long", day: "numeric" }).format(
							new Date(),
						)}
					</span>
					<h1>工作台</h1>
					<p>继续最近的对话，或开始新的工作。</p>
				</div>
				<div className="header-actions">
					<Link className="button secondary with-icon" to="/projects">
						<Icons.Project /> 打开项目
					</Link>
					<Link className="button primary with-icon" to="/chat?draft=1">
						<Icons.Plus /> 新对话
					</Link>
				</div>
			</header>
			{updateTask.error && <ErrorNotice error={updateTask.error} />}
			<div className="home-grid">
				<section className="home-card sessions-card">
					<header className="home-card-heading">
						<h2>
							<Icons.Chat /> 最近会话
						</h2>
						<Link to="/chat">
							全部会话 <Icons.Chevron />
						</Link>
					</header>
					<div className="home-list">
						{data.sessions.map((session) => (
							<Link className="home-session" to={`/chat?session=${session.id}`} key={session.id}>
								<span className="round-icon">
									<Icons.Chat />
								</span>
								<span>
									<strong>{label(session.title)}</strong>
									<small>
										{projectName(session.projectId)} · {formatRelative(session.lastActiveAt)}
									</small>
								</span>
								<StatusPill value={session.status} />
							</Link>
						))}
						{data.sessions.length === 0 && (
							<div className="home-empty">
								<p>还没有对话</p>
								<Link to="/chat?draft=1">
									选择助手，开始第一个对话 <Icons.Chevron />
								</Link>
							</div>
						)}
					</div>
				</section>

				<section className="home-card projects-card">
					<header className="home-card-heading">
						<h2>
							<Icons.Project /> 项目
						</h2>
						<Link to="/projects">
							管理项目 <Icons.Chevron />
						</Link>
					</header>
					<div className="home-projects">
						{data.projects.map((project) => (
							<Link to={`/projects/${project.id}`} key={project.id}>
								<span className="project-glyph">
									<Icons.Project />
								</span>
								<span>
									<strong>{project.name}</strong>
									<small>{project.description || project.sourcePath || "项目工作区"}</small>
								</span>
								<Icons.Chevron />
							</Link>
						))}
						{data.projects.length === 0 && (
							<div className="home-empty">
								<p>还没有项目</p>
								<Link to="/projects">
									打开文件夹作为项目 <Icons.Chevron />
								</Link>
							</div>
						)}
					</div>
				</section>

				<section className="home-card today-card">
					<header className="home-card-heading">
						<h2>
							<Icons.Task /> 待办任务
						</h2>
						<Link to="/tasks">
							全部任务 <Icons.Chevron />
						</Link>
					</header>
					<div className="home-list">
						{data.tasks.map((task) => (
							<div className="home-task" key={task.id}>
								<button
									type="button"
									className={`task-check${task.status === "done" ? " checked" : ""}`}
									onClick={() => updateTask.mutate(task)}
									disabled={
										updateTask.isPending ||
										Boolean(task.cleanupRequestedAt) ||
										task.execution?.status === "running" ||
										task.execution?.status === "queued"
									}
									aria-label={`将 ${task.title} 标记为${task.status === "done" ? "待办" : "完成"}`}
								>
									{task.status === "done" && <Icons.Check />}
								</button>
								<span>
									<strong>{task.title}</strong>
									<small>
										{task.projectId ? projectName(task.projectId) : "个人任务"} · P{task.priority}
									</small>
								</span>
								<StatusPill value={task.status} />
							</div>
						))}
						{data.tasks.length === 0 && <p className="home-empty">暂无待办任务。</p>}
					</div>
				</section>

				{data.artifacts.length > 0 && (
					<section className="home-card artifacts-card">
						<header className="home-card-heading">
							<h2>
								<Icons.File /> 最近成果
							</h2>
							<Link to="/files">
								浏览文件 <Icons.Chevron />
							</Link>
						</header>
						<div className="home-artifacts">
							{data.artifacts.map((artifact) => (
								<Link to={`/files?path=${encodeURIComponent(artifact.relativePath)}`} key={artifact.id}>
									<span className="round-icon">
										<Icons.File />
									</span>
									<span>
										<strong>{artifact.name}</strong>
										<small>
											{label(artifact.type)} · {formatRelative(artifact.createdAt)}
										</small>
									</span>
									<Icons.Chevron />
								</Link>
							))}
						</div>
					</section>
				)}
			</div>
		</div>
	);
}
