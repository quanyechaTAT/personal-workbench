import { describe, expect, test } from "vitest";
import { closeWorkbench } from "../src/shutdown.ts";

describe("Workbench shutdown", () => {
	test("releases application resources when HTTP shutdown stalls", async () => {
		const calls: string[] = [];
		const server = {
			close: () => {
				calls.push("server");
				return new Promise<void>(() => undefined);
			},
		};
		const application = {
			close: async () => {
				calls.push("application");
			},
		};

		await expect(closeWorkbench(server, application, { serverMs: 10, applicationMs: 100 })).rejects.toThrow(
			"Workbench HTTP server did not close within 10 ms",
		);
		expect(calls).toEqual(["server", "application"]);
	});

	test("closes HTTP before application resources during a normal shutdown", async () => {
		const calls: string[] = [];
		await closeWorkbench(
			{ close: async () => void calls.push("server") },
			{ close: async () => void calls.push("application") },
		);
		expect(calls).toEqual(["server", "application"]);
	});
});
