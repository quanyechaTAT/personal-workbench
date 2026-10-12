import type { RuntimeTranscriptMessage } from "@earendil-works/workbench-runtime";
import type {
	LearningCadence,
	LearningReview,
	LearningRunReference,
	LearningSkillState,
	LearningSkillUse,
} from "./contracts/learning.ts";
import { redactLearningText } from "./evidence-redaction.ts";
import { toolEvidence } from "./memory-state-service.ts";

export { redactLearningText } from "./evidence-redaction.ts";

export interface LearningRepository {
	create(review: LearningReview): Promise<LearningReview>;
	get(id: string): Promise<LearningReview | undefined>;
	findSource(sourceKey: string): Promise<LearningReview | undefined>;
	save(review: LearningReview, expectedVersion: number): Promise<LearningReview | undefined>;
	list(projectId?: string): Promise<LearningReview[]>;
	page(
		projectId: string,
		offset: number,
		limit: number,
		pendingOnly?: boolean,
	): Promise<{ reviews: LearningReview[]; total: number }>;
	saveSkillState(state: LearningSkillState): Promise<void>;
	skillStates(projectId?: string): Promise<LearningSkillState[]>;
	saveSkillUse(use: LearningSkillUse): Promise<void>;
	skillUses(projectId: string, runId?: string): Promise<LearningSkillUse[]>;
	saveSnapshot(snapshot: LearningSnapshot): Promise<void>;
	getSnapshot(sourceKey: string): Promise<LearningSnapshot | undefined>;
	advanceCadence(
		sessionId: string,
		projectId: string,
		run: LearningRunReference,
		iterations: number,
	): Promise<LearningCadence | undefined>;
	cadences(projectId: string): Promise<LearningCadence[]>;
	consumeCadence(sessionId: string, runIds: string[]): Promise<void>;
	clearLegacyHistory(): Promise<boolean>;
}
export interface LearningSnapshot {
	sourceKey: string;
	projectId: string;
	runId?: string;
	sessionId: string;
	createdAt: string;
	sources: LearningSource[];
	unverified: boolean;
	model?: { provider: string; modelId: string };
}
export interface LearningSource {
	runId?: string;
	runVerified?: boolean;
	toolName?: string;
	timestamp?: string;
	piEntryId?: string;
	toolCallId?: string;
	id: string;
	role: "user" | "assistant" | "tool";
	text: string;
	verified: boolean;
}

/** A bounded copy of the completed turn. Reasoning, images and tool arguments are never reviewed. */
export function learningSources(messages: RuntimeTranscriptMessage[], start?: string, end?: string): LearningSource[] {
	let selected = messages.filter(
		(message) => (!start || message.timestamp >= start) && (!end || message.timestamp <= end),
	);
	// PTC children are independent evidence. Never promote the outer JavaScript result over a failed child.
	selected = selected.flatMap((message) =>
		message.toolResults?.length
			? message.toolResults.map((call) => ({
					...message,
					id: `${message.id}:${call.toolCallId}`,
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					isError: call.isError,
					evidenceText: call.text,
					toolResults: undefined,
				}))
			: [message],
	);
	// Curation results are bookkeeping, never independent evidence for another promotion.
	selected = selected.filter(
		(message) => !["learning_context", "memory_propose", "skill_manage"].includes(message.toolName ?? ""),
	);
	if (!start) {
		let index = -1;
		for (let position = 0; position < selected.length; position++) {
			if (selected[position].role === "user") index = position;
		}
		selected = index < 0 ? [] : selected.slice(index);
	}
	let remaining = 24_000;
	const sources: LearningSource[] = [];
	const user = [...selected].reverse().find((message) => message.role === "user");
	// Preserve the request and recent outcomes when a task has many large tool results.
	const candidates = user
		? [
				user,
				...selected
					.slice(-39)
					.reverse()
					.filter((message) => message !== user),
			]
		: selected.slice(-40).reverse();
	for (const message of candidates) {
		if (remaining <= 0) break;
		const content =
			message.evidenceText ??
			message.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n");
		const tool = message.role === "tool" ? toolEvidence(content, Boolean(message.isError)) : undefined;
		const text = redactLearningText(tool?.text ?? content).slice(0, Math.min(3000, remaining));
		if (!text.trim()) continue;
		remaining -= text.length;
		sources.push({
			toolName: message.toolName,
			timestamp: message.timestamp,
			piEntryId: message.piEntryId,
			toolCallId: message.toolCallId,
			id: message.id,
			role: message.role,
			text,
			verified: message.role === "user" || (message.role === "tool" && !tool?.failed),
		});
	}
	const order = new Map(selected.map((message, index) => [message.id, index]));
	return sources.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
}
