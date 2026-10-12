import { expect, test } from "vitest";
import { RunCoordinator } from "../src/run-coordinator.ts";

function gate() {
	let release: () => void = () => undefined;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
}

test("separate session resources start concurrently and the same session remains single writer", async () => {
	const coordinator = new RunCoordinator();
	const firstGate = gate();
	const secondGate = gate();
	const entered: string[] = [];
	const first = coordinator.submit(
		"first",
		async () => {
			entered.push("first");
			await firstGate.wait;
		},
		{ resourceKey: "session:one", queueIfBusy: false },
	);
	const second = coordinator.submit(
		"second",
		async () => {
			entered.push("second");
			await secondGate.wait;
		},
		{ resourceKey: "session:two", queueIfBusy: false },
	);
	await Promise.resolve();
	expect(entered).toEqual(["first", "second"]);
	expect(second.queued).toBe(false);
	expect(() =>
		coordinator.submit("duplicate", async () => undefined, { resourceKey: "session:one", queueIfBusy: false }),
	).toThrow("该会话正在运行");
	const next = coordinator.submit(
		"next",
		async () => {
			entered.push("next");
		},
		{ resourceKey: "session:one", queueIfBusy: true },
	);
	expect(next.queued).toBe(true);
	firstGate.release();
	await first.completion;
	await next.completion;
	expect(entered).toEqual(["first", "second", "next"]);
	secondGate.release();
	await second.completion;
});

test("shared maintenance waits for all active sessions and prevents later sessions overtaking it", async () => {
	const coordinator = new RunCoordinator();
	const firstGate = gate();
	const secondGate = gate();
	const maintenanceGate = gate();
	const entered: string[] = [];
	const first = coordinator.submit("first", async () => firstGate.wait, {
		resourceKey: "session:one",
		queueIfBusy: false,
	});
	const second = coordinator.submit("second", async () => secondGate.wait, {
		resourceKey: "session:two",
		queueIfBusy: false,
	});
	expect(() => coordinator.submit("unsafe-edit", async () => undefined, { queueIfBusy: false })).toThrow("共享配置");
	const maintenance = coordinator.submit(
		"maintenance",
		async () => {
			entered.push("maintenance");
			await maintenanceGate.wait;
		},
		{ queueIfBusy: true },
	);
	const third = coordinator.submit(
		"third",
		async () => {
			entered.push("third");
		},
		{ resourceKey: "session:three", queueIfBusy: true },
	);
	firstGate.release();
	await first.completion;
	expect(entered).toEqual([]);
	secondGate.release();
	await second.completion;
	expect(entered).toEqual(["maintenance"]);
	maintenanceGate.release();
	await Promise.all([maintenance.completion, third.completion]);
	expect(entered).toEqual(["maintenance", "third"]);
});

test("cancelling queued shared maintenance releases an independent waiting session", async () => {
	const coordinator = new RunCoordinator();
	const held = gate();
	const first = coordinator.submit("first", async () => held.wait, { resourceKey: "session:one", queueIfBusy: false });
	const maintenance = coordinator.submit(
		"maintenance",
		async () => {
			throw new Error("Cancelled work must not execute");
		},
		{ queueIfBusy: true },
	);
	let started = false;
	const second = coordinator.submit(
		"second",
		async () => {
			started = true;
		},
		{ resourceKey: "session:two", queueIfBusy: true },
	);
	expect(maintenance.cancel()).toBe(true);
	await Promise.all([maintenance.completion, second.completion]);
	expect(started).toBe(true);
	expect(maintenance.cancel()).toBe(false);
	held.release();
	await first.completion;
});

test("shutdown aborts every running session, waits for settlement, and cancels queued jobs", async () => {
	const coordinator = new RunCoordinator();
	const aborted: string[] = [];
	const settled: string[] = [];
	const run = (id: string) =>
		coordinator.submit(
			id,
			async (signal) => {
				await new Promise<void>((resolve) =>
					signal.addEventListener(
						"abort",
						() => {
							aborted.push(id);
							resolve();
						},
						{ once: true },
					),
				);
				await Promise.resolve();
				settled.push(id);
			},
			{ resourceKey: `session:${id}`, queueIfBusy: false },
		);
	const first = run("first");
	const second = run("second");
	const queued = coordinator.submit(
		"maintenance",
		async () => {
			throw new Error("Queued work must be cancelled");
		},
		{ queueIfBusy: true },
	);
	await Promise.resolve();
	await coordinator.shutdown();
	await Promise.all([first.completion, second.completion, queued.completion]);
	expect(aborted).toEqual(["first", "second"]);
	expect(settled).toEqual(["first", "second"]);
	expect(coordinator.activeRunId()).toBeUndefined();
	expect(() => run("third")).toThrow("shutting down");
});
