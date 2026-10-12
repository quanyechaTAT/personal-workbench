import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { SkillCatalogReader, SkillCatalogResult } from "@earendil-works/workbench-core";

export class PiSkillCatalog implements SkillCatalogReader {
	readDirectory(directory: string, source: string): SkillCatalogResult {
		const result = loadSkillsFromDir({ dir: directory, source });
		return {
			skills: result.skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
				baseDir: skill.baseDir,
				disableModelInvocation: skill.disableModelInvocation,
			})),
			diagnostics: result.diagnostics.map((diagnostic) => ({
				type: diagnostic.type,
				message: diagnostic.message,
				path: diagnostic.path,
			})),
		};
	}
}
