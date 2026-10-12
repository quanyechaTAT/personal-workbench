import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api, type Project, type WorkbenchSession } from "./api.ts";
import { Icons } from "./icons.tsx";
import { label } from "./labels.ts";
import { ProjectDeleteButton } from "./project-delete.tsx";
import { ErrorNotice, formatRelative, LoadingBlock } from "./ui.tsx";
import "./session-sidebar.css";

interface SessionActions {
	selectedSessionId?: string;
	menuId?: string;
	actionPending: boolean;
	onSelect(session: WorkbenchSession): void;
	onMenu(id?: string): void;
	onRename(session: WorkbenchSession): void;
	onAction(session: WorkbenchSession, action: "archive" | "restore" | "delete"): void;
}

function SessionEntry({ session, actions }: { session: WorkbenchSession; actions: SessionActions }) {
	return (
		<div className="session-entry">
			<button
				type="button"
				onClick={() => actions.onSelect(session)}
				aria-current={session.id === actions.selectedSessionId ? "page" : undefined}
				className={`session-item${session.id === actions.selectedSessionId ? " selected" : ""}`}
			>
				<span className="session-icon">
					<Icons.Chat />
				</span>
				<span>
					<strong>{label(session.title)}</strong>
					<small>{formatRelative(session.lastActiveAt)}</small>
				</span>
				<i className={`status-dot ${session.status === "running" ? "working" : ""}`} />
			</button>
			<button
				type="button"
				className="session-menu-trigger icon-button"
				aria-label={`会话操作 ${label(session.title)}`}
				onClick={() => actions.onMenu(actions.menuId === session.id ? undefined : session.id)}
				aria-expanded={actions.menuId === session.id}
			>
				•••
			</button>
			{actions.menuId === session.id && (
				<div className="session-action-menu">
					<button type="button" disabled={actions.actionPending} onClick={() => actions.onRename(session)}>
						重命名会话
					</button>
					<button
						type="button"
						disabled={session.status === "running" || actions.actionPending}
						onClick={() => actions.onAction(session, session.archivedAt ? "restore" : "archive")}
					>
						{session.archivedAt ? "恢复会话" : "归档会话"}
					</button>
					<button
						type="button"
						className="danger-text"
						disabled={session.status === "running" || actions.actionPending}
						onClick={() => actions.onAction(session, "delete")}
					>
						删除会话
					</button>
					{session.status === "running" && <small>归档或删除前请先停止运行</small>}
				</div>
			)}
		</div>
	);
}

