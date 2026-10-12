import {
	createLocalPowerShellOperations,
	createPowerShellToolDefinition,
	type ExtensionAPI,
	type PowerShellToolOptions,
} from "@earendil-works/pi-coding-agent";
import {
	DEVELOPMENT_ENTRY_TYPE,
	type DevelopmentCheck,
	type DevelopmentState,
	developmentAcceptanceIssues,
	errorMessage,
} from "@earendil-works/workbench-runtime";
import { Type } from "typebox";
import type { WorkbenchToolScope } from "./workbench-extension.ts";

export interface DevelopmentExtensionOptions {
	resolveScope(cwd: string): Promise<WorkbenchToolScope>;
	onUpdate?(state: DevelopmentState): void;
	powerShellOptions?: PowerShellToolOptions;
}

export function registerDevelopmentTools(pi: ExtensionAPI, options: DevelopmentExtensionOptions): void {
	let state: DevelopmentState | undefined;
	let userMessages = 0;
	// Match direct restrictions, excluding phrases such as "不要跳过测试".
	const noVerification =
		/(?:不要|禁止|不得|不能|不许|无需|不需要)(?:再|进行|运行|执行|做|调用|任何|所有|自动|额外|一个|\s){0,10}(?:测试|验证|检查|验收)|\b(?:do not|don't|must not|never|no)\s+(?:run\s+|perform\s+|execute\s+|call\s+|any\s+)*(?:tests?|testing|checks?|verification|verify_changes)\b/iu;
	const allowVerification =
		/(?:现在可以|允许|需要|请|必须)(?:再|进行|运行|执行|做|调用|任何|所有|自动|额外|一个|\s){0,10}(?:测试|验证|检查|验收)|\b(?:now|please)\s+(?:run|perform|execute)\s+(?:tests?|checks?)\b/iu;
	const publish = () => {
		if (!state) return;
		const snapshot = structuredClone(state);
		pi.appendEntry(DEVELOPMENT_ENTRY_TYPE, snapshot);
		options.onUpdate?.(snapshot);
	};
	const invalidate = () => {
		if (!state) return;
		state.revision++;
		state.acceptance =
			state.verificationPolicy === "user_disabled"
				? { status: "not_required", reason: "按用户要求直接交付，未运行检查", criteria: [] }
				: { status: "pending", reason: "改动或要求已变化，需要重新检查与验收", criteria: [] };
		for (const check of state.checks) {
			if (check.status === "passed" || check.status === "failed" || check.status === "running") {
				check.status = "stale";
			}
		}
		publish();
	};
	pi.on("before_agent_start", async (event, context) => {
		if (
			!pi
				.getActiveTools()
				.some(
					(name) =>
						name === "update_plan" ||
						name === "verify_changes" ||
						name === "accept_changes" ||
						["write", "edit", "powershell", "bash", "exec_command", "persistent_shell"].includes(name) ||
						(name === "run_code" &&
							pi.getAllTools().some((tool) => tool.name === "update_plan" || tool.name === "verify_changes")),
				)
		) {
			state = undefined;
			return;
		}
		const scope = await options.resolveScope(context.cwd);
		if (!scope.runId) {
			state = undefined;
			return;
		}
		if (state?.runId === scope.runId) {
			// Queued requests share one Workbench run: keep prior edits and evidence.
			userMessages = 1;
			return;
		}
		userMessages = 0;
		state = {
			runId: scope.runId,
			plan: [],
			checks: [],
			changedFiles: [],
			revision: 0,
			requiresAcceptance: false,
			acceptance: { status: "not_required", reason: "尚无开发改动", criteria: [] },
			...(noVerification.test(event.prompt) ? { verificationPolicy: "user_disabled" as const } : {}),
		};
		publish();
	});
	pi.on("message_start", (event) => {
		if (event.message.role !== "user" || ++userMessages <= 1) return;
		const text =
			typeof event.message.content === "string"
				? event.message.content
				: event.message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		if (state && noVerification.test(text)) {
			state.verificationPolicy = "user_disabled";
			state.requiresAcceptance = false;
		} else if (state?.verificationPolicy === "user_disabled" && allowVerification.test(text)) {
			delete state.verificationPolicy;
			state.requiresAcceptance = true;
		}
		invalidate();
	});
	pi.on("tool_call", (event) => {
		if (state?.verificationPolicy === "user_disabled" && event.toolName === "verify_changes")
			return { block: true, reason: "用户明确禁止运行检查；直接交付并说明未验证，不需要开发验收" };
		if (
			event.toolName === "task_update" &&
			event.input.status === "done" &&
			state?.requiresAcceptance &&
			(state.acceptance.status !== "accepted" || developmentAcceptanceIssues(state).length)
		)
			return { block: true, reason: "开发工作尚未通过验收，不能将任务标为已完成" };
		return undefined;
	});
	pi.on("tool_execution_start", (event) => {
		if (
			event.toolName === "write" ||
			event.toolName === "edit" ||
			event.toolName === "powershell" ||
			event.toolName === "bash" ||
			event.toolName === "exec_command" ||
			(event.toolName === "write_stdin" && event.args.chars) ||
			(event.toolName === "persistent_shell" &&
				(event.args.action === undefined ||
					event.args.action === "command" ||
					event.args.action === "exec" ||
					event.args.chars))
		)
			invalidate();
	});
	pi.on("tool_result", (event, context) => {
		if (!state) return;
		if (
			["write", "edit", "powershell", "bash", "exec_command"].includes(event.toolName) ||
			(event.toolName === "write_stdin" && event.input.chars) ||
			(event.toolName === "persistent_shell" &&
				(event.input.action === undefined ||
					event.input.action === "command" ||
					event.input.action === "exec" ||
					event.input.chars))
		) {
			state.requiresAcceptance = state.verificationPolicy !== "user_disabled";
			if (state.requiresAcceptance && state.acceptance.status === "not_required")
				state.acceptance = { status: "pending", reason: "开发工作待验收", criteria: [] };
			publish();
		}
		if (
			(event.toolName === "write" || event.toolName === "edit") &&
			!event.isError &&
			typeof event.input.path === "string"
		) {
			invalidate();
			state.changedFiles = [...new Set([...state.changedFiles, event.input.path])].slice(-100);
			publish();
		}
		if (
			event.toolName === "verify_changes" &&
			state.verificationPolicy !== "user_disabled" &&
			!state.checks.some((check) => check.id === event.toolCallId)
		) {
			state.checks.push({
				id: event.toolCallId,
				command: typeof event.input.command === "string" ? event.input.command : "",
				status: context.signal?.aborted ? "cancelled" : "failed",
				revision: state.revision,
				exitCode: null,
				output: event.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n")
					.slice(-16_000),
			});
			state.requiresAcceptance = state.verificationPolicy !== "user_disabled";
			state.checks = state.checks.slice(-20);
			publish();
		}
		// Approval denial, expiry and argument errors occur before execute records its ID.
		// Give the Agent real recovery references without exposing commands or raw output again.
		if (event.toolName === "verify_changes" && event.isError) {
			const check = state.checks.find((value) => value.id === event.toolCallId);
			if (check)
				return {
					content: [
						...event.content,
						{
							type: "text" as const,
							text: `Verification ID: ${check.id}; status: ${check.status}. Correct this check using its exact ID and a coverage reason.`,
						},
					],
				};
		}
		if (event.toolName === "accept_changes" && event.isError)
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: `Verification state: ${JSON.stringify({
							revision: state.revision,
							checks: state.checks.map(({ id, status, revision, exitCode, replaces }) => ({
								id,
								status,
								revision,
								exitCode,
								...(replaces ? { replaces: replaces.map((link) => link.checkId) } : {}),
							})),
						})}. Use exact recorded IDs; a passed replacement only covers its linked checks at this revision.`,
					},
				],
			};
		return undefined;
	});
	pi.registerTool({
		name: "update_plan",
		label: "开发计划",
		description:
			"Update the current development plan. Use short steps and at most one in_progress step. Completing a plan does not mark verification passed.",
		parameters: Type.Object({
			plan: Type.Array(
				Type.Object({
					step: Type.String({ minLength: 1, maxLength: 500 }),
					status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
				}),
				{ minItems: 1, maxItems: 20 },
			),
			explanation: Type.Optional(Type.String({ maxLength: 2_000 })),
		}),
		execute: async (_id, input) => {
			if (!state) throw new Error("No active development run");
			if (input.plan.filter((step) => step.status === "in_progress").length > 1)
				throw new Error("Only one plan step can be in_progress");
			if (
				(state.plan.length || state.acceptance.status === "accepted") &&
				JSON.stringify(state.plan.map((step) => step.step)) !== JSON.stringify(input.plan.map((step) => step.step))
			)
				invalidate();
			state.plan = input.plan;
			state.requiresAcceptance = state.verificationPolicy !== "user_disabled";
			if (state.requiresAcceptance && state.acceptance.status === "not_required")
				state.acceptance = { status: "pending", reason: "开发计划待验收", criteria: [] };
			if (state.acceptance.status === "accepted" && input.plan.some((step) => step.status !== "completed"))
				state.acceptance = { status: "pending", reason: "开发计划仍有未完成步骤", criteria: [] };
			publish();
			return {
				content: [{ type: "text", text: input.plan.map((step) => `${step.status}: ${step.step}`).join("\n") }],
				details: { plan: input.plan },
			};
		},
	});
	pi.registerTool({
		name: "verify_changes",
		label: "验证改动",
		description:
			"Execute a verification command in the session workspace using PowerShell and record its actual exit code and output. Obey repository and user restrictions. Preserve native exit status. Permission approval and cancellation apply as for powershell. To correct a failed/cancelled/stale check with a different command, provide replaces [{checkId,reason}] using its actual Verification ID and explain how the replacement covers the original requirement. Recovery links only take effect if this command passes at the current revision; other failed checks still block acceptance. Passing a command does not prove full functional coverage.",
		parameters: Type.Object({
			command: Type.String({ minLength: 1, maxLength: 8_000 }),
			timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
			replaces: Type.Optional(
				Type.Array(
					Type.Object({
						checkId: Type.String({ minLength: 1 }),
						reason: Type.String({ minLength: 4, maxLength: 1000 }),
					}),
					{ maxItems: 20 },
				),
			),
		}),
		execute: async (id, input, signal, onUpdate, context) => {
			if (!state) throw new Error("No active development run");
			if (state.verificationPolicy === "user_disabled") throw new Error("用户禁止运行检查");
			if (!input.command.trim()) throw new Error("Verification command cannot be blank");
			for (const link of input.replaces ?? []) {
				const target = state.checks.find((value) => value.id === link.checkId);
				if (!target || !["failed", "cancelled", "stale"].includes(target.status) || link.reason.trim().length < 4)
					throw new Error("替代检查必须关联本运行中实际失败、取消或过期的检查，并说明覆盖依据");
			}
			state.requiresAcceptance = true;
			state.acceptance = { status: "pending", reason: "正在检查，等待功能验收", criteria: [] };
			const check: DevelopmentCheck = {
				id,
				command: input.command,
				status: "running",
				exitCode: null,
				output: "",
				revision: state.revision,
				...(input.replaces?.length ? { replaces: input.replaces } : {}),
			};
			state.checks = [...state.checks, check].slice(-20);
			publish();
			const operations = options.powerShellOptions?.operations ?? createLocalPowerShellOperations();
			const tool = createPowerShellToolDefinition(context.cwd, {
				...options.powerShellOptions,
				exposeSessionEnvironment: false,
				operations: {
					exec: async (command, cwd, executionOptions) => {
						const result = await operations.exec(command, cwd, executionOptions);
						check.exitCode = result.exitCode;
						return result;
					},
				},
			});
			try {
				const result = await tool.execute(
					id,
					{ command: input.command, timeout: input.timeout ?? 120 },
					signal,
					onUpdate,
					context,
				);
				if (check.exitCode !== 0) throw new Error("Verification did not return exit code 0");
				check.status = check.revision === state.revision ? "passed" : "stale";
				check.output = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n")
					.slice(-16_000);
				publish();
				return {
					...result,
					content: [
						...result.content,
						{
							type: "text" as const,
							text: `Verification ID: ${id}; status: ${check.status}. Reference this ID in accept_changes after checking requirement coverage.`,
						},
					],
					details: { ...result.details, verification: { ...check } },
				};
			} catch (error) {
				check.status = signal?.aborted ? "cancelled" : "failed";
				check.output = errorMessage(error).slice(-16_000);
				publish();
				throw new Error(
					`${errorMessage(error)}\nVerification ID: ${id}; status: ${check.status}. A corrected verification may explicitly replace this ID with a coverage reason.`,
				);
			}
		},
	});
	pi.registerTool({
		name: "accept_changes",
		label: "验收改动",
		description:
			"Submit a functional acceptance checklist after verification. Map each user requirement to current passed verify_changes IDs and explain what the output proves. Must cover the authorized request and repository checks; an echo/exit 0 command is not functional evidence. The server rejects missing, failed, running, stale or superseded checks and unfinished plan steps. Normal run end never implies acceptance. Report remaining limitations instead of claiming completion if acceptance is rejected.",
		parameters: Type.Object({
			criteria: Type.Array(
				Type.Object({
					requirement: Type.String({ minLength: 1, maxLength: 1000 }),
					checkIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
					evidence: Type.String({ minLength: 1, maxLength: 2000 }),
				}),
				{ minItems: 1, maxItems: 20 },
			),
		}),
		execute: async (_id, input) => {
			if (!state) throw new Error("No active development run");
			if (state.verificationPolicy === "user_disabled")
				return {
					content: [{ type: "text", text: "按用户要求直接交付，未运行检查，不声明通过验收。" }],
					details: { acceptance: { status: "not_required" } },
				};
			state.requiresAcceptance = true;
			state.acceptance.criteria = input.criteria;
			const issues = developmentAcceptanceIssues(state);
			state.acceptance.status = issues.length ? "needs_verification" : "accepted";
			state.acceptance.reason = issues.length ? issues.join("；") : "需求已逐项关联到当前通过的检查";
			publish();
			if (issues.length) throw new Error(`验收未通过：${state.acceptance.reason}`);
			return {
				content: [{ type: "text", text: JSON.stringify(state.acceptance, null, 2) }],
				details: { acceptance: structuredClone(state.acceptance) },
			};
		},
	});
}
