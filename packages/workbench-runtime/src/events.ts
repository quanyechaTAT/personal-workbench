import type { DevelopmentAcceptance, DevelopmentState } from "./development.ts";
import type { RuntimeQueuedMessage } from "./runtime.ts";
import type { SessionUsage } from "./usage.ts";

export type AgentStatus = "idle" | "running" | "waiting" | "aborting";

export interface RuntimeUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export type AgentEventData = {
	"run.started": { inputId: string; historyMessageCount?: number };
	/** Normal end of a round; acceptance is a separate evidence-based result. */
	"run.completed": { finalMessageId?: string; acceptance?: DevelopmentAcceptance };
	"run.aborted": { reason?: string };
	"run.failed": { message: string; code?: string };
	"input.queue": { steering: string[]; followUp?: RuntimeQueuedMessage[]; revision?: number };
	"development.updated": DevelopmentState;
	"usage.updated": SessionUsage;
	"message.started": {
		messageId: string;
		role: "user" | "assistant";
		text?: string;
		steering?: boolean;
		queued?: boolean;
	};
	"message.text.delta": { messageId: string; contentIndex: number; delta: string };
	"message.reasoning.delta": { messageId: string; contentIndex: number; delta: string };
	"message.completed": {
		messageId: string;
		role: "user" | "assistant";
		stopReason?: string;
		usage?: RuntimeUsage;
	};
	"tool.started": { toolCallId: string; toolName: string; toolLabel?: string; arguments: unknown };
	"tool.updated": { toolCallId: string; toolName: string; toolLabel?: string; update: unknown };
	"tool.completed": { toolCallId: string; toolName: string; toolLabel?: string; result: unknown; isError: boolean };
	"permission.requested": { approvalId: string; toolCallId: string; summary: string };
	"permission.resolved": { approvalId: string; decision: "approved" | "denied" | "cancelled" | "expired" };
	"artifact.created": { artifactId: string };
	"agent.status": { status: AgentStatus; detail?: string };
};

export type AgentEventType = keyof AgentEventData;

export type AgentEvent = {
	[K in AgentEventType]: {
		id: string;
		type: K;
		occurredAt: string;
		sessionId: string;
		runId: string;
		data: AgentEventData[K];
	};
}[AgentEventType];

export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;
