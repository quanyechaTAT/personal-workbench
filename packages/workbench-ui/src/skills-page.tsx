import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type SkillImport, type WorkbenchSkill } from "./api.ts";
import { Icons } from "./icons.tsx";
import { label } from "./labels.ts";
import { CreateSkillForm, SkillEditor } from "./skill-editor.tsx";
import { SkillImportDialog } from "./skill-import-dialog.tsx";
import { EmptyState, ErrorNotice, LoadingBlock, PageHeader, StatusPill } from "./ui.tsx";

export function SkillsPage() {
	const queryClient = useQueryClient();
	const skills = useQuery({ queryKey: ["skills"], queryFn: () => api.skills() });
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	const [scope, setScope] = useState<"all" | "global" | "project">("all");
	const [editor, setEditor] = useState<WorkbenchSkill | "new" | "import">();
	const [update, setUpdate] = useState<SkillImport>();
	const previewUpdate = useMutation({
		mutationFn: api.previewSkillUpdate,
		onSuccess: (value) => {
			setEditor(undefined);
			setUpdate(value);
		},
	});
	const toggle = useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.toggleSkill(id, enabled),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["skills"] }),
				queryClient.invalidateQueries({ queryKey: ["chat-capabilities"] }),
				queryClient.invalidateQueries({ queryKey: ["capabilities"] }),
				queryClient.invalidateQueries({ queryKey: ["context"] }),
			]);
		},
	});
	const visible = skills.data?.filter((skill) => scope === "all" || skill.scope === scope) ?? [];
	return (
		<div className="page-container">
			<PageHeader
				eyebrow="原生 Skill 格式"
				title="技能"
				description="为助手选择可复用的工作方法与资源，使用 Pi 原生 SKILL.md 格式。"
				actions={
					<>
						<button className="button secondary" type="button" onClick={() => setEditor("import")}>
							导入技能
						</button>
						<button className="button primary" type="button" onClick={() => setEditor("new")}>
							创建技能
						</button>
						<div className="segmented page-segmented">
							{(["all", "global", "project"] as const).map((value) => (
								<button
									type="button"
									key={label(value)}
									className={scope === value ? "active" : ""}
									onClick={() => setScope(value)}
								>
									{label(value)}
								</button>
							))}
						</div>
					</>
				}
			/>
			{editor === "import" ? (
				<SkillImportDialog onClose={() => setEditor(undefined)} />
			) : editor === "new" ? (
				<CreateSkillForm onClose={() => setEditor(undefined)} />
			) : (
				editor && <SkillEditor skill={editor} onClose={() => setEditor(undefined)} />
			)}
			{update && <SkillImportDialog key={update.id} initialPreview={update} onClose={() => setUpdate(undefined)} />}
			{previewUpdate.error && <ErrorNotice error={previewUpdate.error} />}
			{skills.isLoading && <LoadingBlock label="正在发现技能" />}
			{skills.error && <ErrorNotice error={skills.error} />}
			<div className="skill-grid">
				{visible.map((skill) => (
					<article className="skill-card" key={skill.id}>
						<header>
							<span className="skill-mark">
								<Icons.Skill />
							</span>
							<label className="switch">
								<input
									aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.isBuiltin ? label(skill.slug) : skill.name}`}
									type="checkbox"
									checked={skill.enabled}
									onChange={(event) => toggle.mutate({ id: skill.id, enabled: event.target.checked })}
									disabled={toggle.isPending}
								/>
								<span />
							</label>
						</header>
						<div>
							<h2>{skill.isBuiltin ? label(skill.slug) : skill.name}</h2>
							<p>{skill.description || "Pi 助手技能"}</p>
						</div>
						<div className="skill-meta">
							<StatusPill value={label(skill.scope)} />
							{skill.isBuiltin && <span>内置</span>}
							{skill.projectId && (
								<span>{projects.data?.find((project) => project.id === skill.projectId)?.name}</span>
							)}
						</div>
						<footer>
							<code>{skill.path}</code>
							{skill.sourceUrl && (
								<button
									type="button"
									className="button secondary"
									disabled={previewUpdate.isPending}
									onClick={() => previewUpdate.mutate(skill.id)}
								>
									预览来源更新
								</button>
							)}
							<button type="button" className="button secondary" onClick={() => setEditor(skill)}>
								编辑技能
							</button>
							<Link to={`/files?path=${encodeURIComponent(skill.path)}`}>
								打开文件 <Icons.Chevron />
							</Link>
						</footer>
						{skill.diagnostics?.map((diagnostic) => (
							<ErrorNotice key={diagnostic} error={diagnostic} />
						))}
					</article>
				))}
			</div>
			{!skills.isLoading && visible.length === 0 && (
				<EmptyState
					title="当前范围内没有技能"
					description="导入技能，或在全局、项目 skills 目录下创建 SKILL.md 后刷新。"
				/>
			)}
		</div>
	);
}
