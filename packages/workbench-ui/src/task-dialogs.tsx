import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type Project, type WorkbenchTask } from "./api.ts";
import { Icons } from "./icons.tsx";
import { label, profileName } from "./labels.ts";
import { ErrorNotice, LoadingBlock } from "./ui.tsx";
import "./session-title-dialog.css";
import "./task-dialogs.css";

function TaskDialog({
	title,
	pending,
	onClose,
	children,
}: {
	title: string;
	pending: boolean;
	onClose(): void;
	children: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		return () => {
			element?.close();
		};
	}, []);
	return (
		<dialog
			ref={dialog}
			className="session-title-dialog task-dialog"
			aria-label={title}
			onCancel={(event) => {
				event.preventDefault();
				if (!pending) onClose();
			}}
		>
			<h2>{title}</h2>
			{children}
		</dialog>
	);
}

export function TaskExecutionDialog({
	task,
	project,
	onClose,
}: {
	task: WorkbenchTask;
	project?: Project;
	onClose(): void;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
	const [profileId, setProfileId] = useState(project?.defaultProfileId ?? "");
	const selected = profiles.data?.find((profile) => profile.id === profileId);
	const start = useMutation({
		mutationFn: () => api.startTask(task, profileId),
		onSuccess: async (result) => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["tasks"] }),
				queryClient.invalidateQueries({ queryKey: ["sessions"] }),
			]);
			onClose();
			navigate(`/chat?session=${result.session.id}&run=${result.runId}`);
		},
	});
	return (
		<TaskDialog title="交给助手执行" pending={start.isPending} onClose={onClose}>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (selected && !start.isPending) start.mutate();
				}}
			>
				<strong>{task.title}</strong>
				<p className="task-description">{task.description || "按照任务标题完成工作并汇报结果。"}</p>
				<p>工作目录：{project?.sourcePath ?? project?.workspacePath ?? "个人工作区"}</p>
				<label className="field">
					执行助手
					<select
						required
						aria-label="执行助手"
						value={profileId}
						disabled={start.isPending}
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
				{selected && (
					<p>
						{selected.description}
						<br />
						模型：
						{selected.defaultModel
							? `${selected.defaultModel.provider} / ${selected.defaultModel.modelId}`
							: "工作台默认模型"}
					</p>
				)}
				<p>启动后可在对话中查看过程、批准工具或停止。助手忙碌时任务排队，成功后进入“待确认”，由你确认完成。</p>
				{profiles.isLoading && <LoadingBlock label="正在加载助手" />}
				{profiles.error && <ErrorNotice error={profiles.error} />}
				{start.error && <ErrorNotice error={start.error} />}
				<div className="card-actions">
					<button type="button" className="button secondary" disabled={start.isPending} onClick={onClose}>
						取消
					</button>
					<button type="submit" className="button primary" disabled={!selected || start.isPending}>
						{start.isPending ? "正在启动…" : "开始执行"}
					</button>
				</div>
			</form>
		</TaskDialog>
	);
}

