import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { createPersistentShell } from "../src/persistent-shell.ts";
import { createSandboxOperations } from "../src/sandbox-operations.ts";
import { TerminalSessions } from "../src/terminal-sessions.ts";

const environment = {
	PATH: process.env.PATH,
	PATHEXT: process.env.PATHEXT,
	SystemRoot: process.env.SystemRoot,
	TEMP: process.env.TEMP,
	TMP: process.env.TMP,
};

test("workspace sandbox permits project writes but blocks a child process writing outside", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-sandbox-"));
	const workspace = join(root, "project");
	await mkdir(workspace);
	const terminals = new TerminalSessions(workspace, environment, {
		mode: "workspace-write",
		networkAccess: false,
		writableRoots: [],
	});
	try {
		const inside = await terminals.start("Set-Content -LiteralPath inside.txt -Value allowed", 10_000);
		expect(inside.status, inside.output).toBe("exited");
		expect(inside.exit_code, inside.output).toBe(0);
		expect(await readFile(join(workspace, "inside.txt"), "utf8")).toContain("allowed");
		const outside = join(root, "outside.txt").replaceAll("'", "''");
		const result = await terminals.start(
			`& powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '${outside}' -Value denied -ErrorAction Stop"`,
			10_000,
		);
		await expect(readFile(join(root, "outside.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(result.exit_code, result.output).not.toBe(0);
	} finally {
		await terminals.dispose();
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	}
}, 30_000);

test("sandboxed PTY accepts later input, returns early and closes its child process", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-sandbox-"));
	await writeFile(
		join(root, "input.cjs"),
		'process.stdin.setEncoding("utf8"); process.stdin.on("data", data => { console.log("INPUT:" + data.trim()); }); console.log("READY"); setInterval(() => {}, 1000);',
	);
	const terminals = new TerminalSessions(root, environment);
	try {
		const start = performance.now();
		const session = await terminals.start(`& '${process.execPath.replaceAll("'", "''")}' input.cjs`, 0);
		expect(performance.now() - start).toBeLessThan(2000);
		let output = "";
		await vi.waitFor(
			async () => {
				output += (await terminals.read(session.session_id, "", 250)).output;
				expect(output).toContain("READY");
			},
			{ timeout: 8000 },
		);
		output = (await terminals.read(session.session_id, "sandbox-input\r", 250)).output;
		await vi.waitFor(
			async () => {
				output += (await terminals.read(session.session_id, "", 250)).output;
				expect(output).toContain("INPUT:sandbox-input");
			},
			{ timeout: 8000 },
		);
		await terminals.read(session.session_id, "\u0003", 1000);
		await vi.waitFor(async () => expect((await terminals.read(session.session_id, "", 250)).status).toBe("exited"), {
			timeout: 8000,
		});
	} finally {
		await terminals.dispose();
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	}
}, 30_000);

test("ordinary shell operations and persistent commands use the same file sandbox", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-sandbox-"));
	const workspace = join(root, "project");
	await mkdir(workspace);
	const terminals = new TerminalSessions(workspace, environment);
	const persistent = createPersistentShell(workspace, environment, terminals);
	try {
		const outside = join(root, "outside.txt").replaceAll("'", "''");
		let output = "";
		const result = await createSandboxOperations(terminals, workspace, "powershell").exec(
			`Set-Content -LiteralPath '${outside}' -Value denied`,
			workspace,
			{
				onData: (chunk) => {
					output += chunk.toString();
				},
			},
		);
		expect(result.exitCode, output).not.toBe(0);
		await expect(
			persistent.tool.execute(
				"call",
				{
					command: `Set-Content -LiteralPath '${outside}' -Value denied`,
					timeout: 10,
				},
				undefined,
			),
		).rejects.toThrow();
		await expect(readFile(join(root, "outside.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		const saved = await persistent.tool.execute(
			"call",
			{ command: "$value = 41; Write-Output saved", timeout: 10 },
			undefined,
		);
		expect(saved.content).toEqual([{ type: "text", text: expect.stringContaining("saved") }]);
		const next = await persistent.tool.execute(
			"call",
			{ command: "Write-Output ($value + 1)", timeout: 10 },
			undefined,
		);
		expect(next.content).toEqual([{ type: "text", text: expect.stringContaining("42") }]);
	} finally {
		await persistent.close();
		await terminals.dispose();
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	}
}, 30_000);

test("read-only sandbox blocks writes even inside the project", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-sandbox-"));
	const terminals = new TerminalSessions(root, environment, {
		mode: "read-only",
		networkAccess: false,
		writableRoots: [],
	});
	try {
		const result = await terminals.start("Set-Content -LiteralPath forbidden.txt -Value denied", 10_000);
		await expect(readFile(join(root, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(result.exit_code, result.output).not.toBe(0);
	} finally {
		await terminals.dispose();
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	}
}, 30_000);

test("sandbox commands cannot read protected state or modify agent and Git control files", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-sandbox-"));
	const workspace = join(root, "project");
	const state = join(root, "state");
	await mkdir(workspace);
	await mkdir(state);
	await writeFile(join(state, "credentials.txt"), "fixture-secret");
	for (const folder of [".git", ".codex", ".agents"]) {
		await mkdir(join(workspace, folder));
		await writeFile(join(workspace, folder, "config.txt"), "unchanged");
	}
	const terminals = new TerminalSessions(workspace, environment, {
		mode: "workspace-write",
		networkAccess: false,
		writableRoots: [],
		protectedPaths: [state],
	});
	try {
		const read = await terminals.start(
			`Get-Content -LiteralPath '${join(state, "credentials.txt").replaceAll("'", "''")}'`,
			10_000,
		);
		expect(read.exit_code, read.output).not.toBe(0);
		expect(read.output).not.toContain("fixture-secret");
		for (const folder of [".git", ".codex", ".agents"]) {
			const result = await terminals.start(
				`Set-Content -LiteralPath '${folder}/config.txt' -Value modified`,
				10_000,
			);
			expect(result.exit_code, result.output).not.toBe(0);
			expect(await readFile(join(workspace, folder, "config.txt"), "utf8")).toBe("unchanged");
		}
	} finally {
		await terminals.dispose();
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	}
}, 30_000);

test("network-disabled sandbox blocks an otherwise reachable public documentation page", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-sandbox-"));
	const baseline = new TerminalSessions(root, environment, {
		mode: "danger-full-access",
		networkAccess: true,
		writableRoots: [],
	});
	const terminals = new TerminalSessions(root, environment, {
		mode: "workspace-write",
		networkAccess: false,
		writableRoots: [],
	});
	try {
		const command =
			"$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri https://learn.chatgpt.com/docs/sandboxing | Select-Object -ExpandProperty StatusCode";
		for (const [runner, allowed] of [
			[baseline, true],
			[terminals, false],
		] as const) {
			let result = await runner.start(command, 0);
			let output = result.output;
			await vi.waitFor(
				async () => {
					if (result.status === "running") {
						result = await runner.read(result.session_id, "", 250);
						output += result.output;
					}
					expect(result.status, output).toBe("exited");
				},
				{ timeout: 15_000 },
			);
			if (allowed) {
				expect(result.exit_code, output).toBe(0);
				expect(output).toContain("200");
			} else expect(result.exit_code, output).not.toBe(0);
		}
	} finally {
		await baseline.dispose();
		await terminals.dispose();
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	}
}, 45_000);
