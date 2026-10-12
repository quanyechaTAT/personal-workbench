import { Lexer, type MarkedToken, type Token } from "marked";
import { createElement, Fragment, type MouseEvent, type ReactNode, useMemo } from "react";

function safeHref(href: string): string | undefined {
	try {
		const url = new URL(href, "http://workbench.local");
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return href;
	} catch {
		return undefined;
	}
}

function localFilePath(href: string): string | undefined {
	if (!href || href.startsWith("#")) return undefined;
	if (/^[a-z][a-z\d+.-]*:/iu.test(href) && !/^[a-z]:[\\/]/iu.test(href)) return undefined;
	return href;
}

function previewClick(event: MouseEvent<HTMLElement>, path: string, onPreviewFile?: (path: string) => void): void {
	if (!onPreviewFile || (!event.ctrlKey && !event.metaKey) || event.button !== 0) return;
	event.preventDefault();
	onPreviewFile(path);
}

/** Use Marked's built-in lexer; render tokens as React nodes so HTML stays escaped. */
function renderTokens(tokens: readonly Token[], onPreviewFile?: (path: string) => void): ReactNode {
	return tokens.map((value, index) => {
		const token = value as MarkedToken;
		let rendered: ReactNode;
		switch (token.type) {
			case "space":
			case "def":
				return null;
			case "heading":
				rendered = createElement(`h${token.depth}`, {}, renderTokens(token.tokens, onPreviewFile));
				break;
			case "paragraph":
				rendered = <p>{renderTokens(token.tokens, onPreviewFile)}</p>;
				break;
			case "text":
				rendered = token.tokens ? renderTokens(token.tokens, onPreviewFile) : token.text;
				break;
			case "strong":
				rendered = <strong>{renderTokens(token.tokens, onPreviewFile)}</strong>;
				break;
			case "em":
				rendered = <em>{renderTokens(token.tokens, onPreviewFile)}</em>;
				break;
			case "del":
				rendered = <del>{renderTokens(token.tokens, onPreviewFile)}</del>;
				break;
			case "code":
				rendered = (
					<pre>
						<code>{token.text}</code>
					</pre>
				);
				break;
			case "codespan":
				rendered =
					onPreviewFile && /[\\/]|\.[a-z\d]{1,12}(?:#L\d+)?$/iu.test(token.text) ? (
						<button
							type="button"
							className="previewable-path"
							title="单击或 Ctrl + 单击预览文件"
							onClick={() => onPreviewFile(token.text)}
						>
							<code>{token.text}</code>
						</button>
					) : (
						<code>{token.text}</code>
					);
				break;
			case "blockquote":
				rendered = <blockquote>{renderTokens(token.tokens, onPreviewFile)}</blockquote>;
				break;
			case "list":
				rendered = createElement(
					token.ordered ? "ol" : "ul",
					token.ordered ? { start: token.start || 1 } : {},
					token.items.map((item, itemIndex) => (
						<li key={`${itemIndex}-${item.raw}`}>
							{item.task && <input type="checkbox" disabled checked={Boolean(item.checked)} />}
							{renderTokens(item.tokens, onPreviewFile)}
						</li>
					)),
				);
				break;
			case "list_item":
				rendered = <li>{renderTokens(token.tokens, onPreviewFile)}</li>;
				break;
			case "link":
				rendered = safeHref(token.href) ? (
					<a
						href={safeHref(token.href)}
						target="_blank"
						rel="noopener noreferrer"
						title={localFilePath(token.href) && onPreviewFile ? "Ctrl + 单击预览文件" : undefined}
						onClick={(event) => {
							const path = localFilePath(token.href);
							if (path && onPreviewFile) {
								event.preventDefault();
								previewClick(event, path, onPreviewFile);
							}
						}}
					>
						{renderTokens(token.tokens, onPreviewFile)}
					</a>
				) : localFilePath(token.href) && onPreviewFile ? (
					<button
						type="button"
						className="previewable-path"
						onClick={() => onPreviewFile(token.href)}
						title="预览文件"
					>
						{renderTokens(token.tokens, onPreviewFile)}
					</button>
				) : (
					<span>{renderTokens(token.tokens, onPreviewFile)}</span>
				);
				break;
			case "image":
				rendered = safeHref(token.href) ? (
					<a href={safeHref(token.href)} target="_blank" rel="noopener noreferrer">
						{token.text || "查看图片"}
					</a>
				) : (
					token.text
				);
				break;
			case "table":
				rendered = (
					<div className="markdown-table">
						<table>
							<thead>
								<tr>
									{token.header.map((cell, cellIndex) => (
										<th key={`${cellIndex}-${cell.text}`}>{renderTokens(cell.tokens, onPreviewFile)}</th>
									))}
								</tr>
							</thead>
							<tbody>
								{token.rows.map((row, rowIndex) => (
									<tr key={`${rowIndex}-${row.map((cell) => cell.text).join("|")}`}>
										{row.map((cell, cellIndex) => (
											<td key={`${cellIndex}-${cell.text}`}>{renderTokens(cell.tokens, onPreviewFile)}</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				);
				break;
			case "br":
				rendered = <br />;
				break;
			case "hr":
				rendered = <hr />;
				break;
			case "checkbox":
				rendered = <input type="checkbox" disabled checked={token.checked} />;
				break;
			case "html":
				rendered = token.text;
				break;
			case "escape":
				rendered = token.text;
				break;
			default:
				rendered = value.raw;
		}
		return <Fragment key={`${index}-${value.type}`}>{rendered}</Fragment>;
	});
}

export function Markdown({ text, onPreviewFile }: { text: string; onPreviewFile?: (path: string) => void }) {
	const tokens = useMemo(() => Lexer.lex(text, { gfm: true, breaks: true }), [text]);
	return <div className="markdown-content">{renderTokens(tokens, onPreviewFile)}</div>;
}
