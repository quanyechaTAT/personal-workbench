import "./tool-images.css";

export function Screenshot({ part, alt = "工具截图" }: { part: unknown; alt?: string }) {
	if (
		typeof part !== "object" ||
		part === null ||
		!("type" in part) ||
		part.type !== "image" ||
		!("data" in part) ||
		typeof part.data !== "string" ||
		!("mimeType" in part) ||
		typeof part.mimeType !== "string"
	)
		return null;
	if (
		!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(part.mimeType) ||
		part.data.length > 24 * 1024 * 1024 ||
		!/^[A-Za-z0-9+/]+={0,2}$/u.test(part.data)
	)
		return null;
	return (
		<img className="tool-screenshot" src={`data:${part.mimeType};base64,${part.data}`} alt={alt} loading="lazy" />
	);
}

export function ToolImages({ result }: { result: unknown }) {
	if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content))
		return null;
	const images = new Map<string, unknown>();
	for (const part of result.content) {
		if (typeof part === "object" && part !== null && "data" in part && typeof part.data === "string")
			images.set(part.data, part);
	}
	return [...images].map(([data, part]) => <Screenshot key={data} part={part} />);
}
