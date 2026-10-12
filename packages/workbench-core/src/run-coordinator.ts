import { WorkbenchError } from "./errors.ts";

export interface CoordinatedRunHandle {
	readonly id: string;
	readonly queued: boolean;
	readonly completion: Promise<void>;
	cancel(): boolean;
	abort(): void;
}

interface QueuedRun {
	id: string;
	resourceKey?: string;
	controller: AbortController;
	execute(signal: AbortSignal): Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
	started: boolean;
	completion: Promise<void>;
}

export class RunCoordinator {
	private readonly active = new Map<string, QueuedRun>();
	private readonly queue: QueuedRun[] = [];
	private accepting = true;

	submit(
		id: string,
		execute: (signal: AbortSignal) => Promise<void>,
		options: { queueIfBusy: boolean; resourceKey?: string },
	): CoordinatedRunHandle {
		if (!this.accepting) throw new WorkbenchError("conflict", "Workbench is shutting down");
		if (this.active.has(id) || this.queue.some((run) => run.id === id))
			throw new WorkbenchError("conflict", "该运行已提交");
		const busy = [...this.active.values(), ...this.queue].some((run) => this.conflicts(run, options.resourceKey));
		if (busy && !options.queueIfBusy) {
			throw new WorkbenchError(
				"conflict",
				options.resourceKey ? "该会话正在运行或更新，请稍后再试" : "请等待正在运行的会话结束，再修改共享配置",
			);
		}
		let resolveCompletion: () => void = () => undefined;
		let rejectCompletion: (error: unknown) => void = () => undefined;
		const completion = new Promise<void>((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});
		const run: QueuedRun = {
			id,
			resourceKey: options.resourceKey,
			controller: new AbortController(),
			execute,
			resolve: resolveCompletion,
			reject: rejectCompletion,
			started: false,
			completion,
		};
		const queued = busy;
		if (queued) this.queue.push(run);
		else this.begin(run);
		return {
			id,
			queued,
			completion,
			cancel: () => this.cancelQueued(run),
			abort: () => run.controller.abort(),
		};
	}

	activeRunId(): string | undefined {
		return this.active.keys().next().value;
	}

	async shutdown(): Promise<void> {
		this.accepting = false;
		for (const run of this.queue.splice(0)) {
			run.controller.abort();
			run.resolve();
		}
		const active = [...this.active.values()];
		for (const run of active) run.controller.abort();
		const results = await Promise.allSettled(active.map((run) => run.completion));
		const failed = results.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	}

	private begin(run: QueuedRun): void {
		run.started = true;
		this.active.set(run.id, run);
		void Promise.resolve()
			.then(() => run.execute(run.controller.signal))
			.finally(() => {
				this.active.delete(run.id);
				this.beginNext();
			})
			.then(run.resolve, run.reject);
	}

	private beginNext(): void {
		if (!this.accepting) return;
		for (const run of [...this.queue]) {
			if ([...this.active.values()].some((active) => this.conflicts(active, run.resourceKey))) continue;
			if (this.queue.slice(0, this.queue.indexOf(run)).some((earlier) => this.conflicts(earlier, run.resourceKey)))
				continue;
			this.queue.splice(this.queue.indexOf(run), 1);
			this.begin(run);
		}
	}

	/** Missing resourceKey reserves all resources for shared configuration and maintenance. */
	private conflicts(run: QueuedRun, key: string | undefined): boolean {
		return run.resourceKey === undefined || key === undefined || run.resourceKey === key;
	}

	private cancelQueued(run: QueuedRun): boolean {
		if (run.started) return false;
		const index = this.queue.indexOf(run);
		if (index < 0) return false;
		this.queue.splice(index, 1);
		run.controller.abort();
		run.resolve();
		this.beginNext();
		return true;
	}
}
