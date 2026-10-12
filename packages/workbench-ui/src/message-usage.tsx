import type { RuntimeUsage } from "@earendil-works/workbench-runtime";
import "./message-usage.css";

export function MessageUsage({ usage }: { usage?: RuntimeUsage }) {
	if (!usage) return null;
	const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
	if (
		!counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
		usage.totalTokens === 0 ||
		usage.input + usage.output + usage.cacheRead + usage.cacheWrite !== usage.totalTokens
	)
		return null;
	return (
		<div
			className="message-usage"
			role="note"
			aria-label="本条回复 Token 用量"
			title={`未缓存输入 ${usage.input.toLocaleString()} · 缓存读取 ${usage.cacheRead.toLocaleString()} · 缓存写入 ${usage.cacheWrite.toLocaleString()}`}
		>
			输入 {(usage.input + usage.cacheRead + usage.cacheWrite).toLocaleString()} · 输出{" "}
			{usage.output.toLocaleString()} · 共 {usage.totalTokens.toLocaleString()} tokens
		</div>
	);
}
