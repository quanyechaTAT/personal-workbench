// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { Markdown } from "../src/markdown.tsx";

test("renders streaming Markdown tables, emphasis and fenced code", () => {
	const html = renderToStaticMarkup(
		<Markdown
			text={"**结论**\n\n| 项目 | 状态 |\n| --- | --- |\n| 工作台 | 正常 |\n\n```ts\nconst ready = true;\n```"}
		/>,
	);
	expect(html).toContain("<strong>结论</strong>");
	expect(html).toContain("<table>");
	expect(html).toContain("<pre><code>const ready = true;</code></pre>");
});

test("model output cannot execute HTML or JavaScript links or load tracking images", () => {
	const node = document.createElement("div");
	node.innerHTML = renderToStaticMarkup(
		<Markdown
			text={
				"<script>alert(1)</script>\n\n[危险](javascript:alert(1))\n\n![远程图片](https://example.test/track.png)"
			}
		/>,
	);
	expect(node.querySelector("script")).toBeNull();
	expect(node.querySelector('[href^="javascript:"]')).toBeNull();
	expect(node.querySelector("img")).toBeNull();
	expect(node.textContent).toContain("远程图片");
});

test("Ctrl-click on a file reference requests a preview while ordinary clicks do not", async () => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	const root = createRoot(container);
	const preview = vi.fn();
	await act(async () =>
		root.render(
			<Markdown
				text={"[报告](reports/notes.md) 和 `notes.txt`，以及 [桌面文件](D:/Desktop/笔记.txt)"}
				onPreviewFile={preview}
			/>,
		),
	);
	const link = container.querySelector("a");
	const code = container.querySelector("code");
	const absolutePath = container.querySelector("button.previewable-path:not(:has(code))");
	link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	expect(preview).not.toHaveBeenCalled();
	link?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
	code?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
	absolutePath?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	expect(preview.mock.calls).toEqual([["reports/notes.md"], ["notes.txt"], ["D:/Desktop/笔记.txt"]]);
	await act(async () => root.unmount());
});
