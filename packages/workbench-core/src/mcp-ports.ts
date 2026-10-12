import type { McpConnection, McpToolRecord } from "./models.ts";

export interface McpConnectionTestResult {
	tools: McpToolRecord[];
	serverName?: string;
	serverVersion?: string;
}

export interface McpConnector {
	test(connection: McpConnection, signal?: AbortSignal): Promise<McpConnectionTestResult>;
	closeByConnection(connectionId: string): Promise<void>;
	dispose(): Promise<void>;
}
