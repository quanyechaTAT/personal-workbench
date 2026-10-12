import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("disconnecting the folder picker closes it and allows a fresh selection", async () => {
	const signals: AbortSignal[] = [];
	const fixture = await createAssistantFixture(undefined, {
		pickDirectory: (signal) => {
			signals.push(signal);
			return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
		},
	});
	const controller = new AbortController();
	try {
		const selecting = fixture.request("/system/pick-project-directory", {
			method: "POST",
			signal: controller.signal,
		});
		const cancelled = expect(selecting).rejects.toThrow();
		await expect.poll(() => signals.length).toBe(1);
		controller.abort();
		await cancelled;
		await expect.poll(() => signals[0].aborted).toBe(true);
		const second = new AbortController();
		const selectingAgain = fixture.request("/system/pick-project-directory", {
			method: "POST",
			signal: second.signal,
		});
		const cancelledAgain = expect(selectingAgain).rejects.toThrow();
		await expect.poll(() => signals.length).toBe(2);
		expect(signals[1].aborted).toBe(false);
		second.abort();
		await cancelledAgain;
		await expect.poll(() => signals[1].aborted).toBe(true);
	} finally {
		controller.abort();
		await fixture.close();
	}
});
