import type { KnowledgeSettings, KnowledgeSource } from "@earendil-works/workbench-core/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useOutletContext } from "react-router";
import { api, type Project } from "./api.ts";
import { HydeTrace } from "./hyde-trace.tsx";
import { PerceptionPreview, SourceLocator } from "./perception-preview.tsx";
import { EmptyState, ErrorNotice, LoadingBlock } from "./ui.tsx";
import "./knowledge-page.css";

const STAGES = { queued: "排队中", parsing: "正在解析", embedding: "正在嵌入", ready: "可检索", failed: "处理失败" };

export function ProjectKnowledge() {
	const project = useOutletContext<Project>();
	return <KnowledgeWorkspace project={project} key={project.id} />;
}

function KnowledgeWorkspace({ project }: { project: Project }) {
	const queryClient = useQueryClient();
	const [queryText, setQueryText] = useState("");
	const [searchText, setSearchText] = useState("");
	const [selectedId, setSelectedId] = useState<string>();
	const [located, setLocated] = useState<KnowledgeSource>();
	const [uploadProgress, setUploadProgress] = useState("");
	const [draft, setDraft] = useState<KnowledgeSettings>();
	const refresh = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["knowledge", project.id] }),
			queryClient.invalidateQueries({ queryKey: ["knowledge-documents", project.id] }),
			queryClient.invalidateQueries({ queryKey: ["knowledge-search", project.id] }),
			queryClient.invalidateQueries({ queryKey: ["knowledge-preview", project.id] }),
		]);
	};
	const status = useQuery({
		queryKey: ["knowledge", project.id],
		queryFn: () => api.knowledgeStatus(project.id),
		refetchInterval: 1500,
	});
	const documents = useQuery({
		queryKey: ["knowledge-documents", project.id],
		queryFn: () => api.knowledgeDocuments(project.id),
		refetchInterval: 1500,
	});
	const preview = useQuery({
		queryKey: ["knowledge-preview", project.id, selectedId],
		queryFn: () => api.knowledgePreview(project.id, selectedId!),
		enabled: Boolean(selectedId),
		refetchInterval: (query) =>
			query.state.data && ["queued", "processing"].includes(query.state.data.document.status) ? 1500 : false,
	});
	const search = useQuery({
		queryKey: ["knowledge-search", project.id, queryText],
		queryFn: ({ signal }) => api.retrieveKnowledge(project.id, queryText, signal),
		enabled: Boolean(queryText),
	});
	const upload = useMutation({
		mutationFn: async (files: File[]) => {
			for (let index = 0; index < files.length; index++) {
				setUploadProgress(`上传 ${index + 1}/${files.length}：${files[index].name}`);
				const document = await api.uploadKnowledge(project.id, files[index]);
				setSelectedId(document.id);
				await refresh();
			}
		},
		onSettled: () => setUploadProgress(""),
		onSuccess: refresh,
	});
	const index = useMutation({ mutationFn: () => api.indexKnowledge(project.id), onSuccess: refresh });
	const configure = useMutation({
		mutationFn: (settings: KnowledgeSettings) => api.configureKnowledge(project.id, settings),
		onSuccess: async () => {
			setDraft(undefined);
			await refresh();
		},
	});
	const cancel = useMutation({
		mutationFn: (id: string) => api.cancelKnowledgeDocument(project.id, id),
		onSuccess: refresh,
	});
	const retry = useMutation({
		mutationFn: (id: string) => api.retryKnowledgeDocument(project.id, id),
		onSuccess: refresh,
	});
	const removeIndex = useMutation({
		mutationFn: (id: string) => api.deleteKnowledgeIndex(project.id, id),
		onSuccess: refresh,
	});
	const confirmDescription = useMutation({
		mutationFn: () =>
			api.confirmKnowledgeDescription(project.id, selectedId!, preview.data!.descriptionReview!.fingerprint),
		onSuccess: refresh,
	});
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteKnowledgeDocument(project.id, id),
		onSuccess: async (_value, id) => {
			if (selectedId === id) setSelectedId(undefined);
			await refresh();
		},
	});
	return (
		<div className="project-subpage knowledge-workspace">
			<div className="subpage-heading">
				<div>
					<span className="eyebrow">项目专属资料</span>
					<h2>知识库</h2>
					<p>上传资料后自动解析、分段和嵌入。当前项目的助手会检索相关片段，并引用文档来源。</p>
				</div>
				<div className="knowledge-actions">
					<label className="button primary knowledge-upload">
						{upload.isPending ? "正在上传…" : "上传文档"}
						<input
							aria-label="上传知识文档"
							type="file"
							multiple
							accept=".pdf,.docx,.doc,.txt,.md,.markdown,.rst,.adoc,.ts,.tsx,.js,.jsx,.py,.go,.rs,.json,.yaml,.yml,.png,.jpg,.jpeg,.bmp,.wav,.mp3"
							disabled={upload.isPending}
							onChange={(event) => {
								const files = Array.from(event.currentTarget.files ?? []);
								event.currentTarget.value = "";
								if (files.length) upload.mutate(files);
							}}
						/>
					</label>
					<button
						type="button"
						className="button secondary"
						disabled={index.isPending}
						onClick={() => index.mutate()}
					>
						{index.isPending ? "正在建立索引…" : "建立／更新索引"}
					</button>
				</div>
			</div>
			<p className="knowledge-note">
				支持 PDF、Word、文本、PNG／JPEG／BMP、单声道 PCM WAV／MP3；单文件最多 20 MiB。OCR、转写、图像描述与
				Embedding 使用系统 .env 中的独立能力配置。资料会发送至所配置服务；能力缺失时保留原件并显示原因。
			</p>
			{uploadProgress && <output>{uploadProgress}</output>}
			{status.isLoading && <LoadingBlock label="正在读取知识库" />}
			{status.error && <ErrorNotice error={status.error} />}
			{documents.error && <ErrorNotice error={documents.error} />}
			{upload.error && <ErrorNotice error={upload.error} />}
			{index.error && <ErrorNotice error={index.error} />}
			{retry.error && <ErrorNotice error={retry.error} />}
			{remove.error && <ErrorNotice error={remove.error} />}
			{configure.error && <ErrorNotice error={configure.error} />}
			{cancel.error && <ErrorNotice error={cancel.error} />}
			{removeIndex.error && <ErrorNotice error={removeIndex.error} />}
			{confirmDescription.error && <ErrorNotice error={confirmDescription.error} />}
			{status.data?.capabilities && (
				<section className="knowledge-status" aria-label="感知服务能力">
					{status.data.capabilities.map((capability) => (
						<span key={capability.name}>
							<strong>
								{(
									{ ocr: "OCR 识别", asr: "音频转写", vision: "图像描述", multimodal: "图文向量" } as Record<
										string,
										string
									>
								)[capability.name] ?? capability.name}{" "}
								· {capability.configured ? "已配置（供应商权限待实测）" : "能力缺失"}
							</strong>
							<small>{capability.model}</small>
							{capability.diagnostic && <output>{capability.diagnostic}</output>}
						</span>
					))}
				</section>
			)}
			{status.data && (
				<div className="knowledge-status">
					<span>
						<small>系统 Embedding 模型</small>
						<strong>{status.data.model ?? "未配置"}</strong>
						<small>Tokenizer：{status.data.tokenizer ?? "待配置"}</small>
					</span>
					<span>
						<small>SQLite 向量数据库</small>
						<strong>
							sqlite-vec · 文件：{status.data.fileCount} · 片段：{status.data.chunkCount}
						</strong>
					</span>
					<span>
						<small>上传文档</small>
						<strong>
							{status.data.documentCount} 份 · 处理中 {status.data.processingCount} · 失败{" "}
							{status.data.failedCount}
						</strong>
					</span>
					{status.data.diagnostic && <output>{status.data.diagnostic}</output>}
				</div>
			)}
			{status.data?.settings && (
				<details className="knowledge-parameters">
					<summary>分块与检索参数</summary>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							configure.mutate(draft ?? status.data!.settings!);
						}}
					>
						{(
							[
								["maxChunkTokens", "片段 Token 上限", 64, 8192],
								["minChunkTokens", "短片段合并阈值", 0, 8192],
								["overlapTokens", "相邻片段重叠 Token", 0, 4096],
								["contextTokens", "上下文 Token 预算", 128, 32768],
								["queryTokens", "查询 Token 上限", 32, 8192],
								["mqeTimeoutMs", "MQE 超时（毫秒）", 100, 10000],
								["hydeTimeoutMs", "HyDE 超时（毫秒）", 100, 10000],
								["hydeTokens", "HyDE Token 上限", 32, 1024],
							] as const
						).map(([key, label, min, max]) => (
							<label key={key}>
								{label}
								<input
									type="number"
									min={min}
									max={max}
									required
									value={(draft ?? status.data!.settings!)[key]}
									onChange={(event) =>
										setDraft({ ...(draft ?? status.data!.settings!), [key]: Number(event.target.value) })
									}
								/>
							</label>
						))}
						<label>
							多查询扩展（MQE）
							<select
								value={(draft ?? status.data.settings).mqe}
								onChange={(event) => {
									const mqe = event.target.value;
									if (mqe === "off" || mqe === "auto" || mqe === "always")
										setDraft({ ...(draft ?? status.data!.settings!), mqe });
								}}
							>
								<option value="off">关闭</option>
								<option value="auto">自动</option>
								<option value="always">始终启用</option>
							</select>
						</label>
						<label>
							假设文档召回（HyDE）
							<select
								value={(draft ?? status.data.settings).hyde ?? "off"}
								onChange={(event) => {
									const hyde = event.target.value;
									if (hyde === "off" || hyde === "auto" || hyde === "always")
										setDraft({ ...(draft ?? status.data!.settings!), hyde });
								}}
							>
								<option value="off">关闭</option>
								<option value="auto">自动</option>
								<option value="always">始终启用</option>
							</select>
						</label>
						<button
							type="submit"
							className="button secondary"
							disabled={configure.isPending || index.isPending || Boolean(status.data.processingCount)}
						>
							保存参数
						</button>
					</form>
					<p>
						修改分块参数后点击“建立／更新索引”。MQE、HyDE 和检索预算即时生效。 对话中两项生成都使用当前选中的
						LLM，无工具权限；HyDE 默认关闭，开启会增加生成与嵌入请求。
						上下文预算包含来源、标题、分隔符和完整片段，按页面所示 tokenizer 计数。
					</p>
				</details>
			)}
			<div className="knowledge-library">
				<section className="knowledge-documents" aria-label="已上传文档">
					<h3>上传文档</h3>
					{documents.data?.map((document) => (
						<article
							className={`knowledge-document ${selectedId === document.id ? "selected" : ""}`}
							key={document.id}
						>
							<button
								type="button"
								className="knowledge-document-title"
								onClick={() => {
									setSelectedId(document.id);
									setLocated(undefined);
								}}
							>
								<strong>{document.name}</strong>
								<small>
									{(document.size / 1024).toFixed(1)} KiB
									{document.pageCount ? ` · ${document.pageCount} 页` : ""} · {document.chunkCount} 个片段
								</small>
							</button>
							<output className={`knowledge-stage ${document.stage}`}>
								{STAGES[document.stage]}
								{document.processingStage
									? ` · ${{ ocr: "文字识别", transcribing: "音频转写", describing: "图像描述", embedding: "向量索引" }[document.processingStage]}`
									: ""}
								{document.progress ? ` ${document.progress.completed}/${document.progress.total}` : ""}
								{document.processingState
									? ` · ${{ partial: "部分完成", missing_capability: "能力缺失", cancelled: "已取消", interrupted: "中断，可重试", stale: "索引失效，需重建" }[document.processingState]}`
									: ""}
								{document.stage === "embedding" ? ` ${document.processedChunks}/${document.chunkCount}` : ""}
							</output>
							{document.error && <p className="knowledge-document-error">{document.error}</p>}
							{document.diagnostics?.map((message) => (
								<p className="knowledge-note" key={message}>
									{message}
								</p>
							))}
							<div className="knowledge-document-actions">
								<a
									href={`/api/v1/projects/${encodeURIComponent(project.id)}/knowledge/documents/${encodeURIComponent(document.id)}/file`}
									download={document.name}
								>
									下载原文
								</a>
								{document.status === "ready" && (
									<a
										href={`/api/v1/projects/${project.id}/knowledge/documents/${document.id}/markdown`}
										download
									>
										下载 Markdown
									</a>
								)}
								{["queued", "processing"].includes(document.status) && (
									<button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(document.id)}>
										取消处理
									</button>
								)}
								<button
									type="button"
									disabled={["queued", "processing"].includes(document.status) || retry.isPending}
									onClick={() => retry.mutate(document.id)}
								>
									{document.status === "failed" ? "重试" : "重建索引"}
								</button>
								<button
									type="button"
									disabled={remove.isPending}
									onClick={() => {
										if (window.confirm(`删除“${document.name}”的原文和知识索引？`))
											remove.mutate(document.id);
									}}
								>
									删除
								</button>
								<button
									type="button"
									disabled={removeIndex.isPending || ["queued", "processing"].includes(document.status)}
									onClick={() => removeIndex.mutate(document.id)}
								>
									仅删除索引，保留原件
								</button>
							</div>
						</article>
					))}
					{documents.data?.length === 0 && (
						<EmptyState
							title="添加项目资料"
							description="点击上传文档，选择 PDF、Word 或文本资料。索引完成后即可在聊天中询问相关内容。"
						/>
					)}
				</section>
				<section className="knowledge-preview" aria-label="知识文档预览">
					<h3>{preview.data?.document.name ?? "文档预览"}</h3>
					{preview.isLoading && selectedId && <LoadingBlock label="正在加载文档" />}
					{preview.error && <ErrorNotice error={preview.error} />}
					{preview.data && (
						<PerceptionPreview
							key={`${preview.data.document.id}:${located?.page}`}
							projectId={project.id}
							document={preview.data.document}
							source={located}
						/>
					)}
					{preview.data?.derived && (
						<details>
							<summary>派生 Markdown 与来源映射</summary>
							<a href={`/api/v1/projects/${project.id}/knowledge/documents/${selectedId}/markdown`} download>
								下载完整 Markdown
							</a>
							<a href={`/api/v1/projects/${project.id}/knowledge/documents/${selectedId}/sources`} download>
								下载来源映射
							</a>
							<pre>{preview.data.derived.markdown.slice(0, 20000)}</pre>
							{preview.data.derived.markdown.length > 20000 && (
								<p>Markdown 预览仅显示前 20000 字符，可下载完整内容。</p>
							)}
							{preview.data.derived.diagnostics.map((message) => (
								<p key={message}>{message}</p>
							))}
						</details>
					)}
					{preview.data?.descriptionReview && (
						<section aria-label="图像描述人工核对">
							<p>
								{preview.data.descriptionReview.reviewedAt
									? "图像描述已由用户核对，来源仍为模型生成。"
									: "图像描述是模型生成的可检索派生内容；请对照上方原件及下方片段核对，确认后保留人工核对标记。"}
							</p>
							{!preview.data.descriptionReview.reviewedAt && (
								<button
									type="button"
									disabled={confirmDescription.isPending || preview.data.document.status !== "ready"}
									onClick={() => confirmDescription.mutate()}
								>
									我已对照原件核对图像描述
								</button>
							)}
						</section>
					)}
					{!selectedId && <p>选择左侧文档查看提取的正文及页码。</p>}
					{preview.data?.document.status !== "ready" && selectedId && (
						<p>文档完成处理后可在这里查看正文；处理状态在左侧显示。</p>
					)}
					{preview.data?.passages.map((passage) => (
						<article key={passage.ordinal}>
							<small>{passage.startPage ? `第 ${passage.startPage} 页` : `片段 ${passage.ordinal + 1}`}</small>
							<small>
								{" "}
								· {passage.headingPath?.join(" / ")} · {passage.tokenCount ?? "旧索引"} Token
								{passage.overlap ? ` · 含 ${passage.overlap.tokenCount} Token 重叠` : ""}
							</small>
							<pre>{passage.text}</pre>
							{passage.sources?.map((source, index) => (
								<SourceLocator
									key={`${source.kind}:${index}`}
									source={source}
									onLocate={() => setLocated(source)}
								/>
							))}
						</article>
					))}
					{(preview.data?.document.chunkCount ?? 0) > 50 && <p>预览显示前 50 个片段，检索使用全部片段。</p>}
				</section>
			</div>
			<details className="knowledge-project-source">
				<summary>同时索引项目目录中的文件</summary>
				<p>
					“建立／更新索引”会扫描项目中的 PDF、Word
					和文本文件，并更新上传文档。隐藏文件、.env、依赖和构建目录会被排除。
				</p>
				<code>{project.sourcePath ?? project.workspacePath}</code>
				<Link to="../files">浏览项目文件</Link>
			</details>
			<form
				className="knowledge-search"
				onSubmit={(event) => {
					event.preventDefault();
					const next = searchText.trim();
					if (next === queryText) void search.refetch();
					else setQueryText(next);
				}}
			>
				<label htmlFor="project-knowledge-query">检索项目资料</label>
				<div>
					<input
						id="project-knowledge-query"
						value={searchText}
						onChange={(event) => setSearchText(event.target.value)}
						placeholder="输入要查找的问题"
					/>
					<button type="submit" className="button secondary" disabled={!searchText.trim() || search.isFetching}>
						检索
					</button>
				</div>
			</form>
			{search.error && <ErrorNotice error={search.error} />}
			<div className="knowledge-results" aria-live="polite">
				{search.isFetching && <p>正在检索项目资料…</p>}
				{search.data && (
					<div className="knowledge-search-trace">
						<strong>实际查询</strong>
						<ol>
							{search.data.queries.map((query) => (
								<li key={query}>{query}</li>
							))}
						</ol>
						<p>
							MQE：{search.data.mqe.applied ? "已扩展" : "使用原查询"} · {search.data.mqe.reason}
						</p>
						<HydeTrace trace={search.data.hyde} />
						<p>
							上下文 {search.data.contextTokens} Token · {search.data.tokenizer ?? "未计数"} ·{" "}
							{Math.round(search.data.elapsedMs)} ms
						</p>
						{search.data.diagnostics.map((message) => (
							<output key={message}>{message}</output>
						))}
					</div>
				)}
				{!search.isFetching && queryText && search.data?.hits.length === 0 && <p>当前项目没有找到相关片段。</p>}
				{search.data?.hits.map((hit) => (
					<article className="knowledge-result" key={`${hit.documentId ?? hit.path}:${hit.chunk}`}>
						<header>
							<h3>
								{hit.name ?? hit.path} · {hit.startPage ? `第 ${hit.startPage} 页 · ` : ""}片段 {hit.chunk + 1}
							</h3>
							{hit.documentId ? (
								<button
									type="button"
									onClick={() => {
										setSelectedId(hit.documentId);
										setLocated(hit.sources?.[0]);
									}}
								>
									查看文档
								</button>
							) : (
								<Link
									to={`/projects/${project.id}/files?path=${encodeURIComponent(hit.path)}`}
									aria-label={`在项目文件中打开 ${hit.path}`}
								>
									在项目文件中打开
								</Link>
							)}
						</header>
						<small>
							RRF {hit.score.toFixed(4)} · {hit.headingPath?.join(" / ")} · {hit.tokenCount} Token
						</small>
						<p className="knowledge-note">
							命中：
							{hit.matches
								?.map(
									(match) =>
										`${match.method === "keyword" ? "关键词" : match.method === "hyde" ? "HyDE 向量" : "向量"}（${match.query}，第 ${match.rank} 名）`,
								)
								.join("；")}
						</p>
						<pre>{hit.text}</pre>
						{hit.sources?.map((source, index) => (
							<SourceLocator
								key={`${source.kind}:${index}`}
								source={source}
								onLocate={
									hit.documentId
										? () => {
												setSelectedId(hit.documentId);
												setLocated(source);
											}
										: undefined
								}
							/>
						))}
					</article>
				))}
			</div>
		</div>
	);
}
