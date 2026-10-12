import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { WorkbenchInstanceLock } from "../src/instance-lock.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe("WorkbenchInstanceLock", () => {
	test("simultaneous stale-lock recovery admits only one owner", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-lock-"));
		roots.push(root);
		const path = join(root, "workbench.lock");
		await writeFile(path, JSON.stringify({ pid: 2_147_483_647, id: "stale", startedAt: "2026-01-01T00:00:00.000Z" }));
		const results = await Promise.allSettled(Array.from({ length: 3 }, () => WorkbenchInstanceLock.acquire(path)));
		try {
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
		} finally {
			for (const result of results) if (result.status === "fulfilled") await result.value.release();
		}
	});

	test("retains legacy live owners and malformed locks without deleting their files", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-lock-"));
		roots.push(root);
		const path = join(root, "workbench.lock");
		for (const value of [
			JSON.stringify({ pid: process.pid, id: "legacy-live", startedAt: new Date().toISOString() }),
			"{incomplete",
			JSON.stringify({ pid: -1, id: "bad", startedAt: "not-a-date" }),
		]) {
			await writeFile(path, value);
			await expect(WorkbenchInstanceLock.acquire(path)).rejects.toMatchObject({ code: "conflict" });
			expect(await readFile(path, "utf8")).toBe(value);
		}
	});

	test("a different process remains exclusive and its OS guard releases after a crash", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-lock 中文 "));
		roots.push(root);
		const path = join(root, "workbench.lock");
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/instance-lock-child.mjs", import.meta.url)), path],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
		const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
		let output = "";
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Lock child timed out")), 10000);
				child.once("error", reject);
				child.once("close", () => {
					clearTimeout(timer);
					reject(new Error("Lock child closed before acquiring its lock"));
				});
				child.stdout.on("data", (chunk: Buffer) => {
					output += chunk.toString();
					if (output.includes("locked\n")) {
						clearTimeout(timer);
						resolve();
					}
				});
			});
			await expect(WorkbenchInstanceLock.acquire(path)).rejects.toMatchObject({ code: "conflict" });
			child.kill("SIGKILL");
			await closed;
			const recovered = await WorkbenchInstanceLock.acquire(path);
			await recovered.release();
			await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
		}
	}, 20000);

	test("recovers a legacy lock whose PID was reused by a newer process", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-lock 中文 "));
		roots.push(root);
		const path = join(root, "workbench.lock");
		// This live process represents a different process that inherited an old owner's PID.
		await writeFile(
			path,
			JSON.stringify({ pid: process.pid, id: "previous-owner", startedAt: "2000-01-01T00:00:00.000Z" }),
		);
		const lock = await WorkbenchInstanceLock.acquire(path);
		await lock.release();
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("replaces a stale lock left by a terminated process", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-lock-"));
		roots.push(root);
		const path = join(root, "workbench.lock");
		await writeFile(
			path,
			`${JSON.stringify({ pid: 2_147_483_647, id: "stale", startedAt: "2026-01-01T00:00:00.000Z" })}\n`,
			"utf8",
		);

		const lock = await WorkbenchInstanceLock.acquire(path);
		await lock.release();

		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("does not replace a lock owned by a live process", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-lock-"));
		roots.push(root);
		const path = join(root, "workbench.lock");
		const lock = await WorkbenchInstanceLock.acquire(path);

		await expect(WorkbenchInstanceLock.acquire(path)).rejects.toMatchObject({ code: "conflict" });
		await lock.release();
	});
});
