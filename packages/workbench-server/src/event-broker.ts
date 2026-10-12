import { randomUUID } from "node:crypto";
import {
	type CoordinatedRunHandle,
	type RecordActivityInput,
	RunCoordinator,
	type SendWorkbenchMessageInput,
	type SessionService,
	WorkbenchError,
} from "@earendil-works/workbench-core";
import type { ChatSelection } from "@earendil-works/workbench-core/contracts";
import type { AgentEvent, RuntimeContextOptions, RuntimeTurnContext } from "@earendil-works/workbench-runtime";
import type { StructuredLogger } from "./logger.ts";

export interface StreamResetEvent {
	type: "stream.reset";
	data: { reason: "buffer_exhausted" };
}

export interface SequencedAgentEvent {
	sequence: number;
	event: AgentEvent | StreamResetEvent;
}

interface RunStreamState {
	runId: string;
	sessionId: string;
	events: SequencedAgentEvent[];
	nextSequence: number;
	completed: boolean;
	started: boolean;
	waiters: Set<() => void>;
	input: StartRunInput;
	onEvent?(event: AgentEvent): void | Promise<void>;
	settlement?: Promise<void>;
	job?: CoordinatedRunHandle;
}

export interface StartRunInput {
	text: string;
	images?: SendWorkbenchMessageInput["images"];
	attachments?: SendWorkbenchMessageInput["attachments"];
	attachmentText?: string;
	inputMessageId?: string;
	taskRunId?: string;
	context?: RuntimeContextOptions;
	turnContext?: RuntimeTurnContext;
	selection?: ChatSelection;
	queueIfBusy?: boolean;
	onStart?(runId: string): void | Promise<void>;
	onEvent?(event: AgentEvent): void | Promise<void>;
}

function failedEvent(sessionId: string, runId: string, error: unknown): AgentEvent {
	return {
		id: randomUUID(),
		type: "run.failed",
		occurredAt: new Date().toISOString(),
		sessionId,
		runId,
		data: { message: error instanceof Error ? error.message : String(error) },
	};
}

function domainLogEvent(toolName: string): string | undefined {
	switch (toolName) {
		case "task_create":
			return "task.create";
		case "memory_propose":
			return "memory.candidate";
		case "artifact_register":
			return "artifact.register";
		default:
			return undefined;
	}
}

export class AgentEventBroker {
	private readonly sessions: Pick<SessionService, "abort" | "send">;
	private readonly logger: StructuredLogger;
	private readonly capacity: number;
	private readonly recordActivity: ((input: RecordActivityInput) => Promise<void>) | undefined;
	private readonly recordDiagnostic: ((event: AgentEvent) => void) | undefined;
	private readonly streams = new Map<string, RunStreamState>();
	private readonly coordinator: RunCoordinator;
	private readonly onSettled?: (event: AgentEvent) => Promise<void>;

	constructor(
		sessions: Pick<SessionService, "abort" | "send">,
		logger: StructuredLogger,
		capacity = 500,
		recordActivity?: (input: RecordActivityInput) => Promise<void>,
		recordDiagnostic?: (event: AgentEvent) => void,
		coordinator: RunCoordinator = new RunCoordinator(),
		onSettled?: (event: AgentEvent) => Promise<void>,
	) {
		this.sessions = sessions;
		this.logger = logger;
		this.capacity = Math.max(20, capacity);
		this.recordActivity = recordActivity;
		this.recordDiagnostic = recordDiagnostic;
		this.coordinator = coordinator;
		this.onSettled = onSettled;
	}

