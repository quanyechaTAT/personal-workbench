import type { KnowledgeSettings } from "@earendil-works/workbench-core";
import type { RuntimeTranscriptMessage } from "@earendil-works/workbench-runtime";

export interface QueryContext {
	role: "user" | "assistant";
	text: string;
}
export type QueryGenerator = (prompt: string, signal: AbortSignal) => Promise<string | undefined>;
export const QUERY_REFERENCE =
	/它(?:们)?|这个|这(?:项|种|个|些)|上述|前(?:者|面)|后者|该(?:版本|模型|项目|方法)|\b(?:it|its|that|these|those|former|latter)\b/iu;

export function necessaryQueryContext(query: string, transcript: RuntimeTranscriptMessage[]): QueryContext[] {
	if (!QUERY_REFERENCE.test(query)) return [];
	let remaining = 2000;
	const selected: QueryContext[] = [];
	for (const message of transcript.slice().reverse()) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n")
			.slice(-Math.min(800, remaining));
		if (text) {
			selected.unshift({ role: message.role, text });
			remaining -= text.length;
		}
		if (selected.length >= 4 || remaining <= 0) break;
	}
	return selected;
}

export function expansionPolicy(
	mode: KnowledgeSettings["mqe"],
	query: string,
	context: QueryContext[],
): { enabled: boolean; reason: string } {
	if (mode === "off") return { enabled: false, reason: "用户关闭 MQE" };
	if (mode === "always") return { enabled: true, reason: "用户设置始终启用" };
	if (QUERY_REFERENCE.test(query))
		return context.length
			? { enabled: true, reason: "问题含指代，使用本会话最近必要上下文补全" }
			: { enabled: false, reason: "问题含指代但缺少本会话上下文，保留原问题" };
	if (/比较|区别|分别|如何|怎么|为什么|\b(?:compare|difference|how|why)\b/iu.test(query))
		return { enabled: true, reason: "问题包含比较、方法或解释意图，补充不同检索表达" };
	return { enabled: false, reason: "问题已具体，自动策略使用原查询" };
}

function normalized(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\p{P}]+/gu, "");
}
const QUERY_WORDS = new Set(
	"a an the what which where when why how is are was were do does did can could should would it its that this these those and or of for in on to with by from about find search query retrieve lookup locate compare explain describe show me please data information difference between support supports use using get".split(
		" ",
	),
);
export function queryAnchors(text: string): string[] {
	const literal = [
		...text.matchAll(
			/[“「"`]([^”」"`]+)[”」"`]|\b[a-zA-Z][\w.-]*\b|\b\d+(?:[./-]\d+)*(?:%|年|月|日)?|\b(?:before|after|until|since|without|except|not|never|no)\b|不(?:要|能|允许|包含|支持|使用)?|禁止|未|不得|除外|之前|之后|截至|仅|只/gu,
		),
	]
		.map((match) => match[1] ?? match[0])
		.filter((anchor) => !QUERY_WORDS.has(anchor.toLowerCase()));
	// Keep the complete restrictive clause, so “不使用新版” cannot become “不使用旧版”.
	const restrictions = [
		...text.matchAll(
			/(?:不(?:要|能|允许|包含|支持|使用)|禁止|不得|未使用|仅使用|只使用|截至|早于|晚于)[^，。？！;；\n]{1,80}|\b(?:not|no|never|without|except|before|after|until|since)\b[^,.?!;\n]{1,100}/giu,
		),
	].map((match) => match[0].trim());
	const named = [...text.matchAll(/[\p{Script=Han}\w.-]{2,48}(?:项目|公司|大学|系统|模型|数据库)/gu)].map((match) =>
		match[0].replace(/^(?:检索|查找|查询|关于|比较|使用|请|该|这个|那个)+/u, ""),
	);
	return [...new Set([...literal, ...restrictions, ...named])];
}

export function validExpansion(query: string, candidate: string, context: QueryContext[]): boolean {
	if (
		!candidate.trim() ||
		candidate.length > 2000 ||
		/[\x00-\x1f]|```|答案(?:是|为)|原因(?:是|为)|因为|因此|是由于|\b(?:because|therefore|answer is)\b/iu.test(
			candidate,
		)
	)
		return false;
	const required = queryAnchors(query);
	const allowed = `${query}\n${QUERY_REFERENCE.test(query) ? context.map((entry) => entry.text).join("\n") : ""}`;
	return (
		required.every((anchor) => candidate.includes(anchor)) &&
		queryAnchors(candidate).every((anchor) => allowed.includes(anchor)) &&
		(context.length === 0 || !QUERY_REFERENCE.test(query) || !QUERY_REFERENCE.test(candidate))
	);
}

export async function expandQueries(
	query: string,
	settings: KnowledgeSettings,
	context: QueryContext[],
	generate?: QueryGenerator,
	signal?: AbortSignal,
): Promise<{
	queries: string[];
	mqe: { mode: KnowledgeSettings["mqe"]; applied: boolean; reason: string };
	diagnostics: string[];
}> {
	signal?.throwIfAborted();
	const policy = expansionPolicy(settings.mqe, query, context);
	const result = {
		queries: [query],
		mqe: { mode: settings.mqe, applied: false, reason: policy.reason },
		diagnostics: [] as string[],
	};
	if (!policy.enabled) return result;
	if (!generate) {
		result.diagnostics.push("MQE 模型不可用，已回退原查询");
		return result;
	}
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const prompt = JSON.stringify({ question: query, context: QUERY_REFERENCE.test(query) ? context : [] });
		const response = await Promise.race([
			generate(prompt, controller.signal),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => {
					timedOut = true;
					controller.abort();
					resolve(undefined);
				}, settings.mqeTimeoutMs);
				onAbort = () => resolve(undefined);
				controller.signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
		signal?.throwIfAborted();
		if (!response) {
			result.diagnostics.push(timedOut ? "MQE 超时，已回退原查询" : "MQE 未返回有效内容，已回退原查询");
			return result;
		}
		const value: unknown = JSON.parse(response.trim().replace(/^```json\s*|\s*```$/gu, ""));
		if (
			typeof value !== "object" ||
			value === null ||
			!("queries" in value) ||
			!Array.isArray(value.queries) ||
			value.queries.length > 2 ||
			!value.queries.every((entry) => typeof entry === "string")
		)
			throw new Error("Invalid MQE");
		const seen = new Set([normalized(query)]);
		for (const item of value.queries) {
			const candidate = String(item).trim();
			if (!validExpansion(query, candidate, context)) {
				result.diagnostics.push("MQE 扩展未通过实体／版本／时间／否定条件检查，已舍弃");
				continue;
			}
			const key = normalized(candidate);
			if (seen.has(key)) continue;
			seen.add(key);
			result.queries.push(candidate);
		}
		result.mqe.applied = result.queries.length > 1;
		if (!result.mqe.applied) result.diagnostics.push("MQE 扩展重复或无效，已回退原查询");
	} catch {
		signal?.throwIfAborted();
		result.diagnostics.push("MQE 生成失败或格式无效，已回退原查询");
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		if (onAbort) controller.signal.removeEventListener("abort", onAbort);
	}
	return result;
}
