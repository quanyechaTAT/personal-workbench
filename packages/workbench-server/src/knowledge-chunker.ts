import {
	type KnowledgePassage,
	type KnowledgeSettings,
	type KnowledgeSource,
	WorkbenchError,
} from "@earendil-works/workbench-core";
import { Lexer, type Tokens } from "marked";
import type { ParsedDocument } from "./knowledge-document-parser.ts";
import { codeFence } from "./knowledge-markdown.ts";
import { fittingPrefix, type KnowledgeTokenizer } from "./knowledge-tokenizer.ts";

export const CHUNKER_VERSION = "markdown-token-chunker-v3-overlap";
export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
	maxChunkTokens: 768,
	overlapTokens: 64,
	minChunkTokens: 128,
	contextTokens: 4096,
	queryTokens: 512,
	mqe: "auto",
	mqeTimeoutMs: 2500,
	hyde: "off",
	hydeTimeoutMs: 2500,
	hydeTokens: 256,
};

export function validateKnowledgeSettings(value: unknown): KnowledgeSettings {
	if (typeof value !== "object" || value === null) throw new WorkbenchError("invalid_input", "知识库参数必须是对象");
	const settings = { ...DEFAULT_KNOWLEDGE_SETTINGS, ...value };
	if (!("overlapTokens" in value)) settings.overlapTokens = Math.min(64, Math.floor(settings.maxChunkTokens / 4));
	for (const [key, min, max] of [
		["maxChunkTokens", 64, 8192],
		["overlapTokens", 0, 4096],
		["minChunkTokens", 0, 8192],
		["contextTokens", 128, 32768],
		["queryTokens", 32, 8192],
		["mqeTimeoutMs", 100, 10000],
		["hydeTimeoutMs", 100, 10000],
		["hydeTokens", 32, 1024],
	] as const) {
		const parameter = settings[key];
		if (parameter === undefined || !Number.isInteger(parameter) || parameter < min || parameter > max)
			throw new WorkbenchError("invalid_input", `${key} 必须是 ${min} 到 ${max} 的整数`);
	}
	if (settings.minChunkTokens > settings.maxChunkTokens || !["off", "auto", "always"].includes(settings.mqe))
		throw new WorkbenchError("invalid_input", "最小片段不能超过 Token 上限；MQE 必须为 off、auto 或 always");
	if (!settings.hyde || !["off", "auto", "always"].includes(settings.hyde))
		throw new WorkbenchError("invalid_input", "HyDE 必须为 off、auto 或 always");
	if (
		(settings.overlapTokens ?? 0) >= settings.maxChunkTokens ||
		(settings.overlapTokens ?? 0) > settings.maxChunkTokens / 2
	)
		throw new WorkbenchError("invalid_input", "重叠 Token 必须小于片段上限，且不超过上限的一半");
	return {
		maxChunkTokens: settings.maxChunkTokens,
		overlapTokens: settings.overlapTokens,
		minChunkTokens: settings.minChunkTokens,
		contextTokens: settings.contextTokens,
		queryTokens: settings.queryTokens,
		mqe: settings.mqe,
		mqeTimeoutMs: settings.mqeTimeoutMs,
		hyde: settings.hyde,
		hydeTimeoutMs: settings.hydeTimeoutMs,
		hydeTokens: settings.hydeTokens,
	};
}

