import type { AgentRun, AgentRunRepository } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface AgentRunRow {
	id: string;
	session_id: string;
	task_run_id: string | null;
	status: AgentRun["status"];
	input_message_id: string;
	final_message_id: string | null;
	profile_slug: string;
	profile_version: number | null;
	capabilities_json: string | null;
	model_json: string | null;
	started_at: string;
	settled_at: string | null;
	error_code: string | null;
	error_message: string | null;
}

function mapRun(row: AgentRunRow): AgentRun {
	return {
		id: row.id,
		sessionId: row.session_id,
		taskRunId: row.task_run_id ?? undefined,
		status: row.status,
		inputMessageId: row.input_message_id,
		finalMessageId: row.final_message_id ?? undefined,
		profileSlug: row.profile_slug,
		profileVersion: row.profile_version ?? undefined,
		capabilities: row.capabilities_json ? (JSON.parse(row.capabilities_json) as AgentRun["capabilities"]) : undefined,
		model: row.model_json ? (JSON.parse(row.model_json) as AgentRun["model"]) : undefined,
		startedAt: row.started_at,
		settledAt: row.settled_at ?? undefined,
		errorCode: row.error_code ?? undefined,
		errorMessage: row.error_message ?? undefined,
	};
}

export class SqliteAgentRunRepository implements AgentRunRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async create(run: AgentRun): Promise<AgentRun> {
		this.database
			.prepare(
				`INSERT INTO agent_runs(
          id, session_id, task_run_id, status, input_message_id, final_message_id, profile_slug,
          profile_version, capabilities_json, model_json, started_at, settled_at, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(...this.values(run));
		return run;
	}

	async get(id: string): Promise<AgentRun | undefined> {
		const row = this.database.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as AgentRunRow | undefined;
		return row ? mapRun(row) : undefined;
	}

	async getRunningBySession(sessionId: string): Promise<AgentRun | undefined> {
		const row = this.database
			.prepare(
				"SELECT * FROM agent_runs WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
			)
			.get(sessionId) as AgentRunRow | undefined;
		return row ? mapRun(row) : undefined;
	}

	async update(run: AgentRun): Promise<AgentRun> {
		this.database
			.prepare(
				`UPDATE agent_runs SET
          session_id = ?, task_run_id = ?, status = ?, input_message_id = ?, final_message_id = ?,
          profile_slug = ?, profile_version = ?, capabilities_json = ?, model_json = ?, started_at = ?,
          settled_at = ?, error_code = ?, error_message = ?
        WHERE id = ?`,
			)
			.run(...this.values(run).slice(1), run.id);
		return run;
	}
	async latestSettled(sessionId: string): Promise<AgentRun | undefined> {
		const row = this.database
			.prepare(
				"SELECT * FROM agent_runs WHERE session_id = ? AND status <> 'running' ORDER BY started_at DESC LIMIT 1",
			)
			.get(sessionId) as AgentRunRow | undefined;
		return row ? mapRun(row) : undefined;
	}

	async markRunningInterrupted(settledAt: string): Promise<number> {
		const result = this.database
			.prepare("UPDATE agent_runs SET status = 'interrupted', settled_at = ? WHERE status = 'running'")
			.run(settledAt);
		return Number(result.changes);
	}

	private values(run: AgentRun): Array<string | number | null> {
		return [
			run.id,
			run.sessionId,
			run.taskRunId ?? null,
			run.status,
			run.inputMessageId,
			run.finalMessageId ?? null,
			run.profileSlug,
			run.profileVersion ?? null,
			run.capabilities ? JSON.stringify(run.capabilities) : null,
			run.model ? JSON.stringify(run.model) : null,
			run.startedAt,
			run.settledAt ?? null,
			run.errorCode ?? null,
			run.errorMessage ?? null,
		];
	}
}
