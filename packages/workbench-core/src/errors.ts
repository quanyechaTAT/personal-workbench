export type WorkbenchErrorCode =
	| "conflict"
	| "external_failure"
	| "invalid_input"
	| "not_found"
	| "path_denied"
	| "path_external"
	| "permission_expired"
	| "permission_resolved"
	| "storage_failure";

export class WorkbenchError extends Error {
	readonly code: WorkbenchErrorCode;

	constructor(code: WorkbenchErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkbenchError";
		this.code = code;
	}
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
