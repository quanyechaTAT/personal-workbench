import type * as childProcess from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createPersistentShell } from "../src/persistent-shell.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return {
		...actual,
		spawn: (...[executable, args, options]: Parameters<typeof actual.spawn>) => {
			const argumentsWithMode = [...args];
			const index = argumentsWithMode.indexOf("-EncodedCommand") + 1;
			if (index > 0) {
				const script = Buffer.from(argumentsWithMode[index], "base64").toString("utf16le");
				argumentsWithMode[index] = Buffer.from(
					`if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage' }\n${script}`,
					"utf16le",
				).toString("base64");
			}
			return actual.spawn(executable, argumentsWithMode, options);
		},
	};
});

test.runIf(process.platform === "win32")(
	"persistent shell preserves state and errors in ConstrainedLanguage",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-constrained-shell-"));
		await mkdir(join(root, "子目录"));
		const shell = createPersistentShell(root, {
			Path: process.env.Path,
			PATHEXT: process.env.PATHEXT,
			PSModulePath: process.env.PSModulePath,
			SystemRoot: process.env.SystemRoot,
			TEMP: process.env.TEMP,
			TMP: process.env.TMP,
		});
		try {
			const initial = await shell.tool.execute(
				"initialize",
				{
					command:
						"$probe = 41; function Get-Probe { '中文😀' }; Set-Location 子目录; $ExecutionContext.SessionState.LanguageMode",
				},
				undefined,
			);
			expect(initial.content).toEqual([{ type: "text", text: expect.stringContaining("ConstrainedLanguage") }]);
			await expect(shell.tool.execute("error", { command: "Write-Error '具体错误'" }, undefined)).rejects.toThrow(
				"具体错误",
			);
			const result = await shell.tool.execute(
				"resume",
				{ command: "($probe + 1); Get-Probe; Split-Path -Leaf (Get-Location)" },
				undefined,
			);
			expect(JSON.stringify(result.content)).toContain("42");
			expect(JSON.stringify(result.content)).toContain("中文😀");
			expect(JSON.stringify(result.content)).toContain("子目录");
			await expect(
				shell.tool.execute("restricted", { command: "[PowerShell]::Create()" }, undefined),
			).rejects.toThrow();
		} finally {
			await shell.close();
			await rm(root, { recursive: true, force: true, maxRetries: 5 });
		}
	},
);