function mappedSources(parsed: ParsedDocument, start: number, end: number): KnowledgeSource[] {
	const mapped = parsed.sources
		.filter((source) => source.markdownEnd > start && source.markdownStart < end)
		.map((source) => {
			const markdownStart = Math.max(start, source.markdownStart);
			const markdownEnd = Math.min(end, source.markdownEnd);
			if (source.kind !== "text") return { ...source, markdownStart, markdownEnd };
			return {
				...source,
				markdownStart,
				markdownEnd,
				startLine:
					(source.startLine ?? 1) +
					parsed.markdown.slice(source.markdownStart, markdownStart).split("\n").length -
					1,
				endLine:
					(source.startLine ?? 1) +
					parsed.markdown.slice(source.markdownStart, Math.max(markdownStart, markdownEnd - 1)).split("\n")
						.length -
					1,
				originalStart:
					source.originalStart === undefined
						? undefined
						: source.originalStart + markdownStart - source.markdownStart,
				originalEnd:
					source.originalStart === undefined
						? undefined
						: markdownEnd === source.markdownEnd
							? source.originalEnd
							: Math.min(
									source.originalEnd ?? Infinity,
									source.originalStart + markdownEnd - source.markdownStart,
								),
			};
		});
	const compact: KnowledgeSource[] = [];
	for (const source of mapped) {
		const previous = compact.at(-1);
		if (
			source.kind === "text" &&
			previous?.kind === "text" &&
			previous.markdownEnd === source.markdownStart &&
			previous.originalEnd === source.originalStart &&
			(previous.endLine ?? 0) + 1 === source.startLine
		) {
			previous.markdownEnd = source.markdownEnd;
			previous.originalEnd = source.originalEnd;
			previous.endLine = source.endLine;
		} else compact.push(source);
	}
	return compact;
}

/** Keep top-level declarations together where possible; an oversized declaration falls back to lines. */
function codeParts(text: string): string[] {
	const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
	const parts: string[] = [];
	let pending = "";
	for (const [index, line] of lines.entries()) {
		const declaration =
			/^(?:(?:export|default|async|pub|public|private|static)\s+)*(?:function|class|def|fn|func|interface|type|const|let|var|CREATE|SELECT|INSERT)\b/u.test(
				line,
			);
		const separator = !line.trim() && /^\S/u.test(lines[index + 1] ?? "");
		if (declaration && pending.trim()) {
			parts.push(pending);
			pending = "";
		}
		pending += line;
		if (separator && pending.trim()) {
			parts.push(pending);
			pending = "";
		}
	}
	if (pending) parts.push(pending);
	return parts;
}

/** Split oversized cells into valid rows with the same column count and repeated short identifiers. */
function splitTableRow(
	cells: string[],
	wrap: (row: string) => string,
	tokenizer: KnowledgeTokenizer,
	max: number,
	signal?: AbortSignal,
): string[] {
	const row = (values: string[]) => `| ${values.join(" | ")} |\n`;
	if (tokenizer.count(wrap(row(cells))) <= max) return [row(cells)];
	const remaining = [...cells];
	const identifiers = cells.map((cell) => (tokenizer.count(cell) <= 12 ? cell : ""));
	const rows: string[] = [];
	while (remaining.some(Boolean)) {
		signal?.throwIfAborted();
		let values = remaining.map((_value, index) => (remaining[index] ? "" : identifiers[index]));
		if (tokenizer.count(wrap(row(values))) >= max) values = cells.map(() => "");
		let consumed = 0;
		for (const [index, value] of remaining.entries()) {
			if (!value) continue;
			const selected = fittingPrefix(value, max, tokenizer, (part) =>
				wrap(row(values.map((cell, position) => (position === index ? part : cell)))),
			);
			if (!selected) continue;
			// Never turn the escape before a pipe into a row separator at the split boundary.
			const safe = selected.endsWith("\\") && value[selected.length] === "|" ? selected.slice(0, -1) : selected;
			values[index] = safe;
			remaining[index] = value.slice(safe.length);
			consumed += safe.length;
		}
		if (!consumed)
			throw new WorkbenchError("invalid_input", "表头或列结构过长，无法在 Token 上限内保留单元格，请提高分块上限");
		rows.push(row(values));
		if (rows.length > 4000) throw new WorkbenchError("invalid_input", "表格超过 4000 个知识片段，请拆分后上传");
	}
	return rows;
}

