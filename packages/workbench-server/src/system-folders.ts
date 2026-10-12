import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { promisify } from "node:util";
import { minimalShellEnvironment } from "./shell-environment.ts";

export interface DesktopLocation {
	path?: string;
	source: "windows-known-folder" | "macos" | "xdg-user-dir" | "unavailable";
	diagnostic?: string;
}

export interface SystemFolderReader {
	readDesktop(): Promise<DesktopLocation>;
}

async function queryWindowsDesktop(): Promise<string> {
	const powershell = process.env.SystemRoot
		? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		: "powershell.exe";
	const { stdout } = await promisify(execFile)(
		powershell,
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory) | ConvertTo-Json -Compress",
		],
		{
			encoding: "utf8",
			windowsHide: true,
			timeout: 5_000,
			maxBuffer: 64_000,
			env: minimalShellEnvironment(process.env),
		},
	);
	return stdout;
}

/** Read OS configuration. Never infer a Windows desktop from USERPROFILE or create a missing folder. */
export class NativeSystemFolderReader implements SystemFolderReader {
	private readonly platform: NodeJS.Platform;
	private readonly homeDirectory: string;
	private readonly windowsQuery: () => Promise<string>;

	constructor(
		options: { platform?: NodeJS.Platform; homeDirectory?: string; windowsQuery?: () => Promise<string> } = {},
	) {
		this.platform = options.platform ?? process.platform;
		this.homeDirectory = options.homeDirectory ?? homedir();
		this.windowsQuery = options.windowsQuery ?? queryWindowsDesktop;
	}

	async readDesktop(): Promise<DesktopLocation> {
		try {
			if (this.platform === "win32") {
				const value: unknown = JSON.parse((await this.windowsQuery()).trim());
				if (
					typeof value !== "string" ||
					!value.trim() ||
					!win32.isAbsolute(value) ||
					/[\u0000-\u001f]/u.test(value)
				) {
					return { source: "unavailable", diagnostic: "Windows 未返回有效的当前用户桌面目录。" };
				}
				return { path: win32.normalize(value), source: "windows-known-folder" };
			}
			if (this.platform === "darwin") {
				const path = join(this.homeDirectory, "Desktop");
				if ((await stat(path)).isDirectory()) return { path, source: "macos" };
			} else if (this.platform === "linux") {
				const { stdout } = await promisify(execFile)("xdg-user-dir", ["DESKTOP"], {
					encoding: "utf8",
					timeout: 5_000,
					maxBuffer: 64_000,
					env: {
						...minimalShellEnvironment(process.env),
						HOME: this.homeDirectory,
						XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
					},
				});
				const path = stdout.trim();
				if (path && isAbsolute(path) && path !== this.homeDirectory && (await stat(path)).isDirectory()) {
					return { path, source: "xdg-user-dir" };
				}
			}
			return { source: "unavailable", diagnostic: "系统未配置可用的用户桌面目录。" };
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error ? String(error.code) : "query_failed";
			return { source: "unavailable", diagnostic: `无法读取系统桌面目录（${code}）；不能根据用户主目录猜测。` };
		}
	}
}
