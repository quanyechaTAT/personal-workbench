import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { LearningOutput } from "@earendil-works/workbench-core/contracts";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import type { createAssistantFixture } from "./assistant-fixture.ts";

export type LearningFixture = Awaited<ReturnType<typeof createAssistantFixture>>;
export const LEARNED_FACT = "项目使用 Python 3.12。";
export const LEARNED_INSTRUCTIONS =
	"## 适用条件\n检查项目文件结构时使用。\n\n## 步骤\n1. 列出当前项目目录。\n2. 先阅读 AGENTS.md，再确定下一步。\n\n## 输出\n先展示目录名称，再展示文件数量。\n\n## 验证\n核对工具返回的真实文件名；遵守会话权限。";

export function similarityResponse(context: Context, relation: "duplicate" | "related" = "duplicate") {
	if (context.tools?.length) throw new Error("Similarity review must have no tools");
	const message = context.messages.at(-1);
	if (message?.role !== "user") throw new Error("Expected similarity input");
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	const input = Parse(
		Type.Object({
			operation: Type.Literal("memory-similarity"),
			existing: Type.Array(Type.Object({ id: Type.String() }), { minItems: 1 }),
		}),
		JSON.parse(text),
	);
	return fauxAssistantMessage(
		JSON.stringify({ relation, targetId: input.existing[0].id, reason: "同一适用条件与方法，按已有经验处理。" }),
	);
}
const InputSchema = Type.Object({
	sources: Type.Array(
		Type.Object({ id: Type.String(), role: Type.String(), text: Type.String(), verified: Type.Boolean() }),
	),
});

export function reviewOutput(context: Context): LearningOutput {
	const message = context.messages.at(-1);
	if (message?.role !== "user") throw new Error("Expected isolated review input");
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n");
	const input = Parse(InputSchema, JSON.parse(text));
	const user = input.sources.find((source) => source.role === "user");
	const tool = input.sources.find((source) => source.role === "tool" && source.verified && source.text.length >= 4);
	if (!user || !tool) throw new Error("Review lacks verifiable user/tool sources");
	return {
		summary: "提取项目版本约束与目录检查流程",
		memories: [
			{
				text: LEARNED_FACT,
				category: "environment",
				futureUse: "后续开发选择项目要求的 Python 运行环境",
				evidence: [{ sourceId: user.id, quote: LEARNED_FACT }],
			},
		],
		skills: [
			{
				slug: "learned-inspect-project",
				title: "项目目录检查",
				description: "检查当前项目的文件结构、目标和记忆时使用。",
				instructions: LEARNED_INSTRUCTIONS,
				evidence: [{ sourceId: tool.id, quote: tool.text.slice(0, 100) }],
			},
		],
	};
}

export async function completeLearningTask(
	fixture: LearningFixture,
	projectId: string,
	trigger: "periodic" | "deferred" = "periodic",
	output: (context: Context) => unknown = reviewOutput,
) {
	// These legacy tests exercise review application, explicitly at a short periodic boundary.
	// Default production cadence is tested independently in learning-curation.integration.test.ts.
	await fixture.application.services.learning.configure(projectId, {
		memoryInterval: trigger === "periodic" ? 1 : 0,
		skillInterval: 0,
	});
	const session = await fixture.application.createSession({ projectId });
	fixture.faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
		() => fauxAssistantMessage("已检查项目目录。"),
		...(trigger === "periodic"
			? [
					(context: Context) => {
						if (context.tools?.length) throw new Error("Background review must have no active tools");
						if (!context.systemPrompt?.includes("项目经验审核员")) throw new Error("Review is not isolated");
						return fauxAssistantMessage(JSON.stringify(output(context)));
					},
				]
			: []),
	]);
	const submitted = await fixture.request(`/sessions/${session.id}/messages`, {
		method: "POST",
		body: JSON.stringify({ text: `记住：${LEARNED_FACT} 请检查项目目录。` }),
	});
	if (submitted.status !== 202) throw new Error(`Message failed: ${await submitted.text()}`);
	const run = Parse(Type.Object({ runId: Type.String() }), await submitted.json());
	const stream = await (await fixture.request(`/runs/${run.runId}/events`)).text();
	if (!stream.includes('"type":"run.completed"')) throw new Error(`Task did not complete: ${stream}`);
	return { session, runId: run.runId };
}