	start(sessionId: string, input: StartRunInput): { runId: string; queued: boolean } {
		const runId = randomUUID();
		const state: RunStreamState = {
			runId,
			sessionId,
			events: [],
			nextSequence: 1,
			completed: false,
			started: false,
			waiters: new Set(),
			input,
			onEvent: input.onEvent,
		};
		this.streams.set(runId, state);
		let job: CoordinatedRunHandle;
		try {
			job = this.coordinator.submit(
				runId,
				async (signal) => {
					state.started = true;
					await this.pump(state, {
						text: state.input.text,
						images: state.input.images,
						attachments: state.input.attachments,
						attachmentText: state.input.attachmentText,
						signal,
						inputMessageId: state.input.inputMessageId ?? randomUUID(),
						runId: state.runId,
						taskRunId: state.input.taskRunId,
						context: state.input.context,
						turnContext: state.input.turnContext,
						selection: state.input.selection,
					});
				},
				{ queueIfBusy: input.queueIfBusy === true, resourceKey: `session:${sessionId}` },
			);
		} catch (error) {
			this.streams.delete(runId);
			throw error;
		}
		state.job = job;
		return { runId, queued: job.queued };
	}

	async abort(sessionId: string): Promise<void> {
		const queued = [...this.streams.values()].find(
			(state) => state.sessionId === sessionId && !state.started && !state.completed,
		);
		if (queued?.job?.cancel()) {
			await this.publish(queued, {
				id: randomUUID(),
				type: "run.aborted",
				occurredAt: new Date().toISOString(),
				sessionId,
				runId: queued.runId,
				data: { reason: "Queued run cancelled" },
			});
			queued.completed = true;
			this.wake(queued);
			return;
		}
		const active = [...this.streams.values()].find((state) => state.sessionId === sessionId && !state.completed);
		if (active?.job) {
			active.job.abort();
			await active.job.completion;
		} else await this.sessions.abort(sessionId);
	}

	get(runId: string): { runId: string; sessionId: string; completed: boolean; latestSequence: number } {
		const state = this.requireState(runId);
		return {
			runId: state.runId,
			sessionId: state.sessionId,
			completed: state.completed,
			latestSequence: state.nextSequence - 1,
		};
	}

	getActiveRunId(sessionId: string): string | undefined {
		return [...this.streams.values()].find((state) => state.sessionId === sessionId && !state.completed)?.runId;
	}

	forgetSession(sessionId: string): void {
		if (this.getActiveRunId(sessionId)) throw new WorkbenchError("conflict", "请先停止会话，再删除");
		for (const [id, stream] of this.streams) {
			if (stream.sessionId === sessionId) {
				stream.events = [];
				this.wake(stream);
				this.streams.delete(id);
			}
		}
	}

	async *subscribe(runId: string, after = 0): AsyncIterable<SequencedAgentEvent> {
		const state = this.requireState(runId);
		let cursor = Math.max(0, Math.trunc(after));
		const earliest = state.events.at(0)?.sequence;
		if (earliest !== undefined && cursor < earliest - 1) {
			yield { sequence: earliest - 1, event: { type: "stream.reset", data: { reason: "buffer_exhausted" } } };
			cursor = earliest - 1;
		}
		while (true) {
			for (const entry of state.events) {
				if (entry.sequence <= cursor) continue;
				yield entry;
				cursor = entry.sequence;
			}
			if (state.completed) {
				await state.job?.completion;
				return;
			}
			await new Promise<void>((resolve) => state.waiters.add(resolve));
		}
	}

