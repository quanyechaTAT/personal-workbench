import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { SearchResults, ToolResult } from "../src/search-results.tsx";

test("renders source links as data, escapes remote text and rejects executable or credentialed URLs", () => {
	const text = JSON.stringify({
		kind: "web_search",
		results: [
			{
				title: "<script>unsafe title</script>",
				url: "https://example.com/paper",
				snippet: "<img src=x onerror=alert(1)>",
			},
			{ title: "Unsafe", url: "javascript:alert(1)", snippet: "bad" },
			{ title: "Credential", url: "https://user:secret@example.com/private", snippet: "bad" },
		],
	});
	const html = renderToStaticMarkup(createElement(SearchResults, { text }));
	expect(html).toContain('href="https://example.com/paper"');
	expect(html).toContain('rel="noopener noreferrer"');
	expect(html).toContain("&lt;script&gt;unsafe title");
	expect(html).not.toContain("javascript:");
	expect(html).not.toContain("user:secret");
	expect(html).not.toContain("<script>");
	expect(html).not.toContain("<img");
});

test("invalid search output falls back to ordinary tool text rather than pretending to contain sources", () => {
	for (const text of ["not JSON", '{"kind":"other","results":[]}', '{"kind":"web_search","results":"invalid"}']) {
		expect(renderToStaticMarkup(createElement(SearchResults, { text }))).toBe("");
		expect(renderToStaticMarkup(createElement(ToolResult, { text }))).toContain("<pre>");
		expect(renderToStaticMarkup(createElement(ToolResult, { text }))).not.toContain("<details>");
	}
});

test("empty native results are explicit and raw structured tool output remains inspectable", () => {
	const html = renderToStaticMarkup(createElement(ToolResult, { text: '{"kind":"web_search","results":[]}' }));
	expect(html).toContain("没有符合条件的搜索结果");
	expect(html).toContain("原始工具结果");
});
