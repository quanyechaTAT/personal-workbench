import type { DevelopmentAcceptance, RuntimeUsage } from "@earendil-works/workbench-runtime";
import { useMemo } from "react";
import type { AgentEvent } from "./api.ts";
import { Icons } from "./icons.tsx";
import { label } from "./labels.ts";
import { Markdown } from "./markdown.tsx";
import { MessageUsage } from "./message-usage.tsx";
import { ToolResult } from "./search-results.tsx";
import { ToolImages } from "./tool-images.tsx";
import { StatusPill } from "./ui.tsx";

interface MessageBlock {
	type: "message";
	id: string;
	parts: Map<number, { type: "text" | "reasoning"; text: string }>;
	complete: boolean;
	usage?: RuntimeUsage;
}
interface SteeringBlock {
	type: "input";
	steering: boolean;
	id: string;
	text: string;
}
interface ToolBlock {
	type: "tool";
	id: string;
	label: string;
	status: string;
	arguments?: unknown;
	updates: Array<{ id: string; value: unknown }>;
	result?: unknown;
	startedAt: string;
	finishedAt?: string;
}

export function eventValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null && "content" in value && Array.isArray(value.content)) {
		return value.content
			.map((part: unknown) => {
				if (typeof part === "object" && part !== null && "type" in part && part.type === "image") return "[图片]";
				if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string")
					return part.text;
				return JSON.stringify(part, null, 2);
			})
			.join("\n");
	}
	return JSON.stringify(value, null, 2) ?? String(value);
}

export function buildTimeline(events: readonly AgentEvent[]) {
	const blocks: Array<MessageBlock | SteeringBlock | ToolBlock> = [];
	const messages = new Map<string, MessageBlock>();
	const tools = new Map<string, ToolBlock>();
	const seen = new Set<string>();
	const approvalTools = new Map<string, string>();
	let terminal: "completed" | "aborted" | "failed" | undefined;
	let acceptance: DevelopmentAcceptance | undefined;
	let status = "正在回复";
	for (const event of events) {
		if (seen.has(event.id)) continue;
		seen.add(event.id);
		if (event.type === "development.updated") acceptance = event.data.acceptance;
		if (event.type === "run.completed") {
			terminal = "completed";
			acceptance = event.data.acceptance ?? acceptance;
		}
		if (event.type === "run.aborted") terminal = "aborted";
		if (event.type === "run.failed") terminal = "failed";
		if (event.type === "agent.status") status = event.data.status === "waiting" ? "正在等待" : "正在执行";
		if (
			event.type === "message.started" &&
			event.data.role === "user" &&
			(event.data.steering || event.data.queued) &&
			event.data.text
		)
			blocks.push({
				type: "input",
				steering: Boolean(event.data.steering),
				id: event.data.messageId,
				text: event.data.text,
			});
		if (event.type === "message.text.delta" || event.type === "message.reasoning.delta") {
			let block = messages.get(event.data.messageId);
			if (!block) {
				block = { type: "message", id: event.data.messageId, parts: new Map(), complete: false };
				messages.set(block.id, block);
				blocks.push(block);
			}
			const part = block.parts.get(event.data.contentIndex) ?? {
				type: event.type === "message.text.delta" ? "text" : "reasoning",
				text: "",
			};
			part.text += event.data.delta;
			block.parts.set(event.data.contentIndex, part);
		}
		if (event.type === "message.completed") {
			const block = messages.get(event.data.messageId);
			if (block) {
				block.complete = true;
				block.usage = event.data.usage;
			}
		}
		if (event.type === "tool.started" || event.type === "tool.updated" || event.type === "tool.completed") {
			let block = tools.get(event.data.toolCallId);
			if (!block) {
				block = {
					type: "tool",
					id: event.data.toolCallId,
					label: event.data.toolLabel ?? event.data.toolName,
					status: "running",
					updates: [],
					startedAt: event.occurredAt,
				};
				tools.set(block.id, block);
				blocks.push(block);
			}
			if (event.type === "tool.started") block.arguments = event.data.arguments;
			if (event.type === "tool.updated") {
				block.updates.push({ id: event.id, value: event.data.update });
				if (block.updates.length > 30) block.updates.shift();
				const update = event.data.update;
				if (typeof update === "object" && update !== null && "details" in update) {
					const details = update.details;
					if (typeof details === "object" && details !== null && "progress" in details) {
						const progress = details.progress;
						if (typeof progress === "object" && progress !== null && "data" in progress) {
							const data = progress.data;
							if (typeof data === "object" && data !== null && "status" in data && data.status === "pending")
								block.status = "blocked";
						}
					}
				}
			}
			if (event.type === "tool.completed") {
				block.status = event.data.isError ? "failed" : "completed";
				block.result = event.data.result;
				block.finishedAt = event.occurredAt;
			}
		}
		if (event.type === "permission.requested") {
			approvalTools.set(event.data.approvalId, event.data.toolCallId);
			const block = tools.get(event.data.toolCallId);
			if (block) block.status = "blocked";
		}
		if (event.type === "permission.resolved") {
			const id = approvalTools.get(event.data.approvalId);
			const block = id ? tools.get(id) : undefined;
			if (block && !block.finishedAt) block.status = event.data.decision === "approved" ? "running" : "cancelled";
		}
	}
	return { blocks, terminal, status, acceptance };
}

