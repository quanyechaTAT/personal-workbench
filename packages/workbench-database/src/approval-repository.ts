import type { Approval, ApprovalRepository, ApprovalStatus } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface ApprovalRow {
	id: string;
	session_id: string;
	run_id: string;
	tool_call_id: string;
	tool_name: string;
	operation_json: string;
	status: ApprovalStatus;
	requested_at: string;
	expires_at: string;
	resolved_at: string | null;
}

function parseOperation(json: string): Record<string, unknown> {
	const value: unknown = JSON.parse(json);
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function mapApproval(row: ApprovalRow): Approval {
	return {
		id: row.id,
		sessionId: row.session_id,
		runId: row.run_id,
		toolCallId: row.tool_call_id,
		toolName: row.tool_name,
		operation: parseOperation(row.operation_json),
		status: row.status,
		requestedAt: row.requested_at,
		expiresAt: row.expires_at,
		resolvedAt: row.resolved_at ?? undefined,
	};
}

export class SqliteApprovalRepository implements ApprovalRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async create(approval: Approval): Promise<Approval> {
		this.database
			.prepare(
				`INSERT INTO approvals(
          id, session_id, run_id, tool_call_id, tool_name, operation_json, status, requested_at, expires_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				approval.id,
				approval.sessionId,
				approval.runId,
				approval.toolCallId,
				approval.toolName,
				JSON.stringify(approval.operation),
				approval.status,
				approval.requestedAt,
				approval.expiresAt,
				approval.resolvedAt ?? null,
			);
		return approval;
	}

	async get(id: string): Promise<Approval | undefined> {
		const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
		return row ? mapApproval(row) : undefined;
	}

	async listPending(): Promise<Approval[]> {
		return (
			this.database
				.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at")
				.all() as unknown as ApprovalRow[]
		).map(mapApproval);
	}

	async resolve(
		id: string,
		from: ApprovalStatus,
		to: ApprovalStatus,
		resolvedAt: string,
	): Promise<Approval | undefined> {
		const result = this.database
			.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = ?")
			.run(to, resolvedAt, id, from);
		return result.changes === 1 ? this.get(id) : undefined;
	}

	async expirePending(resolvedAt: string): Promise<Approval[]> {
		const pending = await this.listPending();
		this.database
			.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending'")
			.run(resolvedAt);
		return pending.map((approval) => ({ ...approval, status: "expired", resolvedAt }));
	}
}