export function TaskCleanupDialog({ projectId, onClose }: { projectId?: string; onClose(): void }) {
	const queryClient = useQueryClient();
	const [days, setDays] = useState("30");
	const [deleteHistory, setDeleteHistory] = useState(true);
	const preview = useMutation({
		mutationFn: () =>
			api.previewTaskCleanup({
				projectId,
				completedBefore: new Date(Date.now() - Number(days) * 86400000).toISOString(),
			}),
	});
	const cleanup = useMutation({
		mutationFn: () => api.cleanupTasks(preview.data!.tasks, deleteHistory),
		onSuccess: async () => {
			for (const key of ["tasks", "sessions", "home", "artifacts", "activity"])
				await queryClient.invalidateQueries({ queryKey: [key] });
		},
	});
	const resetPreview = () => {
		preview.reset();
		cleanup.reset();
	};
	return (
		<TaskDialog title="清理已完成任务" pending={cleanup.isPending} onClose={onClose}>
			<label className="field">
				完成时间范围
				<select
					value={days}
					aria-label="完成时间范围"
					disabled={cleanup.isPending}
					onChange={(event) => {
						setDays(event.target.value);
						resetPreview();
					}}
				>
					<option value="30">30 天前完成</option>
					<option value="7">7 天前完成</option>
					<option value="0">全部已完成任务</option>
				</select>
			</label>
			<label className="cleanup-option">
				<input
					type="checkbox"
					checked={deleteHistory}
					disabled={cleanup.isPending}
					onChange={(event) => setDeleteHistory(event.target.checked)}
				/>
				同时删除任务专用会话及对话历史
			</label>
			<p>
				仅清理已完成且没有未完成子任务的任务。项目、源文件、成果文件和记忆会保留；清理会压缩数据库。执行中请先停止助手。
			</p>
			{!preview.data && (
				<button
					type="button"
					className="button secondary"
					disabled={preview.isPending}
					onClick={() => preview.mutate()}
				>
					{preview.isPending ? "正在检查…" : "预览清理范围"}
				</button>
			)}
			{preview.data && !cleanup.data && (
				<>
					{preview.data.totalTaskCount > 500 && (
						<p>
							共有 {preview.data.totalTaskCount} 个符合条件的任务，本次先清理 500 个；完成后可继续预览下一批。
						</p>
					)}
					<p>
						将删除 {preview.data.tasks.length} 条任务记录和执行记录
						{deleteHistory ? `，以及 ${preview.data.sessionCount} 个任务专用会话` : "，保留会话和对话历史"}
						。删除无法撤销。
					</p>
					<ul className="cleanup-preview">
						{preview.data.tasks.map((task) => (
							<li key={task.id}>{task.title}</li>
						))}
					</ul>
					{deleteHistory && preview.data.sessions.length > 0 && (
						<details>
							<summary>会话删除范围</summary>
							<ul>
								{preview.data.sessions.map((session) => (
									<li key={session.id}>{session.title}</li>
								))}
							</ul>
						</details>
					)}
				</>
			)}
			{cleanup.data && (
				<output>
					已清理 {cleanup.data.deletedTasks} 个任务、{cleanup.data.deletedSessions} 个会话，数据库已压缩。
				</output>
			)}
			{preview.error && <ErrorNotice error={preview.error} />}
			{cleanup.error && <ErrorNotice error={cleanup.error} />}
			<div className="card-actions">
				{cleanup.data && (
					<button type="button" className="button secondary" onClick={resetPreview}>
						继续预览
					</button>
				)}
				<button type="button" className="button secondary" disabled={cleanup.isPending} onClick={onClose}>
					{cleanup.data ? "关闭" : "取消"}
				</button>
				{preview.data && !cleanup.data && (
					<button
						type="button"
						className="button primary"
						disabled={cleanup.isPending || !preview.data.tasks.length || preview.data.tasks.length > 500}
						onClick={() => cleanup.mutate()}
					>
						{cleanup.isPending ? "正在清理…" : "确认清理"}
					</button>
				)}
			</div>
		</TaskDialog>
	);
}

export function TaskExecutionActions({ task, onDelegate }: { task: WorkbenchTask; onDelegate(): void }) {
	const active = task.execution?.status === "queued" || task.execution?.status === "running";
	return (
		<div className="task-execution-actions">
			{task.cleanupRequestedAt ? (
				<span>清理待恢复</span>
			) : (
				!["done", "cancelled", "running"].includes(task.status) &&
				!active && (
					<button type="button" className="button secondary with-icon" onClick={onDelegate}>
						<Icons.Spark />
						交给助手
					</button>
				)
			)}
			{active && <span>{label(task.execution!.status)}</span>}
			{task.execution?.sessionId && (
				<Link className="task-execution-link" to={`/chat?session=${task.execution.sessionId}`}>
					查看执行
				</Link>
			)}
		</div>
	);
}
