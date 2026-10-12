export type RuntimeToolApproval = "ask" | "allow";

export interface RuntimeToolDescriptor {
	id: string;
	name: string;
	label: string;
	description: string;
	inputSchema: Record<string, unknown>;
	definitionHash: string;
}

export interface RuntimeToolBinding {
	providerId: string;
	resourceId: string;
	resourceToolName: string;
	descriptor: RuntimeToolDescriptor;
	approval: RuntimeToolApproval;
}

export interface RuntimeToolScope {
	workbenchSessionId: string;
	runtimeSessionId?: string;
	assistantId: string;
	assistantVersion: number;
	projectId?: string;
	cwd: string;
}

export interface RuntimeToolCall {
	toolId: string;
	arguments: Record<string, unknown>;
	sessionId: string;
	runtimeSessionId: string;
	runId: string;
	toolCallId: string;
}

export interface RuntimeToolProgress {
	message?: string;
	progress?: number;
	total?: number;
	data?: unknown;
}

export type RuntimeToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource-link"; name: string; uri: string; mimeType?: string };

export interface RuntimeToolResult {
	content: RuntimeToolContent[];
	structuredContent?: unknown;
	isError: boolean;
	truncated?: boolean;
}

export interface RuntimeToolLease {
	readonly tools: readonly RuntimeToolDescriptor[];
	call(
		input: RuntimeToolCall,
		options: {
			signal: AbortSignal;
			onProgress(progress: RuntimeToolProgress): void;
		},
	): Promise<RuntimeToolResult>;
	close(): Promise<void>;
}

export interface RuntimeToolProvider {
	open(scope: RuntimeToolScope, bindings: readonly RuntimeToolBinding[]): Promise<RuntimeToolLease>;
	dispose(): Promise<void>;
}
