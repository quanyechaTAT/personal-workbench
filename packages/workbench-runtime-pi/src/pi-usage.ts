import type { Usage } from "@earendil-works/pi-ai";
import { buildSessionContext, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RuntimeModelRef, SessionUsage } from "@earendil-works/workbench-runtime";

export const TURN_USAGE_ENTRY = "workbench.usage-turn.v1";
export const STEP_TIMING_ENTRY = "workbench.step-timing.v1";

// DSH StatsPills uses the whole durable log and disjoint prompt buckets.
// https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-chat/src/client/chat/StatsPills.tsx
export function deriveSessionUsage(
	entries: SessionEntry[],
	branch: SessionEntry[],
	model?: RuntimeModelRef,
	contextWindow?: number,
): SessionUsage {
	const result: SessionUsage = {
		turns: 0,
		steps: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		incomplete: false,
		llmMs: 0,
		decodeMs: 0,
		decodeTokens: 0,
		firstTokenMs: 0,
		timedSteps: 0,
		contextTokens: null,
		contextWindow,
	};
	const turns = new Set<string>();
	let hasTurnEntries = false;
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		let usage: Usage | undefined;
		if (entry.type === "custom" && entry.customType === TURN_USAGE_ENTRY && typeof entry.data === "string") {
			hasTurnEntries = true;
			turns.add(entry.data);
		} else if (entry.type === "custom" && entry.customType === STEP_TIMING_ENTRY) {
			const data: unknown = entry.data;
			if (
				typeof data !== "object" ||
				data === null ||
				!("llmMs" in data) ||
				typeof data.llmMs !== "number" ||
				!Number.isFinite(data.llmMs) ||
				data.llmMs < 0
			)
				continue;
			result.llmMs += data.llmMs;
			if (
				"firstTokenMs" in data &&
				typeof data.firstTokenMs === "number" &&
				Number.isFinite(data.firstTokenMs) &&
				data.firstTokenMs >= 0
			) {
				result.firstTokenMs += data.firstTokenMs;
				result.timedSteps++;
			}
			if (
				"decodeMs" in data &&
				typeof data.decodeMs === "number" &&
				Number.isFinite(data.decodeMs) &&
				data.decodeMs > 0 &&
				"outputTokens" in data &&
				typeof data.outputTokens === "number" &&
				Number.isSafeInteger(data.outputTokens) &&
				data.outputTokens > 0
			) {
				result.decodeMs += data.decodeMs;
				result.decodeTokens += data.outputTokens;
			}
		} else if (entry.type === "message") {
			if (entry.message.role === "user" && !hasTurnEntries) result.turns++;
			if (entry.message.role === "assistant") {
				result.steps++;
				usage = entry.message.usage;
			} else if (entry.message.role === "toolResult") usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
		if (!usage) continue;
		if (!validUsage(usage)) {
			result.incomplete = true;
			continue;
		}
		result.tokens.input += usage.input;
		result.tokens.output += usage.output;
		result.tokens.cacheRead += usage.cacheRead;
		result.tokens.cacheWrite += usage.cacheWrite;
		result.tokens.totalTokens += usage.totalTokens;
		result.tokens.cost += Number.isFinite(usage.cost.total) ? usage.cost.total : 0;
	}
	result.turns += turns.size;
	let compacted = false;
	for (const entry of branch) {
		if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "model_change") {
			result.contextTokens = null;
			result.contextTokensSource = undefined;
			compacted = entry.type !== "model_change";
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			if (
				(!model || (message.provider === model.provider && message.model === model.modelId)) &&
				message.stopReason !== "error" &&
				message.stopReason !== "aborted" &&
				validUsage(message.usage) &&
				message.usage.totalTokens > 0
			) {
				result.contextTokens = message.usage.totalTokens;
				result.contextTokensSource = "reported";
			}
		}
	}
	if (result.contextTokens === null && compacted) {
		// Rebuild the active context with Pi's public compaction/branch semantics.
		// Retained pre-compaction assistant usage is billing data, not the new context size.
		result.contextTokens = buildSessionContext(branch).messages.reduce(
			(total, message) => total + estimateTokens(message),
			0,
		);
		result.contextTokensSource = "estimated";
	}
	return result;
}

function validUsage(usage: Usage): boolean {
	const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
	return (
		counts.every((value) => Number.isSafeInteger(value) && value >= 0) &&
		usage.input + usage.output + usage.cacheRead + usage.cacheWrite === usage.totalTokens
	);
}
