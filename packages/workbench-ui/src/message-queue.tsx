import type { RuntimeQueueAction, RuntimeQueuedMessage } from "@earendil-works/workbench-runtime";
import { useEffect, useId, useRef, useState } from "react";
import { Icons } from "./icons.tsx";
import { ErrorNotice } from "./ui.tsx";
import "./message-queue.css";

export function MessageQueue({
	items,
	pending,
	onAction,
}: {
	items: RuntimeQueuedMessage[];
	pending: boolean;
	onAction(id: string, action: RuntimeQueueAction): Promise<void>;
}) {
	const [expanded, setExpanded] = useState(false);
	const [editing, setEditing] = useState<{ id: string; text: string }>();
	const [error, setError] = useState<unknown>();
	const listId = useId();
	const editor = useRef<HTMLTextAreaElement>(null);
	const editingId = editing?.id;
	useEffect(() => {
		if (editingId) editor.current?.focus();
	}, [editingId]);
	useEffect(() => {
		if (editing && !items.some((item) => item.id === editing.id)) setEditing(undefined);
	}, [items, editing]);
	const act = async (id: string, action: RuntimeQueueAction) => {
		setError(undefined);
		try {
			await onAction(id, action);
			setEditing(undefined);
		} catch (failure) {
			setError(failure);
		}
	};
	if (!items.length) return error ? <ErrorNotice error={error} /> : null;
	return (
		<section className="message-queue" aria-label="排队消息">
			{items.length > 1 && (
				<button
					type="button"
					className="queue-heading"
					aria-expanded={expanded || Boolean(editing)}
					aria-controls={listId}
					onClick={() => setExpanded(!expanded)}
				>
					<Icons.Chat /> {items.length} 条消息排队中 <small>当前请求结束后依次发送</small>
				</button>
			)}
			{error !== undefined && <ErrorNotice error={error} />}
			<div id={listId} hidden={items.length > 1 && !expanded && !editing} className="queue-list">
				{items.map((item) => (
					<div key={item.id} className="queue-row">
						<Icons.Chat />
						{editing?.id === item.id ? (
							<div className="queue-editor">
								<textarea
									aria-label="编辑消息内容"
									ref={editor}
									value={editing.text}
									maxLength={64000}
									rows={2}
									disabled={pending}
									onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
								/>
								<button
									type="button"
									className="button secondary"
									disabled={pending}
									onClick={() => setEditing(undefined)}
								>
									取消
								</button>
								<button
									type="button"
									className="button primary"
									aria-label="保存排队消息"
									disabled={pending || !editing.text.trim()}
									onClick={() => void act(item.id, { kind: "edit", text: editing.text.trim() })}
								>
									保存
								</button>
							</div>
						) : (
							<>
								<span className="queue-text" title={item.text}>
									{item.text}
								</span>
								<div className="queue-actions">
									<button
										type="button"
										aria-label="编辑排队消息"
										title="编辑"
										disabled={pending}
										onClick={() => {
											setError(undefined);
											setEditing({ ...item });
										}}
									>
										<Icons.Edit />
									</button>
									<button
										type="button"
										aria-label="删除排队消息"
										title="删除"
										disabled={pending}
										onClick={() => void act(item.id, { kind: "remove" })}
									>
										<Icons.Trash />
									</button>
									<button
										type="button"
										aria-label="立即发送排队消息"
										title="立即纠偏：当前步骤结束后送达"
										disabled={pending}
										onClick={() => void act(item.id, { kind: "steer" })}
									>
										<Icons.Send />
									</button>
								</div>
							</>
						)}
					</div>
				))}
			</div>
		</section>
	);
}
