import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CreateSkillRequest, type WorkbenchSkill } from "./api.ts";
import { ErrorNotice, LoadingBlock } from "./ui.tsx";

function ContentEditor({
	skill,
	content,
	hash,
	onClose,
}: {
	skill: WorkbenchSkill;
	content: string;
	hash: string;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const [text, setText] = useState(content);
	const save = useMutation({
		mutationFn: () => api.saveSkillContent(skill.id, text, hash),
		onSuccess: async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: ["skills"] }),
				client.invalidateQueries({ queryKey: ["skill-content", skill.id] }),
				client.invalidateQueries({ queryKey: ["capabilities"] }),
				client.invalidateQueries({ queryKey: ["chat-capabilities"] }),
				client.invalidateQueries({ queryKey: ["context"] }),
			]);
			onClose();
		},
	});
	return (
		<form
			className="editor-section"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<h2>编辑 {skill.name}</h2>
			<label className="field">
				SKILL.md
				<textarea className="code-input" rows={20} value={text} onChange={(event) => setText(event.target.value)} />
			</label>
			{save.error && <ErrorNotice error={save.error} />}
			<div className="card-actions">
				<button className="button secondary" type="button" onClick={onClose}>
					取消
				</button>
				<button className="button primary" type="submit" disabled={save.isPending}>
					校验并保存
				</button>
			</div>
		</form>
	);
}

export function SkillEditor({ skill, onClose }: { skill: WorkbenchSkill; onClose: () => void }) {
	const file = useQuery({ queryKey: ["skill-content", skill.id], queryFn: () => api.skillContent(skill.id) });
	if (file.isLoading) return <LoadingBlock />;
	if (file.error) return <ErrorNotice error={file.error} />;
	return file.data ? (
		<ContentEditor
			key={`${skill.id}-${file.data.hash}`}
			skill={skill}
			content={file.data.content}
			hash={file.data.hash}
			onClose={onClose}
		/>
	) : null;
}

export function CreateSkillForm({ onClose }: { onClose: () => void }) {
	const client = useQueryClient();
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	const [value, setValue] = useState<CreateSkillRequest>({
		slug: "",
		name: "",
		description: "",
		instructions: "",
		scope: "global",
	});
	const save = useMutation({
		mutationFn: () => api.createSkill(value),
		onSuccess: async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: ["skills"] }),
				client.invalidateQueries({ queryKey: ["chat-capabilities"] }),
				client.invalidateQueries({ queryKey: ["capabilities"] }),
			]);
			onClose();
		},
	});
	return (
		<form
			className="editor-section"
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<h2>创建技能</h2>
			<div className="field-grid">
				<label className="field">
					目录名称
					<input
						required
						pattern="[a-z0-9]+(-[a-z0-9]+)*"
						value={value.slug}
						onChange={(event) => setValue({ ...value, slug: event.target.value })}
						placeholder="paper-review"
					/>
				</label>
				<label className="field">
					名称
					<input
						required
						value={value.name}
						onChange={(event) => setValue({ ...value, name: event.target.value })}
					/>
				</label>
			</div>
			<label className="field">
				描述
				<input
					required
					value={value.description}
					onChange={(event) => setValue({ ...value, description: event.target.value })}
				/>
			</label>
			<label className="field">
				目标范围
				<select
					value={value.projectId ?? ""}
					onChange={(event) =>
						setValue({
							...value,
							scope: event.target.value ? "project" : "global",
							projectId: event.target.value || undefined,
						})
					}
				>
					<option value="">全局技能</option>
					{projects.data?.map((project) => (
						<option value={project.id} key={project.id}>
							{project.name}
						</option>
					))}
				</select>
			</label>
			<label className="field">
				指令
				<textarea
					rows={10}
					value={value.instructions ?? ""}
					onChange={(event) => setValue({ ...value, instructions: event.target.value })}
				/>
			</label>
			{save.error && <ErrorNotice error={save.error} />}
			<div className="card-actions">
				<button className="button secondary" type="button" onClick={onClose}>
					取消
				</button>
				<button className="button primary" type="submit" disabled={save.isPending}>
					创建技能
				</button>
			</div>
		</form>
	);
}
