import { WorkbenchError } from "./errors.ts";
import type { MemoryConfirmation } from "./memory-layers.ts";

export interface MemoryPolicy {
	confidenceThreshold: number;
	staleAfterDays: number;
	consolidationIntervalHours: number;
	maxEntryCharacters: number;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
	confidenceThreshold: 0.6,
	staleAfterDays: 90,
	consolidationIntervalHours: 24,
	maxEntryCharacters: 120,
};

export function memoryPolicy(value?: unknown): MemoryPolicy {
	if (value === undefined) return { ...DEFAULT_MEMORY_POLICY };
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new WorkbenchError("invalid_input", "记忆维护参数必须为对象");
	const policy = { ...DEFAULT_MEMORY_POLICY, ...value };
	if (
		Object.keys(value).some((key) => !(key in DEFAULT_MEMORY_POLICY)) ||
		!Number.isFinite(policy.confidenceThreshold) ||
		policy.confidenceThreshold < 0 ||
		policy.confidenceThreshold > 1 ||
		!Number.isInteger(policy.staleAfterDays) ||
		policy.staleAfterDays < 1 ||
		policy.staleAfterDays > 3650 ||
		!Number.isFinite(policy.consolidationIntervalHours) ||
		policy.consolidationIntervalHours < 1 ||
		policy.consolidationIntervalHours > 8760 ||
		!Number.isInteger(policy.maxEntryCharacters) ||
		policy.maxEntryCharacters < 20 ||
		policy.maxEntryCharacters > 500
	)
		throw new WorkbenchError(
			"invalid_input",
			"记忆参数范围：置信度 0–1，复核 1–3650 天，浓缩 1–8760 小时，每条 20–500 字",
		);
	return policy;
}

/** Confidence measures support for a claim, not whether an event itself succeeded. */
export function memoryConfidence(value: { confidence?: number; confirmation?: MemoryConfirmation }): number {
	if (value.confidence !== undefined) {
		if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)
			throw new WorkbenchError("invalid_input", "记忆置信度必须为 0–1 的有限数值");
		return value.confidence;
	}
	return value.confirmation === "user_confirmed" ? 1 : value.confirmation === "verified" ? 0.85 : 0.4;
}

export function memoryAgeNotice(timestamp: string, policy: MemoryPolicy, now = Date.now()): string {
	return !Number.isFinite(Date.parse(timestamp)) || now - Date.parse(timestamp) > policy.staleAfterDays * 86400000
		? `记忆已超过 ${policy.staleAfterDays} 天未核验，使用前请复核当前条件。`
		: "";
}