export function LiveEvents({
	events,
	assistantName = "个人助手",
	onPreviewFile,
}: {
	events: AgentEvent[];
	assistantName?: string;
	onPreviewFile?: (path: string) => void;
}) {
	const { blocks, terminal, status } = useMemo(() => buildTimeline(events), [events]);
	if (events.length === 0) return null;
	return (
		<article className="message message-assistant live-message">
			<div className="message-avatar">
				<Icons.Spark />
			</div>
			<div className="message-body">
				<div className="message-meta">
					<strong>{assistantName}</strong>
					{terminal ? (
						<StatusPill value={terminal}>{terminal === "completed" ? "本轮结束" : undefined}</StatusPill>
					) : (
						<span className="working-label">
							<i />
							{status}
						</span>
					)}
				</div>
				{blocks.map((block) =>
					block.type === "message" ? (
						<div key={block.id} data-message-id={block.id}>
							{[...block.parts]
								.sort(([left], [right]) => left - right)
								.map(([index, part]) =>
									part.type === "reasoning" ? (
										<details className="reasoning" key={index}>
											<summary>思考过程{!terminal && !block.complete ? " · 生成中" : ""}</summary>
											<div>{part.text}</div>
										</details>
									) : (
										<div className="message-text" key={index}>
											<Markdown text={part.text} onPreviewFile={onPreviewFile} />
										</div>
									),
								)}
							{!terminal && !block.complete && <output className="stream-cursor" aria-label="正在生成" />}
							{block.complete && <MessageUsage usage={block.usage} />}
						</div>
					) : block.type === "input" ? (
						<section className="steering-message chat-command-result" key={block.id}>
							<header>
								<strong>{block.steering ? "我 · 追加指令 · 已送达" : "我 · 已发送"}</strong>
							</header>
							<div className="message-text">{block.text}</div>
						</section>
					) : (
						<div className={`tool-card ${block.status === "blocked" ? "approval-card" : ""}`} key={block.id}>
							<div>
								<Icons.Tool />
								<strong>{label(block.label)}</strong>
								<StatusPill
									value={
										terminal && !block.finishedAt
											? terminal === "aborted"
												? "cancelled"
												: "failed"
											: block.status
									}
								>
									{!terminal && block.status === "blocked" ? "等待批准" : undefined}
								</StatusPill>
								{block.finishedAt && (
									<small>
										{((Date.parse(block.finishedAt) - Date.parse(block.startedAt)) / 1000).toFixed(1)} 秒
									</small>
								)}
							</div>
							{block.arguments !== undefined && (
								<details>
									<summary>调用参数</summary>
									<pre>{eventValue(block.arguments)}</pre>
								</details>
							)}
							{block.updates.length > 0 && (
								<details open={!block.finishedAt}>
									<summary>执行进度</summary>
									{block.updates.map((update) => (
										<pre key={update.id}>{eventValue(update.value)}</pre>
									))}
								</details>
							)}
							{block.result !== undefined && (
								<details open={block.status === "failed"}>
									<summary>工具结果</summary>
									<ToolResult text={eventValue(block.result)} />
									<ToolImages result={block.result} />
								</details>
							)}
						</div>
					),
				)}
			</div>
		</article>
	);
}
