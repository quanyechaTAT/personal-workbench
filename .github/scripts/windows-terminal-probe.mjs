import { execFile } from "node:child_process";
import { join } from "node:path";
import { spawn } from "node-pty";

const environment = {
	PATH: process.env.PATH,
	PATHEXT: process.env.PATHEXT,
	SystemRoot: process.env.SystemRoot,
	TEMP: process.env.RUNNER_TEMP ?? process.env.TEMP,
	TMP: process.env.RUNNER_TEMP ?? process.env.TMP,
};
const prelude = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n[Console]::InputEncoding = [System.Text.Encoding]::UTF8\n$OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = 0\n";
const cases = [
	{ name: "original", command: "Write-Output fresh" },
	{ name: "text-format", command: "Write-Output fresh", args: ["-OutputFormat", "Text"] },
	{ name: "non-interactive", command: "Write-Output fresh", args: ["-NonInteractive"] },
	{ name: "full-environment", command: "Write-Output fresh", env: process.env },
	{ name: "explicit-utility", command: "Write-Output fresh", prelude: "Import-Module Microsoft.PowerShell.Utility\n" },
	{ name: "string-output", command: "'fresh'" },
	{ name: "write-host", command: "Write-Host fresh" },
	{ name: "native-output", command: "& cmd.exe /c echo fresh" },
	{ name: "powershell-7", command: "Write-Output fresh", executable: "pwsh.exe" },
];
for (const entry of cases) {
	await new Promise((resolve) => {
		const started = performance.now();
		const script = `${entry.prelude ?? ""}${prelude}try { & {\n${entry.command}\n}; exit ([int]$global:LASTEXITCODE) } catch { Write-Error $_ -ErrorAction Continue; exit 1 }`;
		const pty = spawn(entry.executable ?? "powershell.exe", ["-NoLogo", "-NoProfile", ...(entry.args ?? []), "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { cwd: process.cwd(), env: entry.env ?? environment, name: "xterm-256color", cols: 160, rows: 40, useConpty: true, conptyInheritCursor: false });
		let raw = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pty.pid)], { windowsHide: true }, () => {});
		}, 10_000);
		pty.onData((data) => { raw = (raw + data).slice(-3000); });
		pty.onExit(({ exitCode }) => {
			clearTimeout(timer);
			console.log(JSON.stringify({ name: entry.name, ms: Math.round(performance.now() - started), timedOut, exitCode, raw }));
			resolve();
		});
	});
}
process.exit(0);
