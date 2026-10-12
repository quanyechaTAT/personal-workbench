import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "./api.ts";
import { Icons } from "./icons.tsx";
import { EmptyState, ErrorNotice, LoadingBlock, PageHeader } from "./ui.tsx";

function MarkdownPreview({ content }: { content: string }) {
	const blocks = content
		.replace(/<!-- \/?workbench-[\s\S]*?-->/gu, "")
		.replaceAll("\r\n", "\n")
		.split(/\n{2,}/u)
		.map((block) => block.trim())
		.filter(Boolean);
	return (
		<div className="markdown-preview">
			{blocks.map((block) => {
				const heading = /^(#{1,4})\s+(.+)$/u.exec(block);
				if (heading) {
					const Heading = `h${heading[1].length}` as "h1" | "h2" | "h3" | "h4";
					return <Heading key={block}>{heading[2]}</Heading>;
				}
				if (block.startsWith("```"))
					return (
						<pre key={block}>
							<code>{block.replace(/^```[^\n]*\n?|```$/gu, "")}</code>
						</pre>
					);
				const lines = block.split("\n");
				if (lines.every((line) => /^[-*]\s+/u.test(line)))
					return (
						<ul key={block}>
							{lines.map((line) => (
								<li key={line}>{line.replace(/^[-*]\s+/u, "")}</li>
							))}
						</ul>
					);
				return <p key={block}>{block}</p>;
			})}
		</div>
	);
}

export function FileBrowser({
	basePath = "",
	projectId,
	compact = false,
	initialFilePath,
	sourceProjectId,
}: {
	basePath?: string;
	projectId?: string;
	compact?: boolean;
	initialFilePath?: string;
	sourceProjectId?: string;
}) {
	const queryClient = useQueryClient();
	const initialDirectory = initialFilePath?.split("/").slice(0, -1).join("/") || basePath;
	const [currentPath, setCurrentPath] = useState(initialDirectory);
	const [selectedPath, setSelectedPath] = useState<string | undefined>(initialFilePath);
	const [mode, setMode] = useState<"preview" | "edit">("preview");
	const [draft, setDraft] = useState("");
	const listKey = sourceProjectId ? ["project-files", sourceProjectId, currentPath] : ["files", currentPath];
	const fileKey = sourceProjectId ? ["project-file", sourceProjectId, selectedPath] : ["file", selectedPath];
	const entries = useQuery({
		queryKey: listKey,
		queryFn: () => (sourceProjectId ? api.projectFiles(sourceProjectId, currentPath) : api.files(currentPath)),
	});
	const selected = useQuery({
		queryKey: fileKey,
		queryFn: () => (sourceProjectId ? api.projectFile(sourceProjectId, selectedPath!) : api.file(selectedPath!)),
		enabled: Boolean(selectedPath),
	});
	const artifacts = useQuery({ queryKey: ["artifacts", projectId], queryFn: () => api.artifacts(projectId) });
	useEffect(() => {
		if (selected.data) setDraft(selected.data.content);
	}, [selected.data]);
	const artifactPaths = useMemo(
		() => new Set(sourceProjectId ? [] : (artifacts.data?.map((artifact) => artifact.relativePath) ?? [])),
		[artifacts.data, sourceProjectId],
	);
	const save = useMutation({
		mutationFn: () =>
			sourceProjectId
				? api.writeProjectFile(sourceProjectId, selectedPath!, draft, selected.data?.contentHash)
				: api.writeFile(selectedPath!, draft, selected.data?.contentHash),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: fileKey });
			await queryClient.invalidateQueries({ queryKey: listKey });
			setMode("preview");
		},
	});
	const relativeCurrent = currentPath.slice(basePath.length).replace(/^\//u, "");
	const crumbs = relativeCurrent ? relativeCurrent.split("/") : [];
	const breadcrumbItems = crumbs.map((name, index) => ({
		name,
		path: [basePath, ...crumbs.slice(0, index + 1)].filter(Boolean).join("/"),
	}));
	const refreshing = entries.isFetching || selected.isFetching;
	const refresh = async () => {
		await Promise.all([entries.refetch(), selectedPath ? selected.refetch() : Promise.resolve()]);
	};
	return (
		<div className={`file-browser${compact ? " compact" : ""}`}>
			<section className="file-tree-panel">
				<div className="file-breadcrumbs">
					<button type="button" onClick={() => setCurrentPath(basePath)}>
						工作区
					</button>
					{breadcrumbItems.map((item) => (
						<span key={item.path}>
							<Icons.Chevron />
							<button type="button" onClick={() => setCurrentPath(item.path)}>
								{item.name}
							</button>
						</span>
					))}
					<button
						type="button"
						className="file-refresh"
						disabled={refreshing}
						onClick={() => void refresh()}
						title="刷新文件"
					>
						<Icons.Refresh />
						刷新
					</button>
				</div>
				<div className="file-list">
					{entries.isLoading && <LoadingBlock label="正在加载文件" />}
					{entries.error && <ErrorNotice error={entries.error} />}
					{entries.data?.map((entry) => (
						<button
							type="button"
							key={entry.path}
							className={`file-row${selectedPath === entry.path ? " selected" : ""}`}
							onClick={() => {
								if (entry.type === "directory") {
									setCurrentPath(entry.path);
									setSelectedPath(undefined);
								} else {
									setSelectedPath(entry.path);
									setMode("preview");
								}
							}}
						>
							<span className={`file-kind ${entry.type}`}>
								<Icons.File />
							</span>
							<span>
								<strong>{entry.name}</strong>
								<small>
									{entry.type === "directory"
										? "文件夹"
										: `${Math.max(1, Math.ceil((entry.size ?? 0) / 1024))} KB`}
								</small>
							</span>
							{artifactPaths.has(entry.path) && (
								<span className="artifact-mark" title="已注册成果">
									A
								</span>
							)}
							<Icons.Chevron />
						</button>
					))}
					{entries.data?.length === 0 && <p className="quiet-copy">此文件夹为空。</p>}
				</div>
			</section>
			<section className="file-preview-panel">
				{!selectedPath && <EmptyState title="选择文件" description="预览工作区中的 Markdown 和文本文件。" />}
				{selected.isLoading && <LoadingBlock label="正在打开文件" />}
				{selected.error && <ErrorNotice error={selected.error} />}
				{selected.data && (
					<>
						<header className="file-preview-header">
							<div>
								<strong>{selected.data.path.split("/").at(-1)}</strong>
								<span>{selected.data.path}</span>
							</div>
							<div className="segmented">
								<button
									type="button"
									className={mode === "preview" ? "active" : ""}
									onClick={() => setMode("preview")}
								>
									预览
								</button>
								<button
									type="button"
									className={mode === "edit" ? "active" : ""}
									onClick={() => setMode("edit")}
								>
									编辑
								</button>
							</div>
							{mode === "edit" && (
								<button
									type="button"
									className="button primary"
									onClick={() => save.mutate()}
									disabled={save.isPending}
								>
									保存
								</button>
							)}
						</header>
						{save.error && <ErrorNotice error={save.error} />}
						{mode === "edit" ? (
							<textarea
								className="file-editor"
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
								spellCheck={false}
							/>
						) : selected.data.path.toLowerCase().endsWith(".md") ? (
							<MarkdownPreview content={selected.data.content} />
						) : (
							<pre className="text-preview">{selected.data.content}</pre>
						)}
					</>
				)}
			</section>
		</div>
	);
}

