import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { WorkbenchError } from "./errors.ts";

export interface SkillFileManifest {
	hash: string;
	files: Array<{ path: string; sha256: string; size: number }>;
}

export async function inspectSkillFiles(root: string): Promise<SkillFileManifest> {
	const files: SkillFileManifest["files"] = [];
	let bytes = 0;
	async function walk(path: string): Promise<void> {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink())
			throw new WorkbenchError("path_denied", "Skills cannot contain symbolic links or junctions");
		if (metadata.isDirectory()) {
			const names = (await readdir(path)).sort();
			const unique = new Set<string>();
			for (const name of names) {
				if (
					/[<>:"/\\|?*\u0000-\u001f]/u.test(name) ||
					/[. ]$/u.test(name) ||
					/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
				)
					throw new WorkbenchError("invalid_input", `Unsupported Skill file name: ${name}`);
				if (unique.has(name.toLowerCase()))
					throw new WorkbenchError("invalid_input", `Skill file name collision: ${name}`);
				unique.add(name.toLowerCase());
				await walk(join(path, name));
			}
		} else if (metadata.isFile()) {
			bytes += metadata.size;
			if (bytes > 25 * 1024 * 1024 || files.length >= 2000)
				throw new WorkbenchError("invalid_input", "Skill exceeds 25 MB or 2000 files");
			files.push({
				path: relative(root, path).replaceAll("\\", "/"),
				sha256: createHash("sha256")
					.update(await readFile(path))
					.digest("hex"),
				size: metadata.size,
			});
		} else throw new WorkbenchError("invalid_input", "Unsupported Skill file type");
	}
	await walk(root);
	return { hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}
