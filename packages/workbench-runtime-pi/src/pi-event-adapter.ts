import { randomUUID } from "node:crypto";
import type { AssistantMessage, AssistantMessageEvent, Message, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, AgentEventData, AgentEventType, RuntimeUsage } from "@earendil-works/workbench-runtime";

function isMessage(value: unknown): value is Message {
	if (typeof value !== "object" || value === null || !("role" in value)) return false;
	return value.role === "user" || value.role === "assistant" || value.role === "toolResult";
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return isMessage(value) && value.role === "assistant";
}

export function normalizeUsage(usage: Usage): RuntimeUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: usage.cost.total,
	};
}

export class PiEventAdapter {
	private readonly messageIds = new WeakMap<object, string>();
	private readonly sessionId: string;
	private readonly runIdValue: string;
	private latestAssistantMessageId: string | undefined;
	private activeMessage: { id: string; role: "user" | "assistant" } | undefined;
	private settled = false;
	private userMessageStarted = false;
	private queuedPrompt = false;
	private readonly toolLabels: ReadonlyMap<string, string>;

	constructor(sessionId: string, runId: string, toolLabels: ReadonlyMap<string, string> = new Map()) {
		this.sessionId = sessionId;
		this.runIdValue = runId;
		this.toolLabels = toolLabels;
	}

	get finalMessageId(): string | undefined {
		return this.latestAssistantMessageId;
	}

	get didSettle(): boolean {
		return this.settled;
	}

	get runId(): string {
		return this.runIdValue;
	}

	beginPrompt(queued = false): void {
		this.settled = false;
		this.userMessageStarted = false;
		this.queuedPrompt = queued;
	}

	create<T extends AgentEventType>(type: T, data: AgentEventData[T]): Extract<AgentEvent, { type: T }> {
		return {
			id: randomUUID(),
			type,
			occurredAt: new Date().toISOString(),
			sessionId: this.sessionId,
			runId: this.runIdValue,
			data,
		} as Extract<AgentEvent, { type: T }>;
	}

	adapt(event: AgentSessionEvent): AgentEvent[] {
		switch (event.type) {
			case "queue_update":
				return [this.create("input.queue", { steering: [...event.steering] })];
			case "message_start":
				return this.messageStarted(event.message);
			case "message_update":
				return this.messageUpdated(event.message, event.assistantMessageEvent);
			case "message_end":
				return this.messageCompleted(event.message);
			case "tool_execution_start":
				return [
					this.create("tool.started", {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						arguments: event.args as unknown,
						toolLabel: this.toolLabels.get(event.toolName),
					}),
				];
			case "tool_execution_update":
				return [
					this.create("tool.updated", {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						update: event.partialResult as unknown,
						toolLabel: this.toolLabels.get(event.toolName),
					}),
				];
			case "tool_execution_end":
				return [
					this.create("tool.completed", {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result as unknown,
						isError: event.isError,
						toolLabel: this.toolLabels.get(event.toolName),
					}),
				];
			case "agent_settled":
				this.settled = true;
				return [];
			case "auto_retry_start":
				return [
					this.create("agent.status", {
						status: "waiting",
						detail: `模型请求失败，${Math.round(event.delayMs / 1000)} 秒后重试（${event.attempt}/${event.maxAttempts}）：${event.errorMessage}`,
					}),
				];
			case "compaction_start":
				return [this.create("agent.status", { status: "waiting", detail: "Compacting session context" })];
			case "auto_retry_end":
			case "compaction_end":
				return [this.create("agent.status", { status: "running" })];
			default:
				return [];
		}
	}

	private getMessageId(message: object): string {
		const existing = this.messageIds.get(message);
		if (existing) return existing;
		const id = randomUUID();
		this.messageIds.set(message, id);
		return id;
	}

	private messageStarted(value: unknown): AgentEvent[] {
		if (!isMessage(value) || value.role === "toolResult") return [];
		const messageId = this.getMessageId(value);
		this.activeMessage = { id: messageId, role: value.role };
		if (value.role === "assistant") this.latestAssistantMessageId = messageId;
		if (value.role === "user") {
			const steering = this.userMessageStarted;
			this.userMessageStarted = true;
			const text =
				typeof value.content === "string"
					? value.content
					: value.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			return [
				this.create("message.started", {
					messageId,
					role: "user",
					text,
					steering,
					...(this.queuedPrompt && !steering ? { queued: true } : {}),
				}),
			];
		}
		return [this.create("message.started", { messageId, role: "assistant" })];
	}

	private messageUpdated(value: unknown, update: AssistantMessageEvent): AgentEvent[] {
		if (!isAssistantMessage(value)) return [];
		const messageId = this.activeMessage?.role === "assistant" ? this.activeMessage.id : this.getMessageId(value);
		this.latestAssistantMessageId = messageId;
		switch (update.type) {
			case "text_delta":
				return [
					this.create("message.text.delta", {
						messageId,
						contentIndex: update.contentIndex,
						delta: update.delta,
					}),
				];
			case "thinking_delta":
				return [
					this.create("message.reasoning.delta", {
						messageId,
						contentIndex: update.contentIndex,
						delta: update.delta,
					}),
				];
			default:
				return [];
		}
	}

	private messageCompleted(value: unknown): AgentEvent[] {
		if (!isMessage(value) || value.role === "toolResult") return [];
		const messageId = this.activeMessage?.role === value.role ? this.activeMessage.id : this.getMessageId(value);
		this.activeMessage = undefined;
		if (value.role === "assistant") {
			this.latestAssistantMessageId = messageId;
			return [
				this.create("message.completed", {
					messageId,
					role: "assistant",
					stopReason: value.stopReason,
					usage: normalizeUsage(value.usage),
				}),
			];
		}
		return [this.create("message.completed", { messageId, role: "user" })];
	}
}