	private async pump(state: RunStreamState, input: SendWorkbenchMessageInput): Promise<void> {
		let terminal: AgentEvent | undefined;
		try {
			await state.input.onStart?.(state.runId);
			await this.logger.log("message.send", {
				sessionId: state.sessionId,
				runId: state.runId,
				inputMessageId: input.inputMessageId,
			});
			for await (const event of this.sessions.send(state.sessionId, input)) {
				if (event.type === "run.completed" || event.type === "run.aborted" || event.type === "run.failed")
					terminal = event;
				else await this.publish(state, event);
				await this.logger.log("agent.event", {
					sessionId: state.sessionId,
					runId: state.runId,
					type: event.type,
				});
				if (event.type === "tool.started") {
					await this.logger.log("tool.start", {
						runId: state.runId,
						toolCallId: event.data.toolCallId,
						toolName: event.data.toolName,
					});
				} else if (event.type === "tool.completed") {
					await this.logger.log(event.data.isError ? "tool.error" : "tool.end", {
						runId: state.runId,
						toolCallId: event.data.toolCallId,
						toolName: event.data.toolName,
					});
					const domainEvent = domainLogEvent(event.data.toolName);
					if (domainEvent && !event.data.isError) {
						await this.logger.log(domainEvent, { runId: state.runId, toolCallId: event.data.toolCallId });
					}
				}
			}
			// SessionService has persisted run/session metadata and released its run guard before this point.
			state.completed = true;
			await this.publish(
				state,
				terminal ?? failedEvent(state.sessionId, state.runId, new Error("助手运行未返回结束状态")),
			);
			if (terminal && this.onSettled) {
				try {
					await this.onSettled(terminal);
				} catch (error) {
					await this.logger.log("learning.enqueue.error", {
						runId: state.runId,
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}
		} catch (error) {
			state.completed = true;
			await this.publish(state, failedEvent(state.sessionId, state.runId, error));
			await this.logger.log("error", {
				sessionId: state.sessionId,
				runId: state.runId,
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			await state.settlement;
			state.completed = true;
			this.wake(state);
		}
	}

	private async publish(state: RunStreamState, event: AgentEvent): Promise<void> {
		state.events.push({ sequence: state.nextSequence, event });
		this.recordDiagnostic?.(event);
		state.nextSequence += 1;
		if (state.events.length > this.capacity) state.events.splice(0, state.events.length - this.capacity);
		this.wake(state);
		const callbacks: Promise<void>[] = [];
		if (state.onEvent) callbacks.push(Promise.resolve(state.onEvent(event)));
		const activity = this.activityForEvent(state, event);
		if (activity && this.recordActivity) callbacks.push(this.recordActivity(activity));
		if (callbacks.length > 0) {
			state.settlement = Promise.all(callbacks)
				.then(() => undefined)
				.catch((error: unknown) =>
					this.logger.log("error", {
						runId: state.runId,
						message: `Run event callback failed: ${error instanceof Error ? error.message : String(error)}`,
					}),
				);
			await state.settlement;
		}
	}

	private activityForEvent(state: RunStreamState, event: AgentEvent): RecordActivityInput | undefined {
		if (event.type === "run.started") {
			return { sessionId: state.sessionId, runId: state.runId, type: event.type, summary: "Personal Agent started" };
		}
		if (event.type === "run.completed") {
			return {
				sessionId: state.sessionId,
				runId: state.runId,
				type: event.type,
				summary: "Personal Agent completed a run",
			};
		}
		if (event.type === "run.aborted") {
			return {
				sessionId: state.sessionId,
				runId: state.runId,
				type: event.type,
				summary: "Personal Agent was stopped",
			};
		}
		if (event.type === "run.failed") {
			return {
				sessionId: state.sessionId,
				runId: state.runId,
				type: event.type,
				summary: "Personal Agent run failed",
			};
		}
		if (event.type === "tool.completed") {
			return {
				sessionId: state.sessionId,
				runId: state.runId,
				type: event.data.isError ? "tool.failed" : "tool.completed",
				summary: `${event.data.toolName} ${event.data.isError ? "failed" : "completed"}`,
				metadata: { toolName: event.data.toolName, toolCallId: event.data.toolCallId },
			};
		}
		return undefined;
	}

	private wake(state: RunStreamState): void {
		for (const waiter of state.waiters) waiter();
		state.waiters.clear();
	}

	private requireState(runId: string): RunStreamState {
		const state = this.streams.get(runId);
		if (!state) throw new WorkbenchError("not_found", `Agent run stream not found: ${runId}`);
		return state;
	}
}
