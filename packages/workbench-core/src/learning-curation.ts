import type { LearningOutput } from "./contracts/learning.ts";
import { WorkbenchError } from "./errors.ts";

/** Evidence establishes truth; this separate gate establishes durable usefulness. */
export function assertDurableFact(item: LearningOutput["memories"][number]): void {
	if (!item.category || !item.futureUse?.trim())
		throw new WorkbenchError("invalid_input", "事实需要 category 和 futureUse，说明对未来任务的重要用途");
	if (
		/(?:本轮|本次|今天|刚刚|已完成|已生成|已输出|执行成功|任务完成|总计|共计|对话记录|会话结果|日志摘要|this (?:run|turn)|completed the task)/iu.test(
			item.text,
		)
	)
		throw new WorkbenchError("invalid_input", "任务进度、产物和统计结果应保留在情景记忆，不能写成长期事实");
}

export function assertReusableProcedure(item: LearningOutput["skills"][number]): void {
	const body = item.instructions;
	for (const section of [
		/^(?:#{1,6}[ \t]*)?(?:适用条件|适用范围|适用场景|When to use|Applicability)[ \t]*(?:[：:]|$)/imu,
		/^(?:#{1,6}[ \t]*)?(?:步骤|操作步骤|Procedure|Steps)[ \t]*(?:[：:]|$)/imu,
		/^(?:#{1,6}[ \t]*)?(?:验证|验证方法|校验|Verification)[ \t]*(?:[：:]|$)/imu,
	]) {
		if (!section.test(body))
			throw new WorkbenchError(
				"invalid_input",
				"技能必须包含适用条件、步骤和验证，例如 Markdown 的 ## 适用条件、## 步骤、## 验证；各节描述未来同类任务的方法",
			);
	}
	if (/(?:本次任务(?:中|已|的结果)|本轮(?:会话|任务)|任务执行记录|会话摘要|Session log|今天我)/iu.test(body))
		throw new WorkbenchError("invalid_input", "技能包含一次任务的叙述，请提炼参数、操作和验证方法");
}

/** Replace one existing instruction, never append a competing UPDATE paragraph. */
export function applyPreferencePatch(content: string, patch: { oldText: string; newText: string }): string {
	if (content.split(patch.oldText).length !== 2)
		throw new WorkbenchError("conflict", "流程纠正必须唯一匹配完整技能中的旧规则");
	// A workflow preference may change one rule, not rewrite verified execution steps or frontmatter.
	if (patch.oldText.includes("\n") || patch.newText.includes("\n") || patch.oldText.includes("---"))
		throw new WorkbenchError("invalid_input", "流程偏好只能原位替换一条规则，不能重写已验证流程");
	const before = content.slice(0, content.indexOf(patch.oldText));
	const lineStart = before.lastIndexOf("\n") + 1;
	const lineEnd = content.indexOf("\n", content.indexOf(patch.oldText));
	const rule = content.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
	// A generated step may combine computation and reporting. A patch confined to
	// its output clause can change ordering without rewriting the execution clause.
	const patchOffset = before.length - lineStart;
	const outputClause = [...rule.matchAll(/[^,，;；]+/gu)].some((match) => {
		const start = match.index;
		return (
			patchOffset >= start &&
			patchOffset + patch.oldText.length <= start + match[0].length &&
			/^\s*(?:并|再|然后|最后)?(?:按|以|先|输出|展示|显示|打印|Output|Display).*(?:输出|展示|显示|打印|Output|Display).*(?:报告|结果|明细|report|results)/iu.test(
				match[0],
			)
		);
	});
	const section =
		[
			...before.matchAll(
				/^(?:#{1,6}[ \t]*)?(适用条件|适用范围|步骤|操作步骤|验证|验证方法|校验|输出(?:偏好|格式|顺序)?|约束|偏好|Verification|Output|Preference)[ \t]*(?:[：:]|$)/gimu,
			),
		].at(-1)?.[1] ?? "";
	if (
		/验证|校验|Verification/iu.test(section) ||
		(!/输出|约束|偏好|Output|Preference/iu.test(section) &&
			!outputClause &&
			!/^\s*(?:\d+[.)、]\s*|[-*]\s*)?(?:生成|输出|展示|显示|Generate|Output|Display|Write).*(?:报告|明细|数量|格式|report|results)/iu.test(
				rule,
			))
	)
		throw new WorkbenchError("invalid_input", "流程偏好只能修订输出或使用约束；执行和验证步骤的改变需要成功依据");
	return content.replace(patch.oldText, patch.newText);
}
