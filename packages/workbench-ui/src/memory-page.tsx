import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, type MemoryCandidate, type MemoryFileRecord } from "./api.ts";
import { Icons } from "./icons.tsx";
import { label } from "./labels.ts";
import { EmptyState, ErrorNotice, formatRelative, LoadingBlock, PageHeader, StatusPill } from "./ui.tsx";

export function MemoryPage() {
	const queryClient = useQueryClient();
	const files = useQuery({ queryKey: ["memory-files"], queryFn: api.memoryFiles });
	const candidates = useQuery({ queryKey: ["candidates"], queryFn: api.candidates });
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	const [selected, setSelected] = useState<MemoryFileRecord>();
	const selectedFile = useQuery({
		queryKey: ["memory-file", selected?.relativePath],
		queryFn: () => api.memoryFile(selected!.relativePath),
		enabled: Boolean(selected),
	});
	const [draft, setDraft] = useState<string>();
	const [proposing, setProposing] = useState(false);
	const [kind, setKind] = useState<MemoryCandidate["kind"]>("global");
	const [projectId, setProjectId] = useState("");
	const [heading, setHeading] = useState("");
	const [proposedText, setProposedText] = useState("");
	const [reason, setReason] = useState("");
	const [search, setSearch] = useState("");
	const searchResults = useQuery({
		queryKey: ["memory-search", search, projectId],
		queryFn: () => api.memorySearch(search, projectId || undefined),
		enabled: search.trim().length > 0,
	});
	const selectMemory = (file: MemoryFileRecord | undefined) => {
		setSelected(file);
		setDraft(undefined);
	};
	const save = useMutation({
		mutationFn: () =>
			api.editMemory({
				path: selected!.relativePath,
				content: draft ?? selectedFile.data!.content,
				expectedHash: selectedFile.data!.contentHash,
				kind: selected!.kind,
				projectId: selected!.projectId,
			}),
		onSuccess: async () => {
			setDraft(undefined);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["memory-file", selected?.relativePath] }),
				queryClient.invalidateQueries({ queryKey: ["memory-files"] }),
			]);
		},
	});
	const propose = useMutation({
		mutationFn: () =>
			api.proposeMemory({
				kind,
				projectId: kind === "project" ? projectId : undefined,
				heading: heading || undefined,
				proposedText,
				reason,
			}),
		onSuccess: async () => {
			setProposedText("");
			setReason("");
			setHeading("");
			setProposing(false);
			await queryClient.invalidateQueries({ queryKey: ["candidates"] });
		},
	});
	const resolve = useMutation({
		mutationFn: ({ id, decision }: { id: string; decision: "accept" | "reject" }) =>
			api.resolveCandidate(id, decision),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["candidates"] }),
				queryClient.invalidateQueries({ queryKey: ["memory-files"] }),
				queryClient.invalidateQueries({ queryKey: ["file"] }),
				queryClient.invalidateQueries({ queryKey: ["memory-file"] }),
			]);
		},
	});
	const remove = useMutation({
		mutationFn: (file: MemoryFileRecord) =>
			api.deleteMemory({ path: file.relativePath, kind: file.kind, projectId: file.projectId }),
		onSuccess: async () => {
			selectMemory(undefined);
			await queryClient.invalidateQueries({ queryKey: ["memory-files"] });
		},
	});
	const submitProposal = (event: FormEvent) => {
		event.preventDefault();
		if (proposedText.trim() && reason.trim() && (kind !== "project" || projectId)) propose.mutate();
	};
	const pending = candidates.data?.filter((candidate) => candidate.status === "pending") ?? [];
	return (
		<div className="page-container memory-page">
			<PageHeader
				eyebrow="Markdown 原文"
				title="记忆"
				description="查看长期上下文，搜索本地记忆，并决定助手可以记住什么。"
				actions={
					<button type="button" className="button primary with-icon" onClick={() => setProposing(true)}>
						<Icons.Plus />
						提出记忆候选
					</button>
				}
			/>
			<div className="memory-search">
				<Icons.Memory />
				<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索工作台记忆…" />
				{search && (
					<button type="button" onClick={() => setSearch("")}>
						清除
					</button>
				)}
			</div>
			{search && (
				<section className="search-results">
					<div className="card-heading">
						<h3>搜索结果</h3>
						<span>{searchResults.data?.length ?? 0}</span>
					</div>
					{searchResults.isLoading && <LoadingBlock />}
					{searchResults.data?.map((result) => (
						<button
							type="button"
							key={result.memoryId}
							onClick={() => {
								const file = files.data?.find((entry) => entry.relativePath === result.relativePath);
								if (file) selectMemory(file);
								setSearch("");
							}}
						>
							<strong>
								{result.relativePath} · 行 {result.startLine}–{result.endLine}
							</strong>
							<p>{result.snippet}</p>
						</button>
					))}
				</section>
			)}
			{proposing && (
				<form className="create-panel memory-proposal" onSubmit={submitProposal}>
					<div>
						<span className="eyebrow">记忆候选</span>
						<h2>提出长期记忆</h2>
						<p>接受之前，修改只保存在候选中。</p>
					</div>
					<label>
						<span>记忆类型</span>
						<select value={kind} onChange={(event) => setKind(event.target.value as MemoryCandidate["kind"])}>
							<option value="user">用户</option>
							<option value="global">全局</option>
							<option value="daily">每日</option>
							<option value="project">项目</option>
						</select>
					</label>
					{kind === "project" && (
						<label>
							<span>项目</span>
							<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
								<option value="">选择项目</option>
								{projects.data?.map((project) => (
									<option key={project.id} value={project.id}>
										{project.name}
									</option>
								))}
							</select>
						</label>
					)}
					<label>
						<span>标题</span>
						<input
							value={heading}
							onChange={(event) => setHeading(event.target.value)}
							placeholder="可选的段落标题"
						/>
					</label>
					<label className="wide-field">
						<span>拟议内容</span>
						<textarea value={proposedText} onChange={(event) => setProposedText(event.target.value)} rows={4} />
					</label>
					<label className="wide-field">
						<span>为什么需要记住？</span>
						<input value={reason} onChange={(event) => setReason(event.target.value)} />
					</label>
					{propose.error && <ErrorNotice error={propose.error} />}
					<div className="form-actions">
						<button type="button" className="button secondary" onClick={() => setProposing(false)}>
							取消
						</button>
						<button
							type="submit"
							className="button primary"
							disabled={propose.isPending || !proposedText.trim() || !reason.trim()}
						>
							创建候选
						</button>
					</div>
				</form>
			)}
			{pending.length > 0 && (
				<section className="candidate-section">
					<div className="section-title">
						<div>
							<span className="eyebrow">等待确认</span>
							<h2>记忆候选</h2>
						</div>
						<span>{pending.length} 条待确认</span>
					</div>
					<div className="candidate-grid">
						{pending.map((candidate) => (
							<article className="candidate-card" key={candidate.id}>
								<header>
									<div>
										<StatusPill value={candidate.kind} />
										<span>{formatRelative(candidate.createdAt)}</span>
									</div>
									<strong>{candidate.heading ?? candidate.relativePath}</strong>
								</header>
								<p>{candidate.proposedText}</p>
								<small>{candidate.reason}</small>
								<div>
									<button
										type="button"
										className="button secondary"
										disabled={resolve.isPending}
										onClick={() => resolve.mutate({ id: candidate.id, decision: "reject" })}
									>
										拒绝
									</button>
									<button
										type="button"
										className="button primary"
										disabled={resolve.isPending}
										onClick={() => resolve.mutate({ id: candidate.id, decision: "accept" })}
									>
										接受
									</button>
								</div>
							</article>
						))}
					</div>
				</section>
			)}
			<div className="memory-library">
				<aside>
					<div className="card-heading">
						<h3>记忆文件</h3>
						<span>{files.data?.length ?? 0}</span>
					</div>
					{files.isLoading && <LoadingBlock />}
					{files.data?.map((file) => (
						<button
							type="button"
							className={selected?.id === file.id ? "selected" : ""}
							onClick={() => selectMemory(file)}
							key={file.id}
						>
							<span className={`source-icon source-${file.kind}`}>{file.kind.slice(0, 1).toUpperCase()}</span>
							<span>
								<strong>
									{file.kind === "project"
										? (projects.data?.find((project) => project.id === file.projectId)?.name ?? "项目")
										: label(file.kind)}
								</strong>
								<small>{file.kind === "user" ? "工作台根目录 / USER.md" : file.relativePath}</small>
							</span>
							<Icons.Chevron />
						</button>
					))}
				</aside>
				<section>
					{!selected && <EmptyState title="选择记忆文件" description="记忆以 Markdown 保存，便于阅读和备份。" />}
					{selectedFile.isLoading && <LoadingBlock label="正在加载记忆" />}
					{selectedFile.error && <ErrorNotice error={selectedFile.error} />}
					{save.error && <ErrorNotice error={save.error} />}
					{selected && selectedFile.data && (
						<>
							<header>
								<div>
									<span className="eyebrow">{label(selected.kind)}记忆</span>
									<strong>
										{selected.kind === "user" ? "工作台根目录 / USER.md" : selected.relativePath}
									</strong>
								</div>
								<div>
									{selected.kind === "daily" && (
										<button
											type="button"
											className="button danger"
											onClick={() => {
												if (window.confirm("删除这份每日记忆文件？")) remove.mutate(selected);
											}}
										>
											删除
										</button>
									)}
									<button
										type="button"
										className="button primary"
										disabled={draft === undefined || save.isPending}
										onClick={() => save.mutate()}
									>
										保存
									</button>
								</div>
							</header>
							<textarea
								value={draft ?? selectedFile.data.content}
								onChange={(event) => setDraft(event.target.value)}
								spellCheck={false}
							/>
						</>
					)}
				</section>
			</div>
			{resolve.error && <ErrorNotice error={resolve.error} />}
		</div>
	);
}