export function FilesPage() {
	const [searchParams] = useSearchParams();
	const initialFilePath = searchParams.get("path") ?? undefined;
	return (
		<div className="page-container full-page">
			<PageHeader eyebrow="工作区" title="文件" description="浏览与编辑个人工作区中的文件。" />
			<FileBrowser initialFilePath={initialFilePath} />
		</div>
	);
}

export function ProjectFiles({
	slug,
	projectId,
	sourcePath,
}: {
	slug: string;
	projectId: string;
	sourcePath?: string;
}) {
	const [searchParams] = useSearchParams();
	const initialFilePath = searchParams.get("path") ?? undefined;
	const [source, setSource] = useState(Boolean(sourcePath));
	return (
		<>
			{sourcePath && (
				<>
					<div className="project-source-tabs">
						<button
							type="button"
							className={`button ${source ? "primary" : "secondary"}`}
							onClick={() => setSource(true)}
						>
							项目文件
						</button>
						<button
							type="button"
							className={`button ${source ? "secondary" : "primary"}`}
							onClick={() => setSource(false)}
						>
							工作台资料
						</button>
					</div>
					<p className="project-source-note">
						{source ? `正在浏览本机项目：${sourcePath}` : "项目资料、记忆和成果的工作台目录"}
					</p>
				</>
			)}
			<FileBrowser
				key={source ? `source:${initialFilePath ?? ""}` : "workspace"}
				basePath={source ? "" : `projects/${slug}`}
				initialFilePath={source ? initialFilePath : undefined}
				sourceProjectId={source ? projectId : undefined}
				projectId={projectId}
				compact
			/>
		</>
	);
}
