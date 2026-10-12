/** Keep provider failures readable, including errors with no text content in Pi history. */
export function providerError(message: string, providerId: string, providerName: string): string {
	const visible = message.replaceAll(providerId, providerName);
	const match = /API error \((\d+)\):\s*([\s\S]*)/u.exec(visible);
	if (!match) return visible;
	let detail = match[2];
	try {
		const body: unknown = JSON.parse(detail);
		if (typeof body === "object" && body !== null) {
			const error = "error" in body ? body.error : body;
			if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
				detail = error.message;
		}
	} catch {
		// Providers may return a plain-text body rather than JSON.
		detail = match[2];
	}
	return `${providerName} 请求失败（HTTP ${match[1]}）：${detail.slice(0, 2000)}`;
}
