import type { KnowledgeHydeTrace } from "@earendil-works/workbench-core/contracts";

export function HydeTrace({ trace }: { trace?: KnowledgeHydeTrace }) {
	if (!trace) return null;
	return (
		<section className="hyde-trace" aria-label="HyDE 检索记录">
			<p>
				HyDE：{trace.applied ? "已用于召回" : "未用于召回"} · {trace.reason}
			</p>
			{trace.model && (
				<p>
					生成 LLM：{trace.model.provider} / {trace.model.modelId}
				</p>
			)}
			{trace.document && (
				<details>
					<summary>
						假设检索文档（非证据）{trace.tokenCount !== undefined ? ` · ${trace.tokenCount} Token` : ""}
					</summary>
					<p>仅用于向量召回，不写入知识库，不作为回答引用。内容可能不真实。</p>
					<pre>{trace.document}</pre>
				</details>
			)}
		</section>
	);
}
