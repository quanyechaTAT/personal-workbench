export type RuntimeErrorCode =
	| "invalid_reference"
	| "session_busy"
	| "session_corrupt"
	| "session_not_found"
	| "model_not_found"
	| "model_unavailable"
	| "runtime_disposed"
	| "runtime_failure";

export class RuntimeError extends Error {
	readonly code: RuntimeErrorCode;

	constructor(code: RuntimeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RuntimeError";
		this.code = code;
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
