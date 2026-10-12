import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RuntimeSandboxPolicy } from "@earendil-works/workbench-runtime";

const require = createRequire(import.meta.url);
const nativeTargets: Record<string, { package: string; target: string }> = {
	"win32-x64": { package: "@openai/codex-win32-x64", target: "x86_64-pc-windows-msvc" },
	"win32-arm64": { package: "@openai/codex-win32-arm64", target: "aarch64-pc-windows-msvc" },
	"linux-x64": { package: "@openai/codex-linux-x64", target: "x86_64-unknown-linux-musl" },
	"linux-arm64": { package: "@openai/codex-linux-arm64", target: "aarch64-unknown-linux-musl" },
	"darwin-x64": { package: "@openai/codex-darwin-x64", target: "x86_64-apple-darwin" },
	"darwin-arm64": { package: "@openai/codex-darwin-arm64", target: "aarch64-apple-darwin" },
};

export function codexSandboxExecutable(): string {
	const native = nativeTargets[`${process.platform}-${process.arch}`];
	if (!native) throw new Error(`当前平台没有沙箱组件：${process.platform}/${process.arch}`);
	try {
		const packagePath = require.resolve(`${native.package}/package.json`);
		const executable = join(
			dirname(packagePath),
			"vendor",
			native.target,
			"bin",
			process.platform === "win32" ? "codex.exe" : "codex",
		);
		if (!existsSync(executable)) throw new Error("Missing native executable");
		return executable;
	} catch (error) {
		throw new Error(
			"沙箱组件未安装完整；请使用 npm install --ignore-scripts 安装工作台依赖。不会降级为无沙箱执行。",
			{ cause: error },
		);
	}
}

/** Uses only the native command sandbox: no Codex model, login, or agent session. */
export function sandboxCommand(
	cwd: string,
	executable: string,
	args: string[],
	policy: RuntimeSandboxPolicy,
): { executable: string; args: string[] } {
	if (policy.mode === "danger-full-access") return { executable, args };
	for (const root of policy.writableRoots) {
		try {
			if (!isAbsolute(root) || !statSync(root).isDirectory() || realpathSync(root) !== root)
				throw new Error("Writable root changed");
		} catch (error) {
			throw new Error("额外可写目录已变化，请重新选择并保存沙箱设置", { cause: error });
		}
	}
	const profile = `workbench_${randomUUID().replaceAll("-", "")}`;
	const filesystem = [
		'":tmpdir" = "read"',
		'":slash_tmp" = "read"',
		...(policy.protectedPaths ?? []).map((path) => `${JSON.stringify(resolve(path))} = "deny"`),
	].join(", ");
	const roots = policy.writableRoots.map((path) => `${JSON.stringify(resolve(path))} = true`).join(", ");
	const configuration = `{ extends = ${JSON.stringify(policy.mode === "read-only" ? ":read-only" : ":workspace")}, filesystem = { ${filesystem} }, network = { enabled = ${policy.networkAccess} }, workspace_roots = { ${roots} } }`;
	return {
		executable: codexSandboxExecutable(),
		args: [
			"sandbox",
			"-P",
			profile,
			"-C",
			resolve(cwd),
			"-c",
			`permissions.${profile}=${configuration}`,
			...(process.platform === "win32"
				? ["-c", `windows.sandbox=${policy.windowsImplementation ?? "elevated"}`]
				: []),
			"--",
			executable,
			...args,
		],
	};
}
