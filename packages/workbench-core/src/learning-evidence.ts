import type { LearningSource } from "./learning.ts";

/** Resolve only a unique reference inside this run's bounded snapshot. Never search other history. */
export function learningSourceMatches(sources: LearningSource[], sourceId: string): LearningSource[] {
	return sources.filter(
		(source) => source.id === sourceId || source.piEntryId === sourceId || source.toolCallId === sourceId,
	);
}
