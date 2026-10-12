import type {
	ContextAssemblyResult,
	MemoryEvidence,
	MemoryRetrievalResult,
} from "@earendil-works/workbench-core/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.ts";
import { ErrorNotice, LoadingBlock } from "./ui.tsx";
import "./memory-layers-panel.css";

const states: Record<string, string> = {
	user_confirmed: "用户确认",
	verified: "工具验证",
	unknown: "来源未知",
	unverified: "未验证",
	active: "有效",
	superseded: "已替代",
	invalidated: "已失效",
	detected: "内容冲突",
	external_edit: "外部编辑，需重新确认",
	none: "无冲突",
	success: "成功",
	failure: "失败",
	cancelled: "已取消",
	interrupted: "中断",
	running: "运行中",
	completed: "已结束",
	failed: "失败",
	queued: "排队",
	complete: "已整理",
	working: "工作检查点",
	semantic: "语义事实",
	episodic: "历史经历",
	perceptual: "原始资料",
	skill: "适用技能",
	original: "原始内容",
	model: "模型生成",
	user: "用户输入",
	present: "来源可用",
	missing: "来源缺失",
	retained_excerpt: "来源缺失，保留摘录",
	personal: "个人",
	global: "全局",
	project: "项目",
	session: "会话",
};
export function MemoryManifest({
	result,
	actual = false,
}: {
	result?: MemoryRetrievalResult | ContextAssemblyResult;
	actual?: boolean;
}) {
	return (
		<section className="memory-manifest" aria-label={actual ? "本轮实际记忆上下文" : "下一轮记忆预览"}>
			<h3>{actual ? "本轮实际记忆上下文" : "下一轮记忆预览"}</h3>
			{!result ? (
				<p>尚无模型请求记录。</p>
			) : (
				<>
					{"runId" in result && (
						<small>
							运行 {result.runId} · 请求 {result.request} · {result.createdAt}
						</small>
					)}
					<p>
						{result.characters} 字符 · 约 {result.estimatedTokens} Token · 检索 {Math.round(result.elapsedMs)} ms
					</p>
					{result.fragments.map((fragment) => (
						<details key={`${fragment.layer}:${fragment.id}`}>
							<summary>
								{fragment.instruction
									? `用户执行约定（${states[fragment.instruction.scope]}）`
									: states[fragment.layer]}{" "}
								· {fragment.label}
								{fragment.version ? ` · v${fragment.version}` : ""}
								{fragment.truncated ? " · 已截断" : ""}
							</summary>
							<small>{fragment.reason}</small>
							<pre>{fragment.text}</pre>
							<EvidenceList sources={fragment.sources} />
						</details>
					))}
					{!result.fragments.length && <p>本轮没有加入动态记忆。</p>}
					{"loadedSkills" in result &&
						result.loadedSkills?.map((skill) => (
							<details key={skill.path}>
								<summary>技能正文已读取 · {skill.method === "invocation" ? "原生命令" : "文件读取"}</summary>
								<code>{skill.path}</code>
								<p>版本指纹：{skill.hash}</p>
							</details>
						))}
					{result.diagnostics.map((text) => (
						<p className="quiet-copy" key={text}>
							{text}
						</p>
					))}
				</>
			)}
		</section>
	);
}
function EvidenceList({
	sources,
	sessionId,
	episodeId,
}: {
	sources: MemoryEvidence[];
	sessionId?: string;
	episodeId?: string;
}) {
	const inspect = useMutation({ mutationFn: (index: number) => api.memoryEvidence(sessionId!, index, episodeId) });
	return (
		<div className="memory-evidence">
			{sources.map((source, index) => (
				<details key={`${source.id}:${index}`}>
					<summary>
						{source.kind} · {source.piEntryId ?? source.id} · {states[source.confirmation]} ·{" "}
						{states[source.availability]}
					</summary>
					<small>{source.path}</small>
					<pre>{source.excerpt ?? "未保存摘录"}</pre>
					{sessionId && (
						<button type="button" disabled={inspect.isPending} onClick={() => inspect.mutate(index)}>
							核对来源
						</button>
					)}
				</details>
			))}
			{inspect.data && (
				<pre>
					{states[inspect.data.availability]}\n{inspect.data.excerpt}
				</pre>
			)}
			{inspect.error && <ErrorNotice error={inspect.error} />}
		</div>
	);
}
export function SessionMemoryPanel({ sessionId }: { sessionId: string }) {
	const queryClient = useQueryClient();
	const rebuild = useMutation({ mutationFn: () => api.rebuildEpisodeVectors(sessionId) });
	const [search, setSearch] = useState("");
	const value = useQuery({
		queryKey: ["session-memory", sessionId, search],
		queryFn: () => api.sessionMemory(sessionId, search),
		refetchInterval: 3000,
	});
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteEpisode(sessionId, id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-memory", sessionId] }),
	});
	const download = useMutation({
		mutationFn: (id: string) => api.exportEpisode(sessionId, id),
		onSuccess: (data) => {
			const url = URL.createObjectURL(new Blob([data.markdown], { type: "text/markdown;charset=utf-8" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = "经历.md";
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		},
	});
	const checkpoint = value.data?.checkpoint;
	return (
		<section className="memory-state-panel" aria-label="会话工作与情景记忆">
			<h3>当前工作检查点</h3>
			{value.isLoading && <LoadingBlock />}
			{value.error && <ErrorNotice error={value.error} />}
			{!checkpoint && !value.isLoading && <p>暂无有效检查点。结束运行后保存，默认有效期 30 天。</p>}
			{checkpoint && (
				<>
					<p>
						v{checkpoint.version} · {states[checkpoint.status]} · 更新于 {checkpoint.updatedAt}
					</p>
					<strong>{checkpoint.goal}</strong>
					<dl>
						{[
							["完成步骤", checkpoint.completedSteps],
							["下一步", checkpoint.nextSteps],
							["确认约束", checkpoint.constraints],
							["未解决问题", checkpoint.unresolvedQuestions],
							["临时结论（未验证）", checkpoint.temporaryConclusions.map((item) => item.text)],
						].map(([title, items]) => (
							<div key={String(title)}>
								<dt>{title}</dt>
								<dd>
									{Array.isArray(items) && items.length ? (
										<ul>
											{items.map((text) => (
												<li key={text}>{text}</li>
											))}
										</ul>
									) : (
										"暂无"
									)}
								</dd>
							</div>
						))}
					</dl>
					<small>
						过期时间 {checkpoint.expiresAt}
						{checkpoint.review ? ` · 整理：${states[checkpoint.review.status]}` : ""}
					</small>
					{checkpoint.review?.error && <p>{checkpoint.review.error}</p>}
					<EvidenceList sources={checkpoint.sources} sessionId={sessionId} />
				</>
			)}
			<h3>历史经历</h3>
			<button type="button" disabled={rebuild.isPending} onClick={() => rebuild.mutate()}>
				{rebuild.isPending ? "重建中…" : "重建经历向量（调用文本 Embedding）"}
			</button>
			{rebuild.data && <p>已重建 {rebuild.data.indexed} 条经历的向量。</p>}
			{rebuild.error && <ErrorNotice error={rebuild.error} />}
			<input
				aria-label="搜索情景记忆"
				placeholder="按任务关键词查找经历"
				value={search}
				onChange={(event) => setSearch(event.target.value)}
			/>
			{value.data?.episodes.length === 0 && <p>暂无保留的任务经历。</p>}
			{value.data?.episodes.map((episode) => (
				<details key={episode.id}>
					<summary>
						{states[episode.outcome]} · {episode.summary} · {episode.occurredAt}
					</summary>
					<p>助手结果摘要（须验证）：{episode.result}</p>
					{episode.actions.map((action, index) => (
						<pre key={`${action.toolCallId}:${index}`}>
							{action.verified ? "工具验证" : "失败／未验证"} · {action.tool}\n{action.result}
						</pre>
					))}
					<small>
						关联事实 {episode.semanticIds.length} · 技能 {episode.skillIds.length}
					</small>
					<EvidenceList sources={episode.sources} sessionId={sessionId} episodeId={episode.id} />
					<div className="memory-actions">
						<button type="button" onClick={() => download.mutate(episode.id)}>
							导出 Markdown
						</button>
						<button
							type="button"
							disabled={remove.isPending || Boolean(episode.semanticIds.length || episode.skillIds.length)}
							onClick={() => {
								if (window.confirm("删除此经历及保留摘录？Pi 会话历史仍保留。")) remove.mutate(episode.id);
							}}
						>
							删除经历
						</button>
					</div>
				</details>
			))}
			{remove.error && <ErrorNotice error={remove.error} />}
			{download.error && <ErrorNotice error={download.error} />}
		</section>
	);
}
