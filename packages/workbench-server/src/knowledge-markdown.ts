import type { KnowledgeSource } from "@earendil-works/workbench-core";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";

export const PARSER_FINGERPRINT = "markdown-parser-v3:pdfjs-6.3.289:mammoth-1.13.0:parse5-7.3.0";
export interface MarkdownSection {
	text: string;
	source: Omit<KnowledgeSource, "markdownStart" | "markdownEnd">;
}

export function assembleMarkdown(sections: MarkdownSection[]): { markdown: string; sources: KnowledgeSource[] } {
	let markdown = "";
	const sources: KnowledgeSource[] = [];
	for (const section of sections) {
		if (!section.text.trim()) continue;
		if (markdown) markdown += "\n\n";
		const markdownStart = markdown.length;
		markdown += section.text;
		sources.push({ ...section.source, markdownStart, markdownEnd: markdown.length });
	}
	return { markdown, sources };
}

export function codeFence(text: string, language = ""): string {
	const width = Math.max(3, ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length + 1));
	const fence = "`".repeat(width);
	return `${fence}${language}\n${text}\n${fence}`;
}

type HtmlNode = DefaultTreeAdapterMap["node"];
function inline(node: HtmlNode): string {
	if ("value" in node) return node.value.replace(/([\\`*_[\]<>])/gu, "\\$1");
	if ("tagName" in node && node.tagName === "img")
		return `【${node.attrs.find((attribute) => attribute.name === "alt")?.value ?? "DOCX 内嵌图片（保留于原件）"}】`;
	if (!("childNodes" in node)) return "";
	const text = node.childNodes.map(inline).join("");
	if (!("tagName" in node)) return text;
	if (["script", "style", "img"].includes(node.tagName)) return "";
	if (node.tagName === "br") return "\n";
	if (node.tagName === "strong" || node.tagName === "b") return `**${text}**`;
	if (node.tagName === "em" || node.tagName === "i") return `*${text}*`;
	if (node.tagName === "code") return `\`${text}\``;
	return text;
}

function block(node: HtmlNode, depth = 0): string {
	if (!("tagName" in node)) return inline(node);
	if (/^h[1-6]$/u.test(node.tagName)) return `${"#".repeat(Number(node.tagName[1]))} ${inline(node)}`;
	if (node.tagName === "ul" || node.tagName === "ol") {
		return node.childNodes
			.filter((item) => "tagName" in item && item.tagName === "li")
			.map((item, index) => {
				if (!("childNodes" in item)) return "";
				const content = item.childNodes
					.map((child) =>
						"tagName" in child && ["ul", "ol"].includes(child.tagName)
							? `\n${block(child, depth + 1)}`
							: block(child, depth),
					)
					.join("")
					.trim();
				return `${"  ".repeat(depth)}${node.tagName === "ol" ? `${index + 1}.` : "-"} ${content}`;
			})
			.join("\n");
	}
	if (node.tagName === "table") {
		const rows: string[][] = [];
		const visit = (item: HtmlNode) => {
			if (!("childNodes" in item)) return;
			if ("tagName" in item && item.tagName === "tr") {
				rows.push(
					item.childNodes
						.filter((cell) => "tagName" in cell && ["td", "th"].includes(cell.tagName))
						.flatMap((cell) => {
							const text = inline(cell).trim().replaceAll("|", "\\|").replaceAll("\n", "<br>");
							const span =
								"attrs" in cell
									? Number(cell.attrs.find((attribute) => attribute.name === "colspan")?.value ?? 1)
									: 1;
							return Array.from(
								{ length: Number.isInteger(span) && span > 0 && span <= 64 ? span : 1 },
								(_value, index) => (index === 0 ? text : "（同左合并单元格）"),
							);
						}),
				);
			} else item.childNodes.forEach(visit);
		};
		visit(node);
		if (!rows.length) return "";
		const columns = Math.max(...rows.map((row) => row.length));
		const rowText = (row: string[]) => `| ${Array.from({ length: columns }, (_, i) => row[i] ?? "").join(" | ")} |`;
		return [
			rowText(rows[0]),
			rowText(Array.from({ length: columns }, () => "---")),
			...rows.slice(1).map(rowText),
		].join("\n");
	}
	return inline(node).trim();
}

/** Converts Mammoth's semantic HTML, rather than decorating extracted plaintext. */
export function wordHtmlToMarkdown(html: string): MarkdownSection[] {
	return parseFragment(html)
		.childNodes.map<MarkdownSection>((node, index) => ({
			text: block(node),
			source: { kind: "docx", block: index + 1 },
		}))
		.filter((section) => section.text);
}
