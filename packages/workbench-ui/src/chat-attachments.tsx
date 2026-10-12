import { MAX_CHAT_ATTACHMENT_BYTES, MAX_CHAT_ATTACHMENTS } from "@earendil-works/workbench-core/contracts";
import type { RuntimeAttachmentReference } from "@earendil-works/workbench-runtime";
import { useEffect, useRef, useState } from "react";
import { api, type ChatAttachment } from "./api.ts";
import "./chat-attachments.css";

export interface DraftAttachment {
	id: string;
	file: File;
	previewUrl?: string;
	uploaded?: ChatAttachment;
}

export function useChatAttachments(scope: string) {
	const [items, setItems] = useState<DraftAttachment[]>([]);
	const [error, setError] = useState<string>();
	const current = useRef({ scope, items });
	current.current = { scope, items };
	const previousScope = useRef(scope);
	const urls = useRef(new Set<string>());
	const clear = (removePending = true) => {
		if (removePending)
			for (const item of current.current.items) {
				if (item.uploaded)
					void api.removeChatAttachment(item.uploaded.sessionId, item.uploaded.id).catch(() => undefined);
			}
		for (const url of urls.current) URL.revokeObjectURL(url);
		urls.current.clear();
		setItems([]);
		setError(undefined);
	};
	useEffect(() => {
		if (previousScope.current === scope) return;
		previousScope.current = scope;
		for (const url of urls.current) URL.revokeObjectURL(url);
		urls.current.clear();
		setItems([]);
		setError(undefined);
	}, [scope]);
	useEffect(
		() => () => {
			for (const url of urls.current) URL.revokeObjectURL(url);
			urls.current.clear();
		},
		[],
	);
	const add = (files: File[]) => {
		const available = MAX_CHAT_ATTACHMENTS - current.current.items.length;
		const accepted: DraftAttachment[] = [];
		let message: string | undefined;
		for (const file of files) {
			if (!file.size || file.size > MAX_CHAT_ATTACHMENT_BYTES) {
				message = `「${file.name}」须为非空文件，且不超过 20 MiB。`;
				continue;
			}
			if (accepted.length >= available) {
				message = "每轮最多 8 个附件。";
				break;
			}
			const previewUrl = ["image/png", "image/jpeg", "image/bmp", "image/webp", "image/gif"].includes(file.type)
				? URL.createObjectURL(file)
				: undefined;
			if (previewUrl) urls.current.add(previewUrl);
			accepted.push({ id: crypto.randomUUID(), file, previewUrl });
		}
		setError(message);
		current.current.items = [...current.current.items, ...accepted];
		setItems(current.current.items);
	};
	const remove = (id: string) => {
		const item = current.current.items.find((value) => value.id === id);
		if (item?.previewUrl) {
			URL.revokeObjectURL(item.previewUrl);
			urls.current.delete(item.previewUrl);
		}
		current.current.items = current.current.items.filter((value) => value.id !== id);
		setItems(current.current.items);
		if (item?.uploaded)
			void api.removeChatAttachment(item.uploaded.sessionId, item.uploaded.id).catch(() => undefined);
	};
	const upload = async (
		sessionId: string,
		snapshot: DraftAttachment[],
		signal: AbortSignal,
		onProgress: (value: string) => void,
	) => {
		const uploaded: ChatAttachment[] = [];
		const sourceScope = current.current.scope;
		for (const [index, item] of snapshot.entries()) {
			signal.throwIfAborted();
			onProgress(`正在上传附件 ${index + 1}/${snapshot.length}：${item.file.name}`);
			const attachment =
				item.uploaded?.sessionId === sessionId
					? item.uploaded
					: await api.uploadChatAttachment(sessionId, item.file, signal);
			uploaded.push(attachment);
			item.uploaded = attachment;
			if (current.current.scope === sourceScope)
				setItems((values) =>
					values.map((value) => (value.id === item.id ? { ...value, uploaded: attachment } : value)),
				);
		}
		return uploaded;
	};
	return {
		items: current.current.scope === previousScope.current ? items : [],
		error,
		add,
		remove,
		clear,
		upload,
		adopt: (nextScope: string) => {
			previousScope.current = nextScope;
		},
	};
}

export function ChatAttachmentDrafts({
	items,
	disabled,
	onRemove,
}: {
	items: DraftAttachment[];
	disabled: boolean;
	onRemove(id: string): void;
}) {
	if (!items.length) return null;
	return (
		<section className="chat-attachments" aria-label="本轮附件">
			{items.map((item) => (
				<div className="chat-attachment" key={item.id}>
					{item.previewUrl && <img src={item.previewUrl} alt={`待发送图片 ${item.file.name}`} />}
					<div>
						<strong>{item.file.name}</strong>
						<small>{formatSize(item.file.size)} · 待发送</small>
					</div>
					<button
						type="button"
						aria-label={`移除附件 ${item.file.name}`}
						disabled={disabled}
						onClick={() => onRemove(item.id)}
					>
						×
					</button>
				</div>
			))}
		</section>
	);
}

export function MessageAttachments({ sessionId, items }: { sessionId: string; items?: RuntimeAttachmentReference[] }) {
	if (!items?.length) return null;
	return (
		<section className="chat-attachments" aria-label="消息附件">
			{items.map((item) => (
				<div className="chat-attachment sent" key={item.id}>
					<div>
						<a
							href={`/api/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(item.id)}/file`}
							download={item.name}
						>
							{item.name}
						</a>
						<small>
							{formatSize(item.size)}
							{item.truncated ? " · 正文已截断" : ""}
						</small>
						{item.diagnostics.length > 0 && (
							<details>
								<summary>附件说明</summary>
								{item.diagnostics.map((text) => (
									<p key={text}>{text}</p>
								))}
							</details>
						)}
					</div>
				</div>
			))}
		</section>
	);
}

function formatSize(size: number) {
	return size >= 1024 * 1024
		? `${(size / (1024 * 1024)).toFixed(1)} MiB`
		: `${Math.max(1, Math.ceil(size / 1024))} KiB`;
}
