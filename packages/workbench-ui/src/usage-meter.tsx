import type { SessionUsage } from "@earendil-works/workbench-runtime";
import { useId } from "react";
import "./usage-meter.css";

export function UsageMeter({
	usage,
	autoCompactPercent = 80,
	autoCompactEnabled = true,
	onCompact,
	compactDisabled,
}: {
	usage?: SessionUsage;
	autoCompactPercent?: number;
	autoCompactEnabled?: boolean;
	onCompact?(): void;
	compactDisabled?: boolean;
}) {
	const tooltipId = useId();
	if (!usage || (usage.steps === 0 && usage.tokens.totalTokens === 0 && !usage.contextTokens)) return null;
	const estimated = usage.contextTokensSource === "estimated";
	const prompt = usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite;
	const speed =
		usage.decodeMs > 0 && usage.decodeTokens > 0
			? Math.round((1000 * usage.decodeTokens) / usage.decodeMs)
			: undefined;
	const cache = prompt > 0 ? Math.round((1000 * usage.tokens.cacheRead) / prompt) / 10 : undefined;
	const percent =
		usage.contextTokens !== null && usage.contextWindow
			? Math.round((100 * usage.contextTokens) / usage.contextWindow)
			: undefined;
	const total =
		usage.tokens.totalTokens >= 1000
			? `${(usage.tokens.totalTokens / 1000).toFixed(1)}K`
			: `${usage.tokens.totalTokens}`;
	return (
		<section className="usage-meter" aria-label="Token 使用统计">
			<details>
				<summary>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path d="M5 19a9 9 0 1 1 14 0M12 12l5-5" />
					</svg>
					{usage.turns} 轮 {usage.steps} 步{speed !== undefined && ` · ${speed} tok/s`}
				</summary>
				<dl>
					<dt>模型请求耗时</dt>
					<dd>{(usage.llmMs / 1000).toFixed(2)} s</dd>
					<dt>平均首 Token 延迟</dt>
					<dd>
						{usage.timedSteps ? `${(usage.firstTokenMs / usage.timedSteps / 1000).toFixed(2)} s` : "暂无数据"}
					</dd>
					<dt>生成速度</dt>
					<dd>{speed === undefined ? "暂无计时数据" : `${speed} tok/s`}</dd>
				</dl>
			</details>
			<details>
				<summary>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<ellipse cx="12" cy="5" rx="8" ry="3" />
						<path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
					</svg>
					{usage.incomplete ? "已知 " : ""}
					{total} tok{cache !== undefined && ` · 缓存命中 ${cache}%`}
				</summary>
				<dl>
					<dt>未缓存输入</dt>
					<dd>{usage.tokens.input.toLocaleString()}</dd>
					<dt>缓存读取</dt>
					<dd>{usage.tokens.cacheRead.toLocaleString()}</dd>
					<dt>缓存写入</dt>
					<dd>{usage.tokens.cacheWrite.toLocaleString()}</dd>
					<dt>输出</dt>
					<dd>{usage.tokens.output.toLocaleString()}</dd>
					<dt>累计 Token</dt>
					<dd>{usage.tokens.totalTokens.toLocaleString()}</dd>
				</dl>
				{usage.incomplete && <p>部分调用未返回有效用量。</p>}
			</details>
			<div className="usage-context-wrap">
				<button
					type="button"
					className="usage-context"
					aria-label="上下文窗口用量"
					aria-describedby={tooltipId}
					title={
						percent === undefined
							? "等待模型返回上下文用量"
							: `${estimated ? "压缩后估算约" : "上次模型请求占用"} ${usage.contextTokens?.toLocaleString()} / ${usage.contextWindow?.toLocaleString()} Token`
					}
				>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<circle className="usage-circle-track" cx="12" cy="12" r="9" />
						<circle
							className="usage-circle-fill"
							cx="12"
							cy="12"
							r="9"
							pathLength="100"
							strokeDasharray={`${Math.min(percent ?? 0, 100)} 100`}
						/>
					</svg>
					<span className="usage-context-label" data-source={usage.contextTokensSource}>
						{percent === undefined ? "—" : `${estimated ? "≈ " : ""}${percent}%`}
					</span>
				</button>
				<span id={tooltipId} role="tooltip" className="usage-context-tooltip">
					<strong>上下文窗口</strong>
					<span>
						{estimated ? "估算 " : ""}
						{usage.contextTokens === null ? "待更新" : usage.contextTokens.toLocaleString()} /{" "}
						{usage.contextWindow?.toLocaleString() ?? "未知上限"} Token
					</span>
					<small>
						{usage.contextTokens === null
							? "等待模型请求返回实际用量。"
							: estimated
								? "压缩后保留消息的估算，下一次模型回复后更新为实际用量。"
								: "上次模型请求的实际用量，包含输入和输出。"}
					</small>
					<small>{autoCompactEnabled ? `达到 ${autoCompactPercent}% 时自动压缩` : "自动压缩已关闭"}</small>
				</span>
			</div>
			{onCompact && (
				<button
					type="button"
					className="usage-compact"
					disabled={compactDisabled}
					onClick={onCompact}
					title="/compact：压缩当前上下文并保留任务进度"
				>
					压缩上下文
				</button>
			)}
		</section>
	);
}
