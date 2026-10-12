import type { RuntimeUsage } from "./events.ts";

export interface SessionUsage {
	turns: number;
	steps: number;
	tokens: RuntimeUsage;
	incomplete: boolean;
	llmMs: number;
	decodeMs: number;
	decodeTokens: number;
	firstTokenMs: number;
	timedSteps: number;
	contextTokens: number | null;
	contextTokensSource?: "reported" | "estimated";
	contextWindow?: number;
}
