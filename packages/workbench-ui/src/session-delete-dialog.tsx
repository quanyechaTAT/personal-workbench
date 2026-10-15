import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type WorkbenchSession } from "./api.ts";
import { ErrorNotice } from "./ui.tsx";
import "./session-title-dialog.css";

export function SessionDeleteDialog({
	session,
	pending,
	error,
	onDelete,
	onClose,
}: {
	session: WorkbenchSession;
	pending: boolean;
	error?: unknown;
	onDelete(action: "keep" | "delete" | "migrate"): void;
	onClose(): void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [action, setAction] = useState<"keep" | "delete" | "migrate">("migrate");
	const workspace = useQuery({
		queryKey: ["session-workspace", session.id],
		queryFn: () => api.sessionWorkspace(session.id),
	});
	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		return () => element?.close();
	}, []);
	return (
		<dialog
			ref={dialog}
			className="session-title-dialog"
			aria-labelledby="session-delete-heading"
			onCancel={(event) => {
				event.preventDefault();
				if (!pending) onClose();
			}}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (!pending && workspace.data) onDelete(action);
				}}
			>
				<h2 id="session-delete-heading">删除会话</h2>
				<p>将删除“{session.title || "未命名会话"}”的对话历史和聊天附件，此操作无法撤销。</p>
				<label className="field">
					会话工作区
					<select
						value={action}
						disabled={pending}
						onChange={(event) => setAction(event.target.value as typeof action)}
					>
						<option value="migrate">迁移到归档目录并保留文件</option>
						<option value="keep">保留在原位置</option>
						<option value="delete">一并删除会话工作区及其中全部文件</option>
					</select>
				</label>
				{workspace.data && (
					<p style={{ overflowWrap: "anywhere" }}>
						{action === "migrate" ? `迁移到：${workspace.data.migrationPath}` : `工作区：${workspace.data.path}`}
					</p>
				)}
				<p>项目源码、项目成果、共享记忆及技能会保留。</p>
				{(error || workspace.error) && <ErrorNotice error={error ?? workspace.error} />}
				<div className="card-actions">
					<button type="button" className="button secondary" onClick={onClose} disabled={pending}>
						取消
					</button>
					<button type="submit" className="button danger" disabled={pending || !workspace.data}>
						{pending ? "正在删除…" : "确认删除"}
					</button>
				</div>
			</form>
		</dialog>
	);
}
