export interface SkillCatalogEntry {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation: boolean;
}

export interface SkillCatalogDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
}

export interface SkillCatalogResult {
	skills: SkillCatalogEntry[];
	diagnostics: SkillCatalogDiagnostic[];
}

export interface SkillCatalogReader {
	readDirectory(directory: string, source: string): Promise<SkillCatalogResult> | SkillCatalogResult;
}

export interface StageSkillSourceInput {
	source: "local" | "git";
	location: string;
	ref?: string;
	subdirectory?: string;
	stagingPath: string;
}

export interface StageSkillSourceResult {
	commit?: string;
}

export interface SkillSourceStager {
	stage(input: StageSkillSourceInput): Promise<StageSkillSourceResult>;
	remove(stagingPath: string): Promise<void>;
}
