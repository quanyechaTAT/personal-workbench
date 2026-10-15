import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { TerminalSessions } from "../src/terminal-sessions.ts";

async function createHarness(script: string) {
	const root = await mkdtemp(join(tmpdir(), "workbench-pty-"));
	const path = join(root, "program.cjs");
	await writeFile(path, script);
	const terminals = new TerminalSessions(
		root,
		{
			PATH: process.env.PATH,
			PATHEXT: process.env.PATHEXT,
			SystemRoot: process.env.SystemRoot,
			TEMP: process.env.TEMP,
			TMP: process.env.TMP,
		},
		{ mode: "danger-full-access", networkAccess: true, writableRoots: [] },
	);
	return {
		root,
		terminals,
		command: `& '${process.execPath.replaceAll("'", "''")}' '${path.replaceAll("'", "''")}'`,
		close: async () => {
			await terminals.dispose();
			await rm(root, { recursive: true, force: true, maxRetries: 5 });
		},
	};
}

test("real PTY returns early, supports Ctrl+C and drains output without replay", async () => {
	const harness = await createHarness(
		'console.log("READY"); process.on("SIGINT", () => { console.log("INTERRUPTED"); process.exit(0); }); setInterval(() => {}, 1000);',
	);
	try {
		const started = performance.now();
		const result = await harness.terminals.start(harness.command, 0);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(result.status).toBe("running");
		let output = result.output;
		await vi.waitFor(
			async () => {
				output += (await harness.terminals.read(result.session_id, "", 250)).output;
				expect(output).toContain("READY");
			},
			{ timeout: 6000 },
		);
		expect((await harness.terminals.read(result.session_id, "", 0)).output).toBe("");
		let stopped = await harness.terminals.read(result.session_id, "\u0003", 2000);
		output += stopped.output;
		await vi.waitFor(
			async () => {
				if (stopped.status === "running") {
					stopped = await harness.terminals.read(result.session_id, "", 250);
					output += stopped.output;
				}
				expect(stopped.status).toBe("exited");
			},
			{ timeout: 6000 },
		);
		expect(output).toContain("INTERRUPTED");
		// PowerShell reports its own interruption status, even when the child handles SIGINT and exits cleanly.
		expect(stopped.exit_code).not.toBeNull();
	} finally {
		await harness.close();
	}
}, 15_000);

test("sessions reject other conversations, bound output and cancel waiting reads", async () => {
	const harness = await createHarness('console.log("X".repeat(400)); setInterval(() => {}, 1000);');
	const other = new TerminalSessions(harness.root, {});
	try {
		const result = await harness.terminals.start(harness.command, 1000, 10);
		await expect(other.read(result.session_id, "", 0)).rejects.toThrow("不属于当前对话");
		let output = result.output;
		await vi.waitFor(
			async () => {
				output += (await harness.terminals.read(result.session_id, "", 250, 10)).output;
				expect(output).toContain("X");
			},
			{ timeout: 6000 },
		);
		const remaining = await harness.terminals.read(result.session_id, "", 0, 10);
		expect(remaining.output.length).toBeLessThanOrEqual(10);
		expect(remaining.more_output).toBe(true);
		const controller = new AbortController();
		const pending = harness.terminals.read(result.session_id, "", 10_000, 10, controller.signal);
		const rejected = expect(pending).rejects.toThrow();
		await expect(harness.terminals.read(result.session_id, "", 0)).rejects.toThrow("不能同时");
		controller.abort();
		await rejected;
		expect((await harness.terminals.close(result.session_id)).status).toBe("closed");
	} finally {
		await other.dispose();
		await harness.close();
	}
}, 15_000);

test("closing all terminals kills a real long-running server and permits a new terminal", async () => {
	const harness = await createHarness(
		'const http = require("node:http"); const server = http.createServer((q, r) => r.end("active")); server.listen(0, "127.0.0.1", () => require("node:fs").writeFileSync("port", String(server.address().port)));',
	);
	try {
		await harness.terminals.start(harness.command, 0);
		await vi.waitFor(async () => expect(await readFile(join(harness.root, "port"), "utf8")).toMatch(/^\d+$/u), {
			timeout: 6000,
		});
		const port = await readFile(join(harness.root, "port"), "utf8");
		expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("active");
		await harness.terminals.closeAll();
		await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
		let fresh = await harness.terminals.start("Write-Output fresh", 0);
		let output = fresh.output;
		await vi.waitFor(
			async () => {
				if (fresh.status === "running") {
					fresh = await harness.terminals.read(fresh.session_id, "", 250);
					output += fresh.output;
				}
				expect(fresh.status).toBe("exited");
			},
			{ timeout: 6000 },
		);
		expect(fresh.exit_code).toBe(0);
		expect(output).toContain("fresh");
	} finally {
		await harness.close();
	}
}, 15_000);

test("explicit close returns unread final output once", async () => {
	const harness = await createHarness(
		'console.log("final-output".repeat(100)); require("node:fs").writeFileSync("ready", "yes"); setInterval(() => {}, 1000);',
	);
	try {
		const result = await harness.terminals.start(harness.command, 0);
		await vi.waitFor(async () => expect(await readFile(join(harness.root, "ready"), "utf8")).toBe("yes"), {
			timeout: 6000,
		});
		const closed = await harness.terminals.close(result.session_id);
		expect(closed.output).toContain("final-output");
		expect((await harness.terminals.read(result.session_id, "", 0)).output).toBe("");
	} finally {
		await harness.close();
	}
}, 15_000);
