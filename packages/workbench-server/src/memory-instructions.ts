import { createHash } from "node:crypto";
import type { MemoryContextFragment, MemoryScopeType } from "@earendil-works/workbench-core";

const scopes = {
	global: { priority: 0, label: "全局" },
	personal: { priority: 1, label: "个人" },
	project: { priority: 2, label: "项目" },
	session: { priority: 3, label: "会话" },
};

/** Recognize user conventions conservatively; never infer an answer or promote retrieved documents. */
export function memoryInstruction(
	scope: MemoryScopeType,
	heading: string | undefined,
	text: string,
): MemoryContextFragment["instruction"] {
	// Examples retain their full bodies, but code cannot define an instruction's subject.
	const prose = text.split(/^\s*(?:`{3,}|~{3,}|<!doctype\b|<(?:html|svg|div|script)\b)/imu)[0].trim();
	const body = prose.replace(/^\s*(?:[-*+]|\d+\.)\s+/u, "").trim();
	const label =
		/^(?:你叫|你的(?:名字|昵称|称呼|名称|模型名(?:称)?)(?:是|为)|(?:your (?:name|model name) is|call yourself)\s+)\S[^\n。！？]*[。！？]?\s*$/iu.test(
			body,
		);
	const condition =
		/^(?:当|如果|若)(?:用户|我)(?:询问|问起|问|要求|请求|说)(.+?)(?:的时候|时)[，,:：]\s*\S/su.exec(body)?.[1] ??
		/^when (?:the )?user (?:asks|says|requests)\s+(.+?)(?:,|\s+then\s+)\s*\S/isu.exec(body)?.[1];
	const subjects: string[] = [];
	if (label) subjects.push("assistant.label");
	else if (condition) {
		const trigger = condition.toLocaleLowerCase().replace(/[\s\p{P}]/gu, "");
		subjects.push(
			/^(?:(?:你(?:的)?|当前|你当前使用的))?(?:模型名(?:称)?|模型型号|模型名称|名字|昵称|称呼|modelname|yourmodelname|yourname|whatmodelareyouusing)$/u.test(
				trigger,
			)
				? "assistant.label"
				: `response-trigger:${createHash("sha256").update(trigger).digest("hex")}`,
		);
	}
	const directive =
		/必须遵循|回答约定|行为约定|表达约定|(?:^|\n)#{1,6}\s+(?:instructions?|执行规则|行为规则)(?:\s|$)/iu.test(
			heading ?? "",
		) ||
		/^(?:请(?:用|使用|回答|回复|遵循)|必须|不要|不得|始终|使用|采用|保持|输出(?:应|须|必须)|默认(?:用|使用|回答)|(?:回答|回复)(?:时|全部|始终|使用)|always\b|never\b|do not\b|respond\b|answer\b)/iu.test(
			body,
		);
	return label || condition || directive ? { scope, subjects } : undefined;
}

/** Apply scope defaults before budgets; leave originals, fact validity and explicit search untouched. */
export function resolveMemoryInstructionScopes(
	fragments: MemoryContextFragment[],
	diagnostics: string[],
): MemoryContextFragment[] {
	const strongest = new Map<string, MemoryScopeType>();
	for (const fragment of fragments)
		for (const subject of fragment.instruction?.subjects ?? []) {
			const scope = fragment.instruction!.scope;
			const previous = strongest.get(subject);
			if (!previous || scopes[scope].priority > scopes[previous].priority) strongest.set(subject, scope);
		}
	const applicable = fragments.filter((fragment) => {
		if (!fragment.instruction) return true;
		const { scope, subjects } = fragment.instruction;
		const overriding = subjects
			.map((subject) => strongest.get(subject))
			.find((value) => value !== undefined && scopes[value].priority > scopes[scope].priority);
		if (!overriding) return true;
		diagnostics.push(
			`范围优先级：${fragment.label} 中的同类回答约定本轮由${scopes[overriding].label}约定覆盖；原文保留。`,
		);
		return false;
	});
	// Executable conventions precede factual recall, retaining relevance order within each group.
	return [
		...applicable.filter((fragment) => fragment.layer === "working"),
		...applicable.filter((fragment) => fragment.instruction),
		...applicable.filter((fragment) => fragment.layer !== "working" && !fragment.instruction),
	];
}
