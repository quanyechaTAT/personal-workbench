export class McpWorkbenchError extends Error {
	readonly code:
		| "connection_failed"
		| "connection_disabled"
		| "authentication_required"
		| "tool_missing"
		| "invalid_schema"
		| "invalid_arguments"
		| "result_too_large"
		| "oauth_failed";

	constructor(
		code:
			| "connection_failed"
			| "connection_disabled"
			| "authentication_required"
			| "tool_missing"
			| "invalid_schema"
			| "invalid_arguments"
			| "result_too_large"
			| "oauth_failed",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "McpWorkbenchError";
		this.code = code;
	}
}

export function mcpErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
