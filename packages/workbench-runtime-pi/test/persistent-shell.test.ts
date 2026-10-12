import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createPersistentShell } from "../src/persistent-shell.ts";

test.runIf(process.platform === "win32")(
	"native exit failures are reported without losing persistent variables",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-persistent-shell-"));
		const shell = createPersistentShell(root, {
			Path: process.env.Path,
			PATHEXT: process.env.PATHEXT,
			SystemRoot: process.env.SystemRoot,
			TEMP: process.env.TEMP,
			TMP: process.env.TMP,
		});
		try {
			await writeFile(join(root, "failure.cjs"), "process.exit(7)");
			await shell.tool.execute("initialize", { command: "$probe = 41; Write-Output initialized" }, undefined);
			await expect(
				shell.tool.execute(
					"fail",
					{ command: `& '${process.execPath.replaceAll("'", "''")}' ./failure.cjs` },
					undefined,
				),
			).rejects.toThrow("7");
			expect(
				JSON.stringify(await shell.tool.execute("resume", { command: "Write-Output ($probe + 1)" }, undefined)),
			).toContain("42");
		} finally {
			await shell.close();
			await rm(root, { recursive: true, force: true, maxRetries: 5 });
		}
	},
);

test.runIf(process.platform === "win32")(
	"cancellation kills the native process tree and recreates a usable shell",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-persistent-cancel-"));
		const shell = createPersistentShell(root, {
			Path: process.env.Path,
			PATHEXT: process.env.PATHEXT,
			SystemRoot: process.env.SystemRoot,
			TEMP: process.env.TEMP,
			TMP: process.env.TMP,
		});
		const controller = new AbortController();
		let nativePid: number | undefined;
		try {
			await writeFile(
				join(root, "waiting.cjs"),
				"require('node:fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000)",
			);
			const executing = shell.tool.execute(
				"wait",
				{ command: `& '${process.execPath.replaceAll("'", "''")}' ./waiting.cjs` },
				controller.signal,
			);
			const stopped = executing.then(
				(result) => ({ result }),
				(error: unknown) => ({ error }),
			);
			await expect
				.poll(async () => readFile(join(root, "child.pid"), "utf8").catch(() => ""), { timeout: 5_000 })
				.toMatch(/^\d+$/u);
			nativePid = Number(await readFile(join(root, "child.pid"), "utf8"));
			controller.abort();
			expect(await stopped).toMatchObject({
				error: expect.objectContaining({ message: expect.stringContaining("已中断") }),
			});
			await expect
				.poll(() => {
					try {
						process.kill(nativePid!, 0);
						return true;
					} catch {
						return false;
					}
				})
				.toBe(false);
			expect(
				JSON.stringify(await shell.tool.execute("restart", { command: "Write-Output restarted" }, undefined)),
			).toContain("restarted");
		} finally {
			controller.abort();
			await shell.close();
			if (nativePid) {
				try {
					process.kill(nativePid);
				} catch {
					/* Already stopped. */
				}
			}
			await rm(root, { recursive: true, force: true, maxRetries: 5 });
		}
	},
	15_000,
);
