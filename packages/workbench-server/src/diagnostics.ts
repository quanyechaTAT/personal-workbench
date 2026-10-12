import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@earendil-works/workbench-runtime";
import { sanitizeDiagnostic } from "./logger.ts";

export type DiagnosticStage = "raw.pi" | "normalized";

export interface DiagnosticEvent {
	id: string;
	stage: DiagnosticStage;
	type: string;
	timestamp: string;
	sessionId?: string;
	runId?: string;
	payload: unknown;
}

export class DiagnosticEventStore {
	private readonly capacity: number;
	private readonly entries: DiagnosticEvent[] = [];

	constructor(capacity = 300) {
		this.capacity = Math.max(20, capacity);
	}

	recordRaw(sessionId: string, event: { type: string }): void {
		this.push({
			id: randomUUID(),
			stage: "raw.pi",
			type: event.type,
			timestamp: new Date().toISOString(),
			sessionId,
			payload: sanitizeDiagnostic(event),
		});
	}

	recordNormalized(event: AgentEvent): void {
		this.push({
			id: event.id,
			stage: "normalized",
			type: event.type,
			timestamp: event.occurredAt,
			sessionId: event.sessionId,
			runId: event.runId,
			payload: sanitizeDiagnostic(event),
		});
	}

	list(stage?: DiagnosticStage, limit = 100): DiagnosticEvent[] {
		const entries = stage ? this.entries.filter((entry) => entry.stage === stage) : this.entries;
		return entries.slice(-Math.min(300, Math.max(1, Math.trunc(limit)))).reverse();
	}

	forgetSession(runtimeSessionId: string): void {
		for (let index = this.entries.length - 1; index >= 0; index--) {
			if (this.entries[index].sessionId === runtimeSessionId) this.entries.splice(index, 1);
		}
	}

	private push(event: DiagnosticEvent): void {
		this.entries.push(event);
		if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
	}
}
