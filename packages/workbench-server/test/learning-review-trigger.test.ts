import { expect, test } from "vitest";
import { learningReviewRequest } from "../../workbench-core/src/learning-review-trigger.ts";

test.each([
	"总结这次任务",
	"请总结一下这次任务，提取可复用的经验。",
	"任务结束了，请复盘本次工作。",
	"帮我回顾这段对话",
	"我们对这次任务进行总结",
	"请对本轮任务进行复盘",
	"总结一下",
	"Please summarize this task.",
	"Reflect on our conversation",
])("direct user closing request triggers learning: %s", (text) => {
	expect(learningReviewRequest(text)).toBe("requested");
});

test.each([
	"总结这篇文章",
	"请总结任务调度算法的原理",
	"如何通过总结这次任务触发复盘？",
	"例如：总结这次任务",
	"文档写着“总结这次任务”。继续阅读。",
	'参考示例 "summarize this task"',
	"```text\n总结这次任务\n```",
	"`总结这次任务` 是一个示例",
	"> 总结这次任务\n请检查引用的语法。",
	"不要总结这次任务，继续实现功能。",
])("documents, quotes, questions and ordinary work do not close the window: %s", (text) => {
	expect(learningReviewRequest(text)).toBeUndefined();
});

test.each([
	"总结这次任务，但不要复盘或保存经验。",
	"本轮不用学习技能。",
	"请总结一下。先不保存记忆。",
	"Summarize this task, but don't review or learn.",
])("explicit learning refusal wins over a summary request: %s", (text) => {
	expect(learningReviewRequest(text)).toBe("declined");
});
