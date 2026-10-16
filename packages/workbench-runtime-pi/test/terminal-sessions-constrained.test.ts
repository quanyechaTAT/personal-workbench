import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as nodePty from "node-pty";
import { expect, test, vi } from "vitest";
import { TerminalSessions } from "../src/terminal-sessions.ts";

vi.mock("node-pty", async (importOriginal) => {
	const actual = await importOriginal<typeof nodePty>();
	return {
		...actual,
		spawn: (executable: string, args: string[], options: nodePty.IWindowsPtyForkOptions) => {
			const argumentsWithMode = [...args];
			for (const [index, argument] of argumentsWithMode.entries()) {
				argumentsWithMode[index] = argument.replace(
					/-EncodedCommand ([A-Za-z0-9+/=]+)$/u,
					(_match, encoded: string) => {
						const script = Buffer.from(encoded, "base64").toString("utf16le");
						return `-EncodedCommand ${Buffer.from(`$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n${script}`, "utf16le").toString("base64")}`;
					},
				);
			}
			return actual.spawn(executable, argumentsWithMode, options);
		},
	};
});

test.runIf(process.platform === "win32")(
	"PTY executes cmdlets in ConstrainedLanguage without startup errors",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-constrained-pty-"));
		const terminals = new TerminalSessions(root, {
			PATH: process.env.PATH,
			PATHEXT: process.env.PATHEXT,
			PSModulePath: process.env.PSModulePath,
			SystemRoot: process.env.SystemRoot,
			TEMP: process.env.TEMP,
			TMP: process.env.TMP,
		});
		try {
			let result = await terminals.start(
				"$ExecutionContext.SessionState.LanguageMode; Write-Output '中文'; Set-Content inside.txt allowed",
				0,
			);
			let output = result.output;
			await vi.waitFor(
				async () => {
					if (result.status === "running") {
						result = await terminals.read(result.session_id, "", 250);
						output += result.output;
					}
					expect(result.status, output).toBe("exited");
				},
				{ timeout: 15000 },
			);
			expect(result.exit_code, output).toBe(0);
			expect(output).toContain("ConstrainedLanguage");
			expect(output).toContain("中文");
			expect(output).not.toContain("PropertySetterNotSupportedInConstrainedLanguage");
			expect(await readFile(join(root, "inside.txt"), "utf8")).toContain("allowed");
		} finally {
			await terminals.dispose();
			await rm(root, { recursive: true, force: true, maxRetries: 5 });
		}
	},
);
