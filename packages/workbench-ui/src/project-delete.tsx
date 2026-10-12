import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api, type Project } from "./api.ts";
import { Icons } from "./icons.tsx";
import { ErrorNotice, LoadingBlock } from "./ui.tsx";
import "./session-title-dialog.css";
import "./task-dialogs.css";
import "./project-delete.css";

export function ProjectDeleteButton({ project, compact = false }: { project: Project; compact?: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				className={compact ? "icon-button project-delete-icon" : "button danger with-icon"}
				aria-label={`删除项目 ${project.name}`}
				title="删除项目"
				onClick={() => setOpen(true)}
			>
				<Icons.Trash />
				{!compact && (project.deletionPending ? "重试删除" : "删除项目")}
			</button>
			{open && <ProjectDeleteDialog project={project} onClose={() => setOpen(false)} />}
		</>
	);
}
function ProjectDeleteDialog({ project, onClose }: { project: Project; onClose(): void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const navigate = useNavigate();
	const client = useQueryClient();
	const preview = useQuery({
		queryKey: ["project-delete", project.id],
		queryFn: () => api.previewProjectDeletion(project.id),
		staleTime: 0,
		retry: false,
	});
	const remove = useMutation({
		mutationFn: () => api.deleteProject(project.id, preview.data!.fingerprint),
		onSuccess: async () => {
			onClose();
			navigate("/projects");
			client.removeQueries({ queryKey: ["project", project.id] });
			client.removeQueries({ queryKey: ["project-delete", project.id] });
			await client.invalidateQueries();
		},
		onError: () => preview.refetch(),
	});
	useEffect(() => {
		dialog.current?.showModal();
		return () => dialog.current?.close();
	}, []);
	return (
		<dialog
			ref={dialog}
			className="session-title-dialog task-dialog project-delete-dialog"
			aria-label="删除项目"
			onCancel={(event) => {
				event.preventDefault();
				if (!remove.isPending) onClose();
			}}
		>
			<h2>删除项目“{project.name}”</h2>
			<p>
				将永久删除该项目的工作台资料、会话及 Pi 历史、对话附件、任务、项目记忆和历史版本、技能、知识库原件及索引。
			</p>
			{preview.isLoading && <LoadingBlock label="正在核对删除范围" />}
			{preview.error && <ErrorNotice error={preview.error} />}
			{preview.data && (
				<>
					{preview.data.pending && <p>上次删除尚未完成，本次将继续清理剩余数据。</p>}
					<p className="project-delete-counts">
						会话 {preview.data.counts.sessions} · 任务 {preview.data.counts.tasks} · 成果{" "}
						{preview.data.counts.artifacts}
						<br />
						事实 {preview.data.counts.facts} · 经历 {preview.data.counts.episodes} · 技能{" "}
						{preview.data.counts.skills} · 文档 {preview.data.counts.documents}
					</p>
					<p>
						工作台目录：<code>{preview.data.workspacePath}</code>
					</p>
					{preview.data.sourcePath && (
						<p>
							本机源目录保留：<code>{preview.data.sourcePath}</code>
						</p>
					)}
					<p>其他项目、全局记忆和 USER.md 中的用户偏好保留。此操作无法撤销。</p>
				</>
			)}
			{remove.error && <ErrorNotice error={remove.error} />}
			<div className="form-actions">
				<button type="button" className="button secondary" disabled={remove.isPending} onClick={onClose}>
					取消
				</button>
				<button
					type="button"
					className="button danger"
					disabled={!preview.data || preview.isFetching || remove.isPending}
					onClick={() => remove.mutate()}
				>
					{remove.isPending ? "正在删除…" : "删除项目及工作台数据"}
				</button>
			</div>
		</dialog>
	);
}
