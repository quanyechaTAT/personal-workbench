export function redactLearningText(value: string): string {
	return value
		.replace(/\b(?:Bearer\s+|sk-[a-zA-Z0-9_-]{12,})[^\s"',;]*/giu, "[凭证已移除]")
		.replace(
			/((?:api[-_]?key|access_token|refresh_token|client_secret|password|authorization|cookie)\s*["']?\s*[:=]\s*)[^\n,;]+/giu,
			"$1[凭证已移除]",
		);
}