export function SessionSidebar({
	projects,
	sessions,
	loading,
	error,
	view,
	onView,
	newSessionPending,
	onNewSession,
	actions,
}: {
	projects: Project[];
	sessions: WorkbenchSession[];
	loading: boolean;
	error?: unknown;
	view: "active" | "archived";
	onView(view: "active" | "archived"): void;
	newSessionPending: boolean;
	onNewSession(projectId?: string): void;
	actions: SessionActions;
}) {
	const client = useQueryClient();
	const pickerController = useRef<AbortController | undefined>(undefined);
	const [collapsed, setCollapsed] = useState(new Set<string>());
	useEffect(() => () => pickerController.current?.abort(), []);
	const ordered = useMemo(
		() => [...sessions].sort((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt)),
		[sessions],
	);
	const groups = useMemo(() => {
		const result = new Map<string, { id: string; name: string; project?: Project; sessions: WorkbenchSession[] }>(
			projects.map((project) => [project.id, { id: project.id, name: project.name, project, sessions: [] }]),
		);
		for (const session of ordered) {
			if (!session.projectId) continue;
			let group = result.get(session.projectId);
			if (!group) {
				group = { id: session.projectId, name: "项目不可用", project: undefined, sessions: [] };
				result.set(session.projectId, group);
			}
			group.sessions.push(session);
		}
		return [...result.values()].sort(
			(left, right) =>
				Date.parse(right.sessions[0]?.lastActiveAt ?? right.project?.updatedAt ?? "1970-01-01") -
					Date.parse(left.sessions[0]?.lastActiveAt ?? left.project?.updatedAt ?? "1970-01-01") ||
				left.name.localeCompare(right.name),
		);
	}, [projects, ordered]);
	const selectedProjectId = sessions.find((session) => session.id === actions.selectedSessionId)?.projectId;
	useEffect(() => {
		if (actions.selectedSessionId && selectedProjectId)
			setCollapsed((current) => {
				if (!current.has(selectedProjectId)) return current;
				const next = new Set(current);
				next.delete(selectedProjectId);
				return next;
			});
	}, [actions.selectedSessionId, selectedProjectId]);
	const createProject = useMutation({
		mutationFn: async (controller: AbortController) => {
			const { path } = await api.pickProjectDirectory(controller.signal);
			if (!path || controller.signal.aborted) return undefined;
			return api.createProject({ sourcePath: path });
		},
		onSuccess: async (project, controller) => {
			if (!project || controller.signal.aborted) return;
			client.setQueryData<Project[]>(["projects"], (current) => [
				...(current ?? []).filter((item) => item.id !== project.id),
				project,
			]);
			onNewSession(project.id);
			await Promise.all([
				client.invalidateQueries({ queryKey: ["projects"] }),
				client.invalidateQueries({ queryKey: ["home"] }),
			]);
		},
		onSettled: (_project, _error, controller) => {
			if (pickerController.current === controller) pickerController.current = undefined;
		},
	});
	const ordinary = ordered.filter((session) => !session.projectId);
	return (
		<aside className="session-sidebar" aria-label="会话列表">
			<div className="panel-heading">
				<div>
					<strong>会话</strong>
				</div>
			</div>
			<button
				type="button"
				className="new-chat-button"
				aria-label="新建会话"
				title="新建普通会话"
				disabled={newSessionPending}
				onClick={() => onNewSession()}
			>
				<Icons.Edit />
				新聊天
			</button>
			<section className="session-tabs" aria-label="会话筛选">
				<button type="button" aria-pressed={view === "active"} onClick={() => onView("active")}>
					进行中
				</button>
				<button type="button" aria-pressed={view === "archived"} onClick={() => onView("archived")}>
					已归档
				</button>
			</section>
			<div className="session-list grouped-session-list">
				{loading && <LoadingBlock label="正在加载会话" />}
				{error != null && <ErrorNotice error={error} />}
				<div className="session-section-heading">
					<h3>项目</h3>
					<button
						type="button"
						className="icon-button"
						aria-label="新建项目"
						title="选择本机文件夹作为项目"
						disabled={createProject.isPending}
						onClick={() => {
							if (pickerController.current && !pickerController.current.signal.aborted) return;
							const controller = new AbortController();
							pickerController.current = controller;
							createProject.mutate(controller);
						}}
					>
						<Icons.Plus />
					</button>
				</div>
				{createProject.isPending && (
					<div className="sidebar-project-picker">
						<output>请在系统弹窗中选择项目文件夹…</output>
						<button
							type="button"
							className="button secondary"
							onClick={() => {
								pickerController.current?.abort();
								createProject.reset();
							}}
						>
							取消选择
						</button>
					</div>
				)}
				{createProject.error && !pickerController.current?.signal.aborted && (
					<ErrorNotice error={createProject.error} />
				)}
				{groups.map((group) => (
					<section key={group.id} className="project-session-group" aria-label={`项目 ${group.name}`}>
						<header className="project-session-heading">
							<button
								type="button"
								className="project-group-toggle"
								aria-label={`${collapsed.has(group.id) ? "展开" : "折叠"}项目 ${group.name}`}
								aria-expanded={!collapsed.has(group.id)}
								aria-controls={`project-chats-${group.id}`}
								onClick={() =>
									setCollapsed((current) => {
										const next = new Set(current);
										if (next.has(group.id)) next.delete(group.id);
										else next.add(group.id);
										return next;
									})
								}
							>
								<Icons.Chevron />
							</button>
							{group.project ? (
								<Link
									to={`/projects/${group.id}`}
									className="project-group-name"
									title={group.project.sourcePath ?? group.project.workspacePath}
								>
									<Icons.Project />
									<span>{group.name}</span>
								</Link>
							) : (
								<span className="project-group-name">
									<Icons.Project />
									<span>{group.name}</span>
								</span>
							)}
							<button
								type="button"
								className="icon-button project-new-chat"
								aria-label={`新建项目会话 ${group.name}`}
								title="新建项目会话"
								disabled={!group.project || group.project.deletionPending || newSessionPending}
								onClick={() => onNewSession(group.id)}
							>
								<Icons.Plus />
							</button>
							{group.project && <ProjectDeleteButton project={group.project} compact />}
						</header>
						<div
							id={`project-chats-${group.id}`}
							className="project-session-items"
							hidden={collapsed.has(group.id)}
						>
							{group.sessions.map((session) => (
								<SessionEntry key={session.id} session={session} actions={actions} />
							))}
							{!group.sessions.length && (
								<p className="session-group-empty">{view === "archived" ? "暂无归档会话" : "暂无会话"}</p>
							)}
						</div>
					</section>
				))}
				{!loading && !groups.length && <p className="session-group-empty">暂无项目，点击 + 选择文件夹。</p>}
				<section className="ordinary-session-group" aria-label="普通会话">
					<div className="session-section-heading">
						<h3>普通会话</h3>
					</div>
					{ordinary.map((session) => (
						<SessionEntry key={session.id} session={session} actions={actions} />
					))}
					{!loading && !ordinary.length && (
						<p className="session-group-empty">
							{view === "archived" ? "暂无归档会话" : "暂无会话，点击新聊天开始。"}
						</p>
					)}
				</section>
			</div>
		</aside>
	);
}
