import { useEffect, useRef, useState } from "react";
import type { AgentProfile } from "./api.ts";
import { profileName } from "./labels.ts";
import { ErrorNotice } from "./ui.tsx";
import "./session-title-dialog.css";

export function SessionTitleDialog({
	initialTitle,
	creating,
	pending,
	error,
	onSave,
	onClose,
	profiles = [],
	initialProfileId = "",
	contextLabel,
}: {
	initialTitle: string;
	creating: boolean;
	pending: boolean;
	error?: unknown;
	onSave(title: string, profileId: string): void;
	onClose(): void;
	profiles?: AgentProfile[];
	initialProfileId?: string;
	contextLabel?: string;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const field = useRef<HTMLInputElement>(null);
	const assistant = useRef<HTMLSelectElement>(null);
	const [title, setTitle] = useState(initialTitle);
	const [profileId, setProfileId] = useState(initialProfileId);
	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		field.current?.focus();
		field.current?.select();
		assistant.current?.focus();
		return () => {
			element?.close();
		};
	}, []);
	return (
		<dialog
			ref={dialog}
			className="session-title-dialog"
			aria-labelledby="session-title-heading"
			onCancel={(event) => {
				event.preventDefault();
				if (!pending) onClose();
			}}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (!pending && (creating ? profiles.some((p) => p.id === profileId) : Boolean(title.trim())))
						onSave(creating ? "" : title.trim(), profileId);
				}}
			>
				<h2 id="session-title-heading">{creating ? "新建会话" : "重命名会话"}</h2>
				{contextLabel && <p>会话归属：{contextLabel}</p>}
				{!creating && (
					<label className="field">
						会话名称
						<input
							ref={field}
							required
							maxLength={200}
							value={title}
							disabled={pending}
							onChange={(event) => setTitle(event.target.value)}
						/>
					</label>
				)}
				{creating && (
					<label className="field">
						选择助手
						<select
							ref={assistant}
							aria-label="新会话助手"
							required
							value={profileId}
							disabled={pending}
							onChange={(event) => setProfileId(event.target.value)}
						>
							<option value="">请选择助手</option>
							{profiles.map((profile) => (
								<option key={profile.id} value={profile.id}>
									{profileName(profile)}
								</option>
							))}
						</select>
					</label>
				)}
				<p>
					{creating
						? "选择助手后开始对话，首条消息会自动生成名称，以后可以重命名。"
						: "修改名称会保留原会话、项目关联和全部对话历史。"}
				</p>
				{error != null && <ErrorNotice error={error} />}
				<div className="card-actions">
					<button className="button secondary" type="button" disabled={pending} onClick={onClose}>
						取消
					</button>
					<button
						className="button primary"
						type="submit"
						disabled={pending || (creating ? !profiles.some((p) => p.id === profileId) : !title.trim())}
					>
						{pending ? "正在保存…" : creating ? "开始对话" : "保存名称"}
					</button>
				</div>
			</form>
		</dialog>
	);
}
