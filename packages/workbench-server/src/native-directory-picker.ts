import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkbenchError } from "@earendil-works/workbench-core";

const runFile = promisify(execFile);
const OWNER_SCRIPT = [
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
	"Add-Type -AssemblyName System.Windows.Forms",
	"$owner = New-Object System.Windows.Forms.Form",
	"$owner.Text = 'Personal Workbench'",
	"$owner.ShowInTaskbar = $false",
	"$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
	"$owner.Size = New-Object System.Drawing.Size(1, 1)",
	"$owner.Opacity = 0",
	"$owner.TopMost = $true",
];

/** Called only after the user clicks the local, authenticated picker button. */
export async function pickNativeDirectory(signal?: AbortSignal): Promise<string | undefined> {
	return pickNativePath(
		[
			"$picker = New-Object System.Windows.Forms.FolderBrowserDialog",
			"$picker.Description = '选择已有项目目录'",
			"$picker.ShowNewFolderButton = $false",
		],
		"$picker.SelectedPath",
		signal,
	);
}

export async function pickNativeSkillFile(signal?: AbortSignal): Promise<string | undefined> {
	return pickNativePath(
		[
			"$picker = New-Object System.Windows.Forms.OpenFileDialog",
			"$picker.Title = '选择要导入的 SKILL.md'",
			"$picker.Filter = 'Skill 定义 (SKILL.md)|SKILL.md'",
			"$picker.CheckFileExists = $true",
			"$picker.Multiselect = $false",
		],
		"$picker.FileName",
		signal,
	);
}

async function pickNativePath(
	dialogScript: string[],
	selectedProperty: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (process.platform !== "win32") throw new WorkbenchError("invalid_input", "当前系统暂不支持本机文件夹弹窗");
	const script = [
		...OWNER_SCRIPT,
		...dialogScript,
		`try { $owner.Show(); $owner.Activate(); if ($picker.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ('WORKBENCH_PATH:' + ${selectedProperty}) } } finally { $picker.Dispose(); $owner.Dispose() }`,
	].join("; ");
	let stdout: string;
	try {
		({ stdout } = await runFile("powershell.exe", ["-NoProfile", "-Sta", "-Command", script], {
			encoding: "utf8",
			windowsHide: true,
			signal,
			maxBuffer: 16 * 1024,
		}));
	} catch (error) {
		if (signal?.aborted) throw new WorkbenchError("conflict", "目录选择已取消", { cause: error });
		throw new WorkbenchError("storage_failure", "无法打开系统文件夹选择弹窗", { cause: error });
	}
	return stdout
		.split(/\r?\n/u)
		.find((line) => line.startsWith("WORKBENCH_PATH:"))
		?.slice("WORKBENCH_PATH:".length)
		.trim();
}
