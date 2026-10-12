// @vitest-environment jsdom
import type { SessionUsage } from "@earendil-works/workbench-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { UsageMeter } from "../src/usage-meter.tsx";

const usage: SessionUsage = {
	turns: 2,
	steps: 3,
	tokens: { input: 6000, output: 600, cacheRead: 5000, cacheWrite: 1000, totalTokens: 12600, cost: 0 },
	incomplete: false,
	llmMs: 2400,
	firstTokenMs: 800,
	timedSteps: 2,
	decodeMs: 1000,
	decodeTokens: 441,
	contextTokens: 6400,
	contextWindow: 128000,
};
test("usage bar separates prompt cache buckets, decode time and last-request context", () => {
	const node = document.createElement("div");
	node.innerHTML = renderToStaticMarkup(<UsageMeter usage={usage} />);
	expect([...node.querySelectorAll("summary")].map((item) => item.textContent)).toEqual([
		"2 轮 3 步 · 441 tok/s",
		"12.6K tok · 缓存命中 41.7%",
	]);
	expect(node.querySelector(".usage-context-label")?.textContent).toBe("5%");
	expect(node.querySelector(".usage-context")?.getAttribute("title")).toContain("128,000");
	expect(node.querySelector('[role="tooltip"]')?.textContent).toContain("6,400 / 128,000");
});
test("missing timing and unknown context do not invent data while paid tokens remain visible", () => {
	const html = renderToStaticMarkup(
		<UsageMeter usage={{ ...usage, decodeMs: 0, decodeTokens: 0, contextTokens: null, incomplete: true }} />,
	);
	expect(html).not.toContain("441 tok/s");
	expect(html).not.toContain(">0%</span>");
	expect(html).toContain("已知 ");
	expect(html).toContain("12.6K");
	expect(html).toContain("暂无计时数据");
});

test("a compacted context displays its estimate immediately and labels its source", () => {
	const node = document.createElement("div");
	node.innerHTML = renderToStaticMarkup(
		<UsageMeter usage={{ ...usage, contextTokens: 1280, contextTokensSource: "estimated" }} />,
	);
	expect(node.querySelector(".usage-context-label")?.textContent).toBe("≈ 1%");
	expect(node.querySelector(".usage-context")?.getAttribute("title")).toContain("压缩后估算约 1,280 / 128,000");
	expect(node.querySelector('[role="tooltip"]')?.textContent).toContain("下一次模型回复后更新为实际用量");
	expect(node.textContent).toContain("12.6K tok");
});