function splitPrimaryDocument(
	parsed: ParsedDocument,
	tokenizer: KnowledgeTokenizer,
	settings: KnowledgeSettings = DEFAULT_KNOWLEDGE_SETTINGS,
	signal?: AbortSignal,
): KnowledgePassage[] {
	const passages: KnowledgePassage[] = [];
	const headings: string[] = [];
	let pending: KnowledgePassage | undefined;
	let offset = 0;
	const flush = () => {
		if (pending) {
			passages.push(pending);
			if (passages.length > 4000)
				throw new WorkbenchError("invalid_input", "文档超过 4000 个知识片段，请拆分后上传");
		}
		pending = undefined;
	};
	for (const token of Lexer.lex(parsed.markdown, { gfm: true })) {
		signal?.throwIfAborted();
		const start = offset;
		offset += token.raw.length;
		if (token.type === "space") continue;
		if (token.type === "heading") {
			flush();
			const heading = token as Tokens.Heading;
			headings.length = heading.depth - 1;
			headings[heading.depth - 1] = heading.text;
			continue;
		}
		const headingPath = headings.filter(Boolean);
		const prefix = headingPath.length
			? `${headingPath.map((heading, i) => `${"#".repeat(i + 1)} ${heading}`).join("\n")}\n\n`
			: "";
		const wrap = (body: string) => `${prefix}${body}`;
		let units: Array<{ text: string; start: number; end: number }>;
		if (tokenizer.count(wrap(token.raw.trim())) <= settings.maxChunkTokens)
			units = [{ text: token.raw.trim(), start, end: offset }];
		else {
			flush();
			let header = "";
			let footer = "";
			let body = token.raw.trim();
			let parts: string[];
			if (token.type === "table") {
				const lines = body.split("\n");
				header = `${lines.slice(0, 2).join("\n")}\n`;
				body = lines.slice(2).join("\n");
				const table = token as Tokens.Table;
				parts = table.rows.flatMap((cells) =>
					splitTableRow(
						cells.map((cell) => cell.text),
						(row) => wrap(`${header}${row.trimEnd()}`),
						tokenizer,
						settings.maxChunkTokens,
						signal,
					),
				);
			} else if (token.type === "code") {
				const code = token as Tokens.Code;
				const fenced = codeFence(code.text, code.lang ?? "").split("\n");
				header = `${fenced[0]}\n`;
				footer = `\n${fenced.at(-1)}`;
				body = code.text;
				parts = codeParts(body).flatMap((part) =>
					tokenizer.count(wrap(`${header}${part.trimEnd()}${footer}`)) <= settings.maxChunkTokens
						? [part]
						: (part.match(/[^\n]*\n|[^\n]+$/gu) ?? []),
				);
			} else if (token.type === "list") parts = (token as Tokens.List).items.map((item) => item.raw);
			else parts = body.match(/[^。！？.!?\n]+[。！？.!?\n]*|[。！？.!?\n]+/gu) ?? [body];
			const wrapped = (text: string) => wrap(`${header}${text.trimEnd()}${footer}`);
			if (tokenizer.count(wrapped("")) >= settings.maxChunkTokens)
				throw new WorkbenchError(
					"invalid_input",
					"章节标题／表头／代码围栏已占满 Token 上限，请缩短标题或提高分块上限",
				);
			units = [];
			let collected = "";
			let position = start;
			const emit = () => {
				if (collected) {
					units.push({
						text: `${header}${collected.trimEnd()}${footer}`,
						start: position,
						end: Math.min(offset, position + collected.length),
					});
					position += collected.length;
					collected = "";
				}
			};
			for (let part of parts) {
				if (collected && tokenizer.count(wrapped(collected + part)) > settings.maxChunkTokens) emit();
				while (tokenizer.count(wrapped(part)) > settings.maxChunkTokens) {
					signal?.throwIfAborted();
					const selected = fittingPrefix(part, settings.maxChunkTokens, tokenizer, wrapped);
					if (!selected)
						throw new WorkbenchError("invalid_input", "片段附加内容过长，无法在 Token 上限内保留正文");
					collected = selected;
					emit();
					part = part.slice(selected.length);
				}
				collected += part;
			}
			emit();
			// A split table/code unit refers to its entire original block; repeated wrappers have no source offset.
			if (header) units = units.map((unit) => ({ ...unit, start, end: offset }));
		}
		for (const unit of units) {
			const sources = mappedSources(parsed, unit.start, unit.end);
			const pages = sources.flatMap((source) => (source.page ? [source.page] : []));
			const passage: KnowledgePassage = {
				text: wrap(unit.text),
				headingPath,
				tokenCount: tokenizer.count(wrap(unit.text)),
				sources,
				markdownStart: unit.start,
				markdownEnd: unit.end,
				startPage: pages.length ? Math.min(...pages) : undefined,
				endPage: pages.length ? Math.max(...pages) : undefined,
			};
			const merged = pending ? `${pending.text}\n\n${unit.text}` : "";
			if (
				pending &&
				pending.startPage === passage.startPage &&
				((pending.tokenCount ?? 0) < settings.minChunkTokens ||
					(passage.tokenCount ?? 0) < settings.minChunkTokens) &&
				tokenizer.count(merged) <= settings.maxChunkTokens
			) {
				pending = {
					...pending,
					text: merged,
					tokenCount: tokenizer.count(merged),
					markdownEnd: passage.markdownEnd,
					endPage: passage.endPage,
					sources: [...(pending.sources ?? []), ...sources],
				};
			} else {
				flush();
				pending = passage;
			}
			if (passages.length >= 4000)
				throw new WorkbenchError("invalid_input", "文档超过 4000 个知识片段，请拆分后上传");
		}
	}
	flush();
	if (!passages.length && headings.some(Boolean)) {
		const text = headings
			.filter(Boolean)
			.map((heading, index) => `${"#".repeat(index + 1)} ${heading}`)
			.join("\n");
		const tokenCount = tokenizer.count(text);
		if (tokenCount > settings.maxChunkTokens)
			throw new WorkbenchError("invalid_input", "章节标题已超过 Token 上限，请缩短标题或提高分块上限");
		passages.push({
			text,
			headingPath: headings.filter(Boolean),
			tokenCount,
			sources: mappedSources(parsed, 0, parsed.markdown.length),
			markdownStart: 0,
			markdownEnd: parsed.markdown.length,
		});
	}
	return passages;
}

