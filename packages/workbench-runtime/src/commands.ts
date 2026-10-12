export type RuntimeCommandAction =
	| "settings"
	| "model"
	| "thinking"
	| "new"
	| "resume"
	| "name"
	| "copy"
	| "hotkeys"
	| "session"
	| "compact"
	| "reload"
	| "export"
	| "unsupported";
export interface RuntimeSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	action: RuntimeCommandAction;
	requiresSession?: boolean;
	unavailableReason?: string;
}
export type RuntimeSessionCommand =
	| { name: "session" }
	| { name: "compact"; instructions?: string }
	| { name: "export"; format: "html" | "jsonl" };
export type RuntimeCommandResult =
	| {
			type: "stats";
			userMessages: number;
			assistantMessages: number;
			toolCalls: number;
			toolResults: number;
			totalMessages: number;
			tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
			cost: number;
	  }
	| { type: "compaction"; summary: string; tokensBefore: number; estimatedTokensAfter?: number }
	| { type: "export"; fileName: string; mimeType: string; content: string };
