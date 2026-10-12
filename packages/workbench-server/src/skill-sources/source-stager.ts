import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { SkillSourceStager, StageSkillSourceInput, StageSkillSourceResult } from "@earendil-works/workbench-core";
import { WorkbenchError } from "@earendil-works/workbench-core";
import { stageGitSkills } from "./git-source.ts";
import { stageLocalSkills } from "./local-source.ts";

export class WorkbenchSkillSourceStager implements SkillSourceStager {
	private readonly cacheRoot: string;

	constructor(cacheRoot: string) {
		this.cacheRoot = resolve(cacheRoot);
	}

	async stage(input: StageSkillSourceInput): Promise<StageSkillSourceResult> {
		this.assertStagingPath(input.stagingPath);
		if (input.source === "local") {
			await stageLocalSkills(input);
			return {};
		}
		return { commit: await stageGitSkills(input) };
	}

	async remove(stagingPath: string): Promise<void> {
		this.assertStagingPath(stagingPath);
		await rm(stagingPath, { recursive: true, force: true });
	}

	private assertStagingPath(value: string): void {
		const path = relative(this.cacheRoot, resolve(value));
		if (!path || path.startsWith("..") || isAbsolute(path)) {
			throw new WorkbenchError("path_denied", "Skill staging path is outside the Workbench cache");
		}
	}
}
