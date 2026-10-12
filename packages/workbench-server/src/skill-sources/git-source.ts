import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import { inspectSkillFiles, type StageSkillSourceInput, WorkbenchError } from "@earendil-works/workbench-core";

interface GitFile {
	path: string;
	oid: string;
	size: number;
}

/** Read Git objects directly: no checkout, hooks, filters, archives, or submodules are executed. */
export async function stageGitSkills(input: StageSkillSourceInput): Promise<string> {
	let url: URL;
	try {
		url = new URL(input.location);
	} catch {
		throw new WorkbenchError("invalid_input", "Git Skill source must be a valid HTTPS URL");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
		throw new WorkbenchError("invalid_input", "Use a public HTTPS Git URL without credentials or query parameters");
	if (input.ref && (input.ref.startsWith("-") || !/^[A-Za-z0-9._/-]+$/u.test(input.ref)))
		throw new WorkbenchError("invalid_input", "Unsupported Git ref");
	const subdirectory = input.subdirectory?.replaceAll("\\", "/");
	if (subdirectory) validatePath(subdirectory);
	const repository = `${input.stagingPath}.repository`;
	try {
		await run(["init", "--bare", repository]);
		await run(["-C", repository, "fetch", "--depth=1", "--no-tags", "--", url.href, input.ref || "HEAD"]);
		const commit = (await run(["-C", repository, "rev-parse", "FETCH_HEAD"])).toString("utf8").trim();
		if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new WorkbenchError("invalid_input", "Invalid Git commit");
		const tree = subdirectory ? `${commit}:${subdirectory}` : commit;
		const files = parseGitTree((await run(["-C", repository, "ls-tree", "-r", "-z", "-l", tree])).toString("utf8"));
		const objects = await run(
			["-C", repository, "cat-file", "--batch"],
			`${files.map((file) => file.oid).join("\n")}\n`,
		);
		let offset = 0;
		for (const file of files) {
			const newline = objects.indexOf(10, offset);
			const header = objects.subarray(offset, newline).toString("utf8").split(" ");
			if (newline < offset || header[0] !== file.oid || header[1] !== "blob" || Number(header[2]) !== file.size)
				throw new WorkbenchError("storage_failure", "Git object does not match its manifest");
			const start = newline + 1;
			const end = start + file.size;
			if (end >= objects.length || objects[end] !== 10)
				throw new WorkbenchError("storage_failure", "Incomplete Git object");
			const destination = join(input.stagingPath, ...file.path.split("/"));
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, objects.subarray(start, end), { flag: "wx" });
			offset = end + 1;
		}
		await inspectSkillFiles(input.stagingPath);
		return commit;
	} finally {
		await rm(repository, { recursive: true, force: true });
	}
}

export function parseGitTree(output: string): GitFile[] {
	const files: GitFile[] = [];
	const names = new Map<string, string>();
	let bytes = 0;
	for (const entry of output.split("\0").filter(Boolean)) {
		const tab = entry.indexOf("\t");
		const [mode, type, oid, sizeText] = entry.slice(0, tab).trim().split(/\s+/u);
		const path = entry.slice(tab + 1);
		if (tab < 0 || !["100644", "100755"].includes(mode) || type !== "blob" || !/^[0-9a-f]{40,64}$/u.test(oid))
			throw new WorkbenchError("path_denied", "Git Skills cannot contain links, submodules, or special files");
		validatePath(path);
		const segments = path.split("/");
		for (let count = 1; count <= segments.length; count++) {
			const prefix = segments.slice(0, count).join("/");
			const previous = names.get(prefix.toLowerCase());
			if (previous && previous !== prefix)
				throw new WorkbenchError("invalid_input", "Git files have a case-insensitive collision");
			names.set(prefix.toLowerCase(), prefix);
		}
		const size = Number(sizeText);
		bytes += size;
		if (!Number.isSafeInteger(size) || size < 0 || bytes > 25 * 1024 * 1024 || files.length >= 2000)
			throw new WorkbenchError("invalid_input", "Git Skill source exceeds 25 MB or 2000 files");
		files.push({ path, oid, size });
	}
	if (!files.length) throw new WorkbenchError("invalid_input", "Git Skill source has no files");
	return files;
}

function validatePath(path: string): void {
	if (
		path
			.split("/")
			.some(
				(name) =>
					!name ||
					name === "." ||
					name === ".." ||
					/[<>:"\\|?*\u0000-\u001f]/u.test(name) ||
					/[. ]$/u.test(name) ||
					/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name),
			)
	)
		throw new WorkbenchError("path_denied", `Unsupported Git Skill path: ${path}`);
}

async function run(args: string[], input?: string): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const env: NodeJS.ProcessEnv = {
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: devNull,
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "Never",
		};
		for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"])
			if (process.env[key]) env[key] = process.env[key];
		const child = spawn(
			"git",
			[
				"-c",
				"credential.helper=",
				"-c",
				"protocol.allow=never",
				"-c",
				"protocol.https.allow=always",
				"-c",
				"http.followRedirects=false",
				...args,
			],
			{ windowsHide: true, shell: false, env },
		);
		const chunks: Buffer[] = [];
		let bytes = 0;
		let failure: Error | undefined;
		let stderr = "";
		const timer = setTimeout(() => {
			failure = new Error("Git operation timed out");
			child.kill();
		}, 120_000);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 27 * 1024 * 1024) {
				failure = new Error("Git output exceeds the import size limit");
				child.kill();
			} else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4000) stderr += chunk.toString("utf8");
		});
		child.stdin.on("error", (error) => {
			failure = error;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(new WorkbenchError("storage_failure", error.message, { cause: error }));
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (!failure && code === 0) resolvePromise(Buffer.concat(chunks));
			else reject(new WorkbenchError("invalid_input", failure?.message ?? `Git failed: ${stderr.trim()}`));
		});
		child.stdin.end(input);
	});
}
