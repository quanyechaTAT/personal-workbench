export interface DevelopmentStep {
	step: string;
	status: "pending" | "in_progress" | "completed";
}

export interface DevelopmentCheck {
	id: string;
	command: string;
	status: "running" | "passed" | "failed" | "cancelled" | "stale";
	exitCode: number | null;
	output: string;
	revision: number;
	/** Explicit recovery links; effective only after this replacement passes at the current revision. */
	replaces?: { checkId: string; reason: string }[];
}

export interface DevelopmentCriterion {
	requirement: string;
	checkIds: string[];
	evidence: string;
}

export interface DevelopmentAcceptance {
	status: "not_required" | "pending" | "needs_verification" | "needs_review" | "accepted" | "failed" | "cancelled";
	reason: string;
	criteria: DevelopmentCriterion[];
}

export interface DevelopmentState {
	runId: string;
	plan: DevelopmentStep[];
	checks: DevelopmentCheck[];
	changedFiles: string[];
	revision: number;
	requiresAcceptance: boolean;
	/** Set only from an explicit user restriction, never from an assistant verdict. */
	verificationPolicy?: "user_disabled";
	acceptance: DevelopmentAcceptance;
}

export const DEVELOPMENT_ENTRY_TYPE = "workbench.development";

function currentChecks(state: DevelopmentState): DevelopmentCheck[] {
	const replaced = new Set<string>();
	for (const [index, check] of state.checks.entries()) {
		if (check.status !== "passed" || check.exitCode !== 0 || check.revision !== state.revision) continue;
		for (const link of check.replaces ?? []) {
			const target = state.checks.slice(0, index).find((value) => value.id === link.checkId);
			if (target && ["failed", "cancelled", "stale"].includes(target.status) && link.reason.trim().length >= 4)
				replaced.add(target.id);
		}
	}
	return [...new Map(state.checks.map((check) => [check.command, check])).values()].filter(
		(check) => !replaced.has(check.id),
	);
}

/** These are necessary evidence gates, not a claim of exhaustive functional coverage. */
export function developmentAcceptanceIssues(state: DevelopmentState): string[] {
	const issues: string[] = [];
	const latestChecks = currentChecks(state);
	if (!latestChecks.length) issues.push("尚未运行检查");
	if (
		latestChecks.some(
			(check) => check.status !== "passed" || check.exitCode !== 0 || check.revision !== state.revision,
		)
	)
		issues.push("存在失败、取消、执行中或已过期的检查");
	if (state.plan.some((step) => step.status !== "completed")) issues.push("开发计划仍有未完成步骤");
	if (!state.acceptance.criteria.length) issues.push("尚未逐项核对需求与检查证据");
	for (const criterion of state.acceptance.criteria) {
		if (
			!criterion.requirement.trim() ||
			!criterion.evidence.trim() ||
			!criterion.checkIds.length ||
			criterion.checkIds.some(
				(id) =>
					!latestChecks.some(
						(check) =>
							check.id === id &&
							check.status === "passed" &&
							check.exitCode === 0 &&
							check.revision === state.revision,
					),
			)
		)
			issues.push(`验收项缺少当前通过的检查：${criterion.requirement}`);
	}
	return issues;
}

export function settleDevelopment(
	state: DevelopmentState,
	outcome: "completed" | "failed" | "aborted",
): DevelopmentState {
	const result = structuredClone(state);
	if (!result.requiresAcceptance) {
		result.acceptance = {
			status: "not_required",
			reason:
				result.verificationPolicy === "user_disabled"
					? "按用户要求直接交付，未运行检查"
					: "本轮没有开发改动或验收请求",
			criteria: [],
		};
		return result;
	}
	const issues = developmentAcceptanceIssues(result);
	if (outcome !== "completed") {
		result.acceptance.status = outcome === "aborted" ? "cancelled" : "failed";
		result.acceptance.reason = outcome === "aborted" ? "运行已停止，未完成验收" : "运行失败，未完成验收";
	} else if (issues.length || result.acceptance.status !== "accepted") {
		result.acceptance.status =
			result.checks.length &&
			currentChecks(result).every(
				(check) => check.status === "passed" && check.exitCode === 0 && check.revision === result.revision,
			)
				? "needs_review"
				: "needs_verification";
		result.acceptance.reason = issues.length ? issues.join("；") : "检查已通过，尚未提交功能验收";
	}
	return result;
}

