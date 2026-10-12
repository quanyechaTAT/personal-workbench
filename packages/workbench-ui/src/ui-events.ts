import type { AgentStreamEvent } from "./api.ts";

export interface UiDiagnosticEvent {
	id: string;
	stage: "ui";
	type: string;
	timestamp: string;
	sessionId?: string;
	runId?: string;
	payload: AgentStreamEvent;
}

const entries: UiDiagnosticEvent[] = [];

export function recordUiEvent(event: AgentStreamEvent): void {
	entries.push({
		id: "id" in event ? event.id : `${Date.now()}-${entries.length}`,
		stage: "ui",
		type: event.type,
		timestamp: "occurredAt" in event ? event.occurredAt : new Date().toISOString(),
		sessionId: "sessionId" in event ? event.sessionId : undefined,
		runId: "runId" in event ? event.runId : undefined,
		payload: event,
	});
	if (entries.length > 200) entries.splice(0, entries.length - 200);
}

export function listUiEvents(): UiDiagnosticEvent[] {
	return [...entries].reverse();
}
