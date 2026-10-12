import { isPermissionMode, type PermissionMode } from "./contracts/permissions.ts";
import { WorkbenchError } from "./errors.ts";
import type { Approval, ApprovalStatus } from "./models.ts";
import type { ApprovalRepository } from "./repositories.ts";
import type { SettingsService } from "./settings-service.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";

export interface RequestApprovalInput {
	sessionId: string;
	runId: string;
	toolCallId: string;
	toolName: string;
	operation: Record<string, unknown>;
	policy?: { kind: "shell" | "external-path" | "mcp" | "browser" | "computer"; explicitlyAllowed?: boolean };
	timeoutMs?: number;
}

export interface PendingApproval {
	approval: Approval;
	decision: Promise<Extract<ApprovalStatus, "approved" | "denied" | "cancelled" | "expired">>;
}

interface Waiter {
	input: RequestApprovalInput;
	resolve(decision: Extract<ApprovalStatus, "approved" | "denied" | "cancelled" | "expired">): void;
	timer: ReturnType<typeof setTimeout>;
}

export class PermissionService {
	private readonly repository: ApprovalRepository;
	private readonly system: SystemServices;
	private readonly settings?: SettingsService;
	private readonly waiters = new Map<string, Waiter>();

	constructor(
		repository: ApprovalRepository,
		system: SystemServices = defaultSystemServices,
		settings?: SettingsService,
	) {
		this.repository = repository;
		this.system = system;
		this.settings = settings;
	}

	async getMode(sessionId: string): Promise<PermissionMode> {
		const stored = await this.settings?.get(`permissions.session.${sessionId}`);
		return isPermissionMode(stored?.value) ? stored.value : "ask";
	}

	async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
		if (!isPermissionMode(mode)) throw new WorkbenchError("invalid_input", "无效的权限模式");
		if (!this.settings) throw new WorkbenchError("storage_failure", "权限设置存储不可用");
		await this.settings.set(`permissions.session.${sessionId}`, mode);
		for (const [id, waiter] of this.waiters) {
			const policy = waiter.input.policy;
			if (
				waiter.input.sessionId === sessionId &&
				policy &&
				!(await this.requiresApproval(sessionId, policy.kind, policy.explicitlyAllowed))
			)
				await this.resolve(id, "approved").catch((error: unknown) => {
					if (!(error instanceof WorkbenchError) || error.code !== "permission_resolved") throw error;
				});
		}
	}

	async requiresApproval(
		sessionId: string,
		kind: "shell" | "external-path" | "mcp" | "browser" | "computer",
		explicitlyAllowed = false,
	): Promise<boolean> {
		const mode = await this.getMode(sessionId);
		if (mode === "full-access") return false;
		if (kind === "mcp" && mode === "auto" && explicitlyAllowed) return false;
		return true;
	}

	async initialize(): Promise<void> {
		await this.repository.expirePending(toTimestamp(this.system.now()));
	}

	async request(input: RequestApprovalInput): Promise<PendingApproval> {
		const timeoutMs = Math.max(1_000, Math.min(10 * 60_000, input.timeoutMs ?? 60_000));
		const requested = this.system.now();
		const approval = await this.repository.create({
			id: this.system.id(),
			sessionId: input.sessionId,
			runId: input.runId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			operation: input.operation,
			status: "pending",
			requestedAt: toTimestamp(requested),
			expiresAt: toTimestamp(new Date(requested.getTime() + timeoutMs)),
		});
		const decision = new Promise<"approved" | "denied" | "cancelled" | "expired">((resolve) => {
			const timer = setTimeout(() => {
				void this.resolve(approval.id, "expired");
			}, timeoutMs);
			this.waiters.set(approval.id, { input, resolve, timer });
		});
		// Recheck after registering: a mode change may race with approval creation.
		if (
			input.policy &&
			!(await this.requiresApproval(input.sessionId, input.policy.kind, input.policy.explicitlyAllowed))
		)
			await this.resolve(approval.id, "approved").catch((error: unknown) => {
				if (!(error instanceof WorkbenchError) || error.code !== "permission_resolved") throw error;
			});
		return { approval, decision };
	}

	async resolve(
		id: string,
		decision: Extract<ApprovalStatus, "approved" | "denied" | "cancelled" | "expired">,
	): Promise<Approval> {
		const approval = await this.repository.resolve(id, "pending", decision, toTimestamp(this.system.now()));
		if (!approval) {
			const existing = await this.repository.get(id);
			if (!existing) throw new WorkbenchError("not_found", `Approval not found: ${id}`);
			throw new WorkbenchError("permission_resolved", `Approval is already ${existing.status}`);
		}
		const waiter = this.waiters.get(id);
		if (waiter) {
			clearTimeout(waiter.timer);
			this.waiters.delete(id);
			waiter.resolve(decision);
		}
		return approval;
	}

	async cancelRun(runId: string): Promise<void> {
		for (const approval of await this.repository.listPending()) {
			if (approval.runId === runId) await this.resolve(approval.id, "cancelled");
		}
	}

	async dispose(): Promise<void> {
		for (const id of [...this.waiters.keys()]) await this.resolve(id, "cancelled");
	}
}
