import { cp, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { inspectSkillFiles, type StageSkillSourceInput, WorkbenchError } from "@earendil-works/workbench-core";

export async function stageLocalSkills(input: StageSkillSourceInput): Promise<void> {
	const sourceRoot = await realpath(input.location).catch((error: unknown) => {
		throw new WorkbenchError("not_found", `Local Skill source is unavailable: ${String(error)}`);
	});
	if (!(await stat(sourceRoot)).isDirectory())
		throw new WorkbenchError("invalid_input", "Local Skill source must be a directory");
	if ((await lstat(input.location)).isSymbolicLink())
		throw new WorkbenchError("invalid_input", "Local Skill source cannot be a symbolic link");
	const selected = input.subdirectory ? resolve(sourceRoot, input.subdirectory) : sourceRoot;
	assertContained(sourceRoot, selected);
	const selectedReal = await realpath(selected).catch(() => {
		throw new WorkbenchError("not_found", "Local Skill subdirectory is unavailable");
	});
	assertContained(sourceRoot, selectedReal);
	await inspectSkillFiles(selectedReal);
	await mkdir(input.stagingPath, { recursive: true });
	const entries = await readdir(selectedReal, { withFileTypes: true });
	const isSingleSkill = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");
	if (isSingleSkill) {
		await copySafe(selectedReal, join(input.stagingPath, basename(selectedReal)));
		return;
	}
	for (const entry of entries) await copySafe(join(selectedReal, entry.name), join(input.stagingPath, entry.name));
}

async function copySafe(source: string, destination: string): Promise<void> {
	const metadata = await lstat(source);
	if (metadata.isSymbolicLink()) throw new WorkbenchError("invalid_input", `Skill source contains a link: ${source}`);
	if (metadata.isDirectory()) {
		await mkdir(destination, { recursive: false });
		for (const entry of await readdir(source)) await copySafe(join(source, entry), join(destination, entry));
		return;
	}
	if (!metadata.isFile())
		throw new WorkbenchError("invalid_input", `Skill source contains an unsupported file: ${source}`);
	await cp(source, destination, { errorOnExist: true, force: false });
}

function assertContained(root: string, value: string): void {
	const path = relative(resolve(root), resolve(value));
	if (path.startsWith("..") || isAbsolute(path))
		throw new WorkbenchError("path_denied", "Skill subdirectory escapes the selected source");
}
