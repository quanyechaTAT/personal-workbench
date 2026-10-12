import type { KnowledgeHydeTrace, KnowledgeSettings } from "@earendil-works/workbench-core";
import { QUERY_REFERENCE, type QueryContext, type QueryGenerator, queryAnchors } from "./knowledge-mqe.ts";

export function hydePolicy(mode: KnowledgeHydeTrace["mode"], query: string, context: QueryContext[]) {
	if (mode === "off") return { enabled: false, reason: "用户关闭 HyDE" };
	if (mode === "always") return { enabled: true, reason: "用户设置始终启用 HyDE" };
	if (/\d|不使用|不得|禁止|仅使用|截至|\b(?:not|never|without|before|after|until)\b/iu.test(query))
		return { enabled: false, reason: "问题含精确数值、版本或限制，自动策略保留常规检索" };
	if (QUERY_REFERENCE.test(query))
		return context.length
			? { enabled: true, reason: "问题含指代，用本会话必要上下文生成假设检索文档" }
			: { enabled: false, reason: "指代缺少本会话上下文，不生成假设文档" };
	return /如何|怎么|为什么|比较|区别|方法|流程|\b(?:how|why|compare|difference|method)\b/iu.test(query)
		? { enabled: true, reason: "问题包含方法或比较意图，生成一段假设检索文档" }
		: { enabled: false, reason: "问题已具体，自动策略使用常规检索" };
}

export function validHypothesis(query: string, document: string, context: QueryContext[]): boolean {
	if (
		document.length < 20 ||
		document.length > 1600 ||
		/[\x00-\x08\x0b\x0c\x0e-\x1f]|```|https?:\/\/|\bdoi\s*:|\[\d+\]/iu.test(document)
	)
		return false;
	if (!queryAnchors(query).every((anchor) => document.includes(anchor))) return false;
	const allowed = `${query}\n${QUERY_REFERENCE.test(query) ? context.map((entry) => entry.text).join("\n") : ""}`;
	const specific = /\b(?:[a-z][\w.-]*\d[\w.-]*|v?\d+(?:[./-]\d+)*(?:%|年|月|日)?)\b/giu;
	const allowedSpecific = new Set(Array.from(allowed.matchAll(specific), (match) => match[0]));
	if (Array.from(document.matchAll(specific)).some((match) => !allowedSpecific.has(match[0]))) return false;
	const normalized = (text: string) =>
		text
			.normalize("NFKC")
			.replace(/[\s\p{P}]+/gu, "")
			.toLowerCase();
	return (
		normalized(document) !== normalized(query) &&
		(!QUERY_REFERENCE.test(query) || !context.length || !QUERY_REFERENCE.test(document))
	);
}

/** A hypothesis is a transient vector probe; it is never a source document or answer evidence. */
export async function generateHyde(
	query: string,
	settings: KnowledgeSettings,
	context: QueryContext[],
	generate?: QueryGenerator,
	signal?: AbortSignal,
): Promise<{ hyde: KnowledgeHydeTrace; diagnostics: string[] }> {
	signal?.throwIfAborted();
	const mode = settings.hyde ?? "off";
	const policy = hydePolicy(mode, query, context);
	const result: { hyde: KnowledgeHydeTrace; diagnostics: string[] } = {
		hyde: { mode, applied: false, reason: policy.reason },
		diagnostics: [],
	};
	if (!policy.enabled) return result;
	if (!generate) {
		result.diagnostics.push("HyDE 对话模型不可用，保留原查询与常规检索");
		return result;
	}
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const response = await Promise.race([
			generate(
				JSON.stringify({ question: query, context: QUERY_REFERENCE.test(query) ? context : [] }),
				controller.signal,
			),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => {
					timedOut = true;
					controller.abort();
					resolve(undefined);
				}, settings.hydeTimeoutMs ?? 2500);
				onAbort = () => resolve(undefined);
				controller.signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
		signal?.throwIfAborted();
		if (!response) {
			result.diagnostics.push(timedOut ? "HyDE 超时，保留常规检索" : "HyDE 未返回有效内容，保留常规检索");
			return result;
		}
		const value: unknown = JSON.parse(response.trim());
		if (
			typeof value !== "object" ||
			!value ||
			!("document" in value) ||
			typeof value.document !== "string" ||
			!validHypothesis(query, value.document.trim(), context)
		) {
			result.diagnostics.push("HyDE 假设文档未通过格式、实体、版本或限制检查，已舍弃");
			return result;
		}
		result.hyde.document = value.document.trim();
	} catch {
		signal?.throwIfAborted();
		result.diagnostics.push("HyDE 生成失败或格式无效，保留常规检索");
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		if (onAbort) controller.signal.removeEventListener("abort", onAbort);
	}
	return result;
}
