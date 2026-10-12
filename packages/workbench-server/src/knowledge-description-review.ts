import { createHash } from "node:crypto";
import type { KnowledgeDerivedDocument, KnowledgeDocument, KnowledgeSource } from "@earendil-works/workbench-core";

export function descriptionReview(document: KnowledgeDocument, derived?: KnowledgeDerivedDocument) {
	const sources = derived?.sources.filter((source) => source.representation === "model_description") ?? [];
	if (!derived || !sources.length) return undefined;
	const fingerprint = createHash("sha256")
		.update(JSON.stringify([document.sha256, derived.markdown, sources]))
		.digest("hex");
	return {
		fingerprint,
		reviewedAt:
			document.descriptionReview?.fingerprint === fingerprint ? document.descriptionReview.reviewedAt : undefined,
	};
}

export function reviewedSources(
	sources: KnowledgeSource[] | undefined,
	reviewedAt?: string,
): KnowledgeSource[] | undefined {
	return sources?.map((source) =>
		source.representation === "model_description" ? { ...source, reviewedAt } : source,
	);
}

export function reviewedDiagnostics(diagnostics: string[], reviewedAt?: string): string[] {
	return reviewedAt
		? diagnostics.map((value) =>
				value === "图像描述由模型生成，尚未经用户确认。"
					? `图像描述已由用户核对（${reviewedAt}）；仍保留模型生成来源。`
					: value,
			)
		: diagnostics;
}