/** Reserves overlap before splitting; repeated Markdown structure is part of the measured input. */
export function splitDocument(
	parsed: ParsedDocument,
	tokenizer: KnowledgeTokenizer,
	settings: KnowledgeSettings = DEFAULT_KNOWLEDGE_SETTINGS,
	signal?: AbortSignal,
): KnowledgePassage[] {
	const overlap = settings.overlapTokens ?? 0;
	let primary: KnowledgePassage[];
	try {
		primary = splitPrimaryDocument(
			parsed,
			tokenizer,
			{ ...settings, maxChunkTokens: settings.maxChunkTokens - overlap },
			signal,
		);
	} catch (error) {
		if (
			!overlap ||
			!(error instanceof WorkbenchError) ||
			!/已占满 Token 上限|附加内容过长|表头或列结构过长/u.test(error.message)
		)
			throw error;
		// Long mandatory wrappers take priority over optional overlap; source text is never discarded.
		primary = splitPrimaryDocument(parsed, tokenizer, settings, signal);
	}
	if (!overlap) return primary;
	return primary.map((passage, index) => {
		signal?.throwIfAborted();
		const previous = primary[index - 1];
		const gap = previous ? parsed.markdown.slice(previous.markdownEnd, passage.markdownStart) : "";
		if (
			!previous ||
			/(?:^|\n) {0,3}#{1,6}\s/u.test(gap) ||
			JSON.stringify(previous.headingPath) !== JSON.stringify(passage.headingPath) ||
			previous.endPage !== passage.startPage ||
			JSON.stringify([...new Set(previous.sources?.map((source) => source.representation ?? source.kind))]) !==
				JSON.stringify([...new Set(passage.sources?.map((source) => source.representation ?? source.kind))])
		)
			return passage;
		const prefix = passage.headingPath?.length
			? `${passage.headingPath.map((heading, i) => `${"#".repeat(i + 1)} ${heading}`).join("\n")}\n\n`
			: "";
		const before = previous.text.slice(prefix.length);
		const body = passage.text.slice(prefix.length);
		const last = Lexer.lex(before, { gfm: true })
			.filter((token) => token.type !== "space")
			.at(-1);
		const current = Lexer.lex(body, { gfm: true })[0];
		if (!last) return passage;
		let candidates: string[];
		let wrap: (tail: string) => string;
		if (last.type === "table") {
			const lines = last.raw.trim().split("\n");
			const header = lines.slice(0, 2).join("\n");
			candidates = lines.slice(2).map((_row, i) => lines.slice(i + 2).join("\n"));
			wrap =
				current?.type === "table" && body.startsWith(header)
					? (tail) => `${prefix}${header}\n${tail}\n${body.slice(header.length).trimStart()}`
					: (tail) => `${prefix}${header}\n${tail}\n\n${body}`;
		} else if (last.type === "code") {
			const code = last as Tokens.Code;
			const lines = code.text.split("\n");
			candidates = lines.map((_line, i) => lines.slice(i).join("\n"));
			wrap =
				current?.type === "code" &&
				(current as Tokens.Code).lang === code.lang &&
				current.raw.trim() === body.trim()
					? (tail) => `${prefix}${codeFence(`${tail}\n${(current as Tokens.Code).text}`, code.lang ?? "")}`
					: (tail) => `${prefix}${codeFence(tail, code.lang ?? "")}\n\n${body}`;
		} else if (last.type === "list") {
			const items = (last as Tokens.List).items;
			candidates = items.map((_item, i) =>
				items
					.slice(i)
					.map((item) => item.raw)
					.join("\n")
					.trimEnd(),
			);
			wrap = (tail) => `${prefix}${tail}\n\n${body}`;
		} else {
			// Search Unicode boundaries in the suffix; never slice a surrogate pair.
			const characters = Array.from(last.raw.trimEnd());
			let low = 0;
			let high = characters.length;
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				if (tokenizer.count(characters.slice(-middle).join("")) <= overlap) low = middle;
				else high = middle - 1;
			}
			candidates = low ? [characters.slice(-low).join("")] : [];
			wrap = (tail) => `${prefix}${tail}${previous.markdownEnd === passage.markdownStart ? "" : "\n\n"}${body}`;
		}
		const tail = candidates.find(
			(candidate) =>
				candidate.trim() &&
				tokenizer.count(candidate) <= overlap &&
				tokenizer.count(wrap(candidate)) <= settings.maxChunkTokens,
		);
		if (!tail) return passage;
		const text = wrap(tail);
		const tailStart = parsed.markdown.lastIndexOf(tail, Math.max(0, (previous.markdownEnd ?? 0) - tail.length));
		const sources =
			tailStart >= (previous.markdownStart ?? 0) && last.type !== "table" && last.type !== "code"
				? mappedSources(parsed, tailStart, tailStart + tail.length)
				: (previous.sources ?? []);
		return {
			...passage,
			text,
			tokenCount: tokenizer.count(text),
			overlap: { tokenCount: tokenizer.count(tail), sources },
			markdownStart: sources[0]?.markdownStart ?? previous.markdownStart,
			sources: [...sources, ...(passage.sources ?? [])],
		};
	});
}