export function isDevelopmentState(value: unknown): value is DevelopmentState {
	if (typeof value !== "object" || value === null) return false;
	if (!("runId" in value) || typeof value.runId !== "string") return false;
	if (
		!("revision" in value) ||
		typeof value.revision !== "number" ||
		!Number.isInteger(value.revision) ||
		value.revision < 0
	)
		return false;
	if (!("requiresAcceptance" in value) || typeof value.requiresAcceptance !== "boolean") return false;
	if ("verificationPolicy" in value && value.verificationPolicy !== "user_disabled") return false;
	if (!("acceptance" in value) || typeof value.acceptance !== "object" || value.acceptance === null) return false;
	const acceptance = value.acceptance;
	if (
		!("status" in acceptance) ||
		typeof acceptance.status !== "string" ||
		!["not_required", "pending", "needs_verification", "needs_review", "accepted", "failed", "cancelled"].includes(
			acceptance.status,
		) ||
		!("reason" in acceptance) ||
		typeof acceptance.reason !== "string" ||
		!("criteria" in acceptance) ||
		!Array.isArray(acceptance.criteria) ||
		acceptance.criteria.length > 20 ||
		!acceptance.criteria.every(
			(criterion: unknown) =>
				typeof criterion === "object" &&
				criterion !== null &&
				"requirement" in criterion &&
				typeof criterion.requirement === "string" &&
				"evidence" in criterion &&
				typeof criterion.evidence === "string" &&
				"checkIds" in criterion &&
				Array.isArray(criterion.checkIds) &&
				criterion.checkIds.length > 0 &&
				criterion.checkIds.length <= 20 &&
				criterion.checkIds.every((id: unknown) => typeof id === "string"),
		)
	)
		return false;
	if (!("plan" in value) || !Array.isArray(value.plan) || value.plan.length > 20) return false;
	if (!("checks" in value) || !Array.isArray(value.checks) || value.checks.length > 20) return false;
	if (!("changedFiles" in value) || !Array.isArray(value.changedFiles) || value.changedFiles.length > 100)
		return false;
	return (
		value.plan.every(
			(step: unknown) =>
				typeof step === "object" &&
				step !== null &&
				"step" in step &&
				typeof step.step === "string" &&
				"status" in step &&
				(step.status === "pending" || step.status === "in_progress" || step.status === "completed"),
		) &&
		value.checks.every(
			(check: unknown) =>
				typeof check === "object" &&
				check !== null &&
				"id" in check &&
				typeof check.id === "string" &&
				"command" in check &&
				typeof check.command === "string" &&
				"revision" in check &&
				typeof check.revision === "number" &&
				Number.isInteger(check.revision) &&
				check.revision >= 0 &&
				"output" in check &&
				typeof check.output === "string" &&
				"exitCode" in check &&
				(check.exitCode === null || (typeof check.exitCode === "number" && Number.isInteger(check.exitCode))) &&
				"status" in check &&
				(!("replaces" in check) ||
					(Array.isArray(check.replaces) &&
						check.replaces.length <= 20 &&
						check.replaces.every(
							(link: unknown) =>
								typeof link === "object" &&
								link !== null &&
								"checkId" in link &&
								typeof link.checkId === "string" &&
								link.checkId.length > 0 &&
								"reason" in link &&
								typeof link.reason === "string" &&
								link.reason.trim().length >= 4 &&
								link.reason.length <= 1000,
						))) &&
				(check.status === "running" ||
					check.status === "failed" ||
					check.status === "cancelled" ||
					check.status === "stale" ||
					(check.status === "passed" && check.exitCode === 0)),
		) &&
		value.changedFiles.every((path: unknown) => typeof path === "string")
	);
}
