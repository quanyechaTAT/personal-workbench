import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	DEVELOPMENT_WORKFLOW,
	LEGACY_CODING_SKILL,
	PREVIOUS_ACCEPTANCE_WORKFLOW,
	PREVIOUS_DEVELOPMENT_WORKFLOW,
	type WorkbenchPaths,
	writeTextAtomically,
} from "@earendil-works/workbench-core";

const BUILTIN_SKILLS = [
	{
		slug: "research",
		name: "资料研究",
		description: "研究问题、比较方案或核实资料时使用；检索实际来源，区分证据、推测和未解决的问题。",
		legacyName: "Research",
		legacyDescription: "Research questions with traceable sources and explicit evidence boundaries.",
		legacyInstructions: [
			"Gather sources, distinguish quotations from inference, and record useful outputs as artifacts.",
		],
		instructions: `1. 明确用户的问题、范围和交付物，先查看当前项目的资料与任务。
2. 按当前助手实际启用的能力，使用 knowledge_search 检索项目知识，或使用 web_search / browser_use 查找并阅读原始来源。技能提供研究方法，不自行提供搜索能力；缺少工具时说明限制。
3. 记录来源、日期和支持的结论。原文、事实、推测与相互矛盾的证据分别说明；无法核实的内容保持未确认。
4. 用用户要求的语言交付结论、依据和局限。重要报告保存到当前工作区，使用 artifact_register 登记真实文件。
5. 需要保留长期结论时使用 memory_propose，等待用户确认。权限与工具调用方式沿用当前助手；PTC 助手通过 run_code 调用已选工具。`,
	},
	{
		slug: "coding",
		name: "代码开发",
		description: "实现功能、修复错误或审查代码时使用；检查项目规范，完成改动，并报告实际验证结果。",
		legacyName: "Coding",
		legacyDescription: "Implement and verify changes inside the selected project workspace.",
		legacyInstructions: [
			LEGACY_CODING_SKILL,
			PREVIOUS_DEVELOPMENT_WORKFLOW,
			PREVIOUS_ACCEPTANCE_WORKFLOW,
			DEVELOPMENT_WORKFLOW,
		],
		instructions: DEVELOPMENT_WORKFLOW,
	},
	{
		slug: "project-planning",
		name: "项目规划",
		description: "拆分项目目标、安排下一步或设计助手能力时使用；依据现有状态制定可执行、可验收的任务。",
		legacyName: "Project Planning",
		legacyDescription: "Turn a project goal into concrete, reviewable tasks.",
		legacyInstructions: [
			"Read the project state and tasks, identify the next useful outcome, and keep plans concise.",
		],
		instructions: `1. 读取当前项目说明、任务和相关记忆，核对目标、约束、已有成果及未完成工作。
2. 给出最少必要步骤，每步说明产出、依赖和完成条件；多步开发使用已启用的 update_plan，保持最多一步进行中。
3. 用户要求建立任务时，通过 task_create / task_update 保存，使用 task_list 核对结果。缺少工具时交付明确计划，说明尚未持久化。
4. 用户要求创建助手时，使用已启用的 assistant_catalog 核对真实能力，再由 assistant_create 创建并用 assistant_inspect 验证。不要虚构工具、技能或连接。
5. 依据用户补充的信息更新计划。创建任务不代表执行完毕，计划完成不代表验证通过；不自动委派其他助手。`,
	},
	{
		slug: "weekly-review",
		name: "每周回顾",
		description: "整理一周进展、未完成任务、决策与下周重点时使用；依据工作记录回顾并提出待确认的记忆。",
		legacyName: "Weekly Review",
		legacyDescription: "Review completed work, open tasks, decisions, and proposed memories.",
		legacyInstructions: [
			"Summarize verified progress and propose durable memories for user review instead of writing them directly.",
		],
		instructions: `1. 确定回顾时间范围，使用当前助手启用的项目、任务和 memory_search 工具读取真实记录；范围不明时说明采用的日期范围。
2. 分别整理已验证成果、未完成任务、阻塞、关键决策和下周重点，附上对应项目、任务或成果引用。
3. 区分已完成、待审核与计划执行，不凭对话承诺把任务标成完成。不清理或删除历史文件来代替回顾。
4. 用户要求保存时，将回顾文档写入当前工作区并登记 artifact。长期信息通过 memory_propose 提出候选，保留用户确认流程。
5. 使用用户要求的语言交付简洁回顾，明确缺失记录和不确定之处；权限与工具调用方式沿用当前助手。`,
	},
] as const;

const BUILTIN_SKILL_SLUGS = new Set<string>(BUILTIN_SKILLS.map((skill) => skill.slug));

export function isBuiltinSkill(slug: string): boolean {
	return BUILTIN_SKILL_SLUGS.has(slug);
}

async function writeNew(path: string, content: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "wx");
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return;
		throw error;
	} finally {
		await handle?.close();
	}
}

export async function installBuiltinSkills(paths: WorkbenchPaths): Promise<void> {
	for (const skill of BUILTIN_SKILLS) {
		const directory = join(paths.skills, skill.slug);
		await mkdir(directory, { recursive: true });
		const path = join(directory, "SKILL.md");
		const prefix = `---\nname: ${skill.slug}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n# ${skill.name}\n\n`;
		const content = `${prefix}${skill.instructions}\n`;
		try {
			const existing = await readFile(path, "utf8");
			let repaired = existing;
			const metadata = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u.exec(existing);
			if (metadata) {
				const header = metadata[2].replace(
					/^name:[ \t]*([^\r\n]+?)[ \t]*(\r?)$/mu,
					(line: string, name: string, cr: string) => {
						const value = name.trim().replace(/^(['"])([\s\S]*)\1$/u, "$2");
						return value === skill.legacyName ? `name: ${skill.slug}${cr}` : line;
					},
				);
				repaired = `${metadata[1]}${header}${metadata[3]}${existing.slice(metadata[0].length)}`;
			}
			const legacyPrefix = `---\nname: ${skill.slug}\ndescription: ${skill.legacyDescription}\n---\n\n# ${skill.legacyName}\n\n`;
			if (
				[legacyPrefix, prefix].some((candidatePrefix) =>
					skill.legacyInstructions.some(
						(instructions) => `${candidatePrefix}${instructions}` === repaired.replace(/\r\n/gu, "\n").trimEnd(),
					),
				)
			)
				repaired = content;
			if (repaired !== existing) await writeTextAtomically(path, repaired);
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		}
		await writeNew(path, content);
	}
}
