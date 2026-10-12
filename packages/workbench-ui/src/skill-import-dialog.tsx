import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type CreateSkillImportRequest, type SkillImport } from "./api.ts";
import { label } from "./labels.ts";
import { ErrorNotice } from "./ui.tsx";

export function SkillImportDialog({ onClose, initialPreview }: { onClose: () => void; initialPreview?: SkillImport }) {
	const client = useQueryClient();
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	const [input, setInput] = useState<CreateSkillImportRequest>({ source: "local", location: "", scope: "global" });
	const [selectedFile, setSelectedFile] = useState("");
	const pickerController = useRef<AbortController | undefined>(undefined);
	useEffect(() => () => pickerController.current?.abort(), []);
	const picker = useMutation({
		mutationFn: (controller: AbortController) => api.pickSkillFile(controller.signal),
		onSuccess: (result, controller) => {
			if (controller.signal.aborted || !result.path || !result.directory) return;
			setSelectedFile(result.path);
			const directory = result.directory;
			setInput((current) => ({ ...current, location: directory }));
		},
	});
	const [preview, setPreview] = useState<SkillImport | undefined>(initialPreview);
	const [selected, setSelected] = useState<string[]>(
		initialPreview?.candidates.map((candidate) => candidate.slug) ?? [],
	);
	const [file, setFile] = useState<{ slug: string; path: string }>();
	const filePreview = useQuery({
		queryKey: ["skill-import-file", preview?.id, file?.slug, file?.path],
		queryFn: () => api.skillImportFile(preview!.id, file!.slug, file!.path),
		enabled: Boolean(preview && file),
	});
	const inspect = useMutation({
		mutationFn: () => api.previewSkillImport(input),
		onSuccess: (value) => {
			setPreview(value);
			setSelected(
				value.candidates
					.filter((candidate) => !candidate.diagnostics.some((value) => /^(error|collision):/u.test(value)))
					.map((candidate) => candidate.slug),
			);
		},
	});
	const commit = useMutation({
		mutationFn: () => api.commitSkillImport(preview!.id, selected),
		onSuccess: async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: ["skills"] }),
				client.invalidateQueries({ queryKey: ["capabilities"] }),
				client.invalidateQueries({ queryKey: ["chat-capabilities"] }),
				client.invalidateQueries({ queryKey: ["context"] }),
			]);
			onClose();
		},
	});
	const discard = useMutation({
		mutationFn: async () => {
			if (preview) await api.discardSkillImport(preview.id);
		},
		onSuccess: onClose,
	});
	return (
		<section className="editor-section">
			<h2>{initialPreview ? "更新技能" : "导入技能"}</h2>
			<p>导入完整技能目录，包含参考资料、脚本和资源文件；导入时不会执行脚本。</p>
			{!preview && (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (!picker.isPending && input.location.trim()) inspect.mutate();
					}}
				>
					<div className="field-grid">
						<label className="field">
							来源
							<select
								value={input.source}
								disabled={picker.isPending || inspect.isPending}
								onChange={(event) => {
									setSelectedFile("");
									setInput({ ...input, source: event.target.value === "git" ? "git" : "local", location: "" });
								}}
							>
								<option value="local">本机技能文件</option>
								<option value="git">公共 Git 仓库</option>
							</select>
						</label>
						<label className="field">
							目标范围
							<select
								value={input.projectId ?? ""}
								onChange={(event) =>
									setInput({
										...input,
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
					</div>
					<label className="field">
						{input.source === "git" ? "HTTPS 仓库地址" : "技能文件"}
						<input
							required
							aria-label={input.source === "git" ? "HTTPS 仓库地址" : "技能文件"}
							readOnly={input.source === "local"}
							value={input.source === "local" ? selectedFile : input.location}
							onChange={(event) => setInput({ ...input, location: event.target.value })}
						/>
					</label>
					{input.source === "local" && (
						<div className="card-actions">
							<button
								type="button"
								className="button secondary"
								disabled={picker.isPending || inspect.isPending}
								onClick={() => {
									if (picker.isPending) return;
									const controller = new AbortController();
									pickerController.current = controller;
									picker.mutate(controller);
								}}
							>
								{picker.isPending ? "正在选择…" : "选择文件…"}
							</button>
							<small>选择 SKILL.md，将一并导入同目录下的脚本和资源文件。</small>
						</div>
					)}
					{input.source === "git" && (
						<div className="field-grid">
							<label className="field">
								分支、标签或提交（可选）
								<input
									value={input.ref ?? ""}
									onChange={(event) => setInput({ ...input, ref: event.target.value || undefined })}
									placeholder="远端默认分支"
								/>
							</label>
							<label className="field">
								子目录（可选）
								<input
									value={input.subdirectory ?? ""}
									onChange={(event) => setInput({ ...input, subdirectory: event.target.value || undefined })}
								/>
							</label>
						</div>
					)}
					<button
						className="button primary"
						type="submit"
						disabled={inspect.isPending || picker.isPending || !input.location.trim()}
					>
						{inspect.isPending ? "正在检查…" : "预览导入"}
					</button>
				</form>
			)}
			{preview && (
				<>
					<p>
						{preview.sourceLocation}
						{preview.sourceCommit && (
							<>
								{" "}
								· commit <code>{preview.sourceCommit}</code>
							</>
						)}
					</p>
					{preview.candidates.map((candidate) => (
						<div className="import-candidate" key={candidate.slug}>
							<label className="inline-check">
								<input
									type="checkbox"
									checked={selected.includes(candidate.slug)}
									disabled={candidate.diagnostics.some((value) => /^(error|collision):/u.test(value))}
									onChange={(event) =>
										setSelected(
											event.target.checked
												? [...selected, candidate.slug]
												: selected.filter((slug) => slug !== candidate.slug),
										)
									}
								/>
								{candidate.name}
							</label>
							<p>{candidate.description}</p>
							{candidate.diagnostics.map((diagnostic) => (
								<ErrorNotice key={diagnostic} error={diagnostic} />
							))}
							<details>
								<summary>{candidate.files.length} 个文件</summary>
								{candidate.files.map((path) => (
									<div key={path}>
										<button
											type="button"
											className="button secondary"
											onClick={() => setFile({ slug: candidate.slug, path })}
										>
											{path}
										</button>
									</div>
								))}
							</details>
							{candidate.update && (
								<div>
									<h3>变更</h3>
									{candidate.update.changes.length === 0 ? (
										<p>来源没有变化。</p>
									) : (
										candidate.update.changes.map((change) => (
											<div key={change.path}>
												<button
													type="button"
													className="button secondary"
													onClick={() => setFile({ slug: candidate.slug, path: change.path })}
												>
													{label(change.kind)}： {change.path}
												</button>
											</div>
										))
									)}
								</div>
							)}
						</div>
					))}
					<button
						className="button primary"
						type="button"
						disabled={commit.isPending || selected.length === 0}
						onClick={() => commit.mutate()}
					>
						{initialPreview ? "应用更新" : `导入 ${selected.length} 个技能`}
					</button>
				</>
			)}
			{file && (
				<section>
					<h3>{file.path}</h3>
					{filePreview.error && <ErrorNotice error={filePreview.error} />}
					{filePreview.data && (
						<div className="field-grid">
							{filePreview.data.before !== undefined && (
								<div>
									<h4>修改前</h4>
									<pre>{filePreview.data.before}</pre>
								</div>
							)}
							<div>
								<h4>修改后</h4>
								<pre>{filePreview.data.after ?? "[已删除]"}</pre>
							</div>
						</div>
					)}
				</section>
			)}
			{(inspect.error || commit.error || discard.error) && (
				<ErrorNotice error={inspect.error ?? commit.error ?? discard.error} />
			)}
			{picker.error && !pickerController.current?.signal.aborted && <ErrorNotice error={picker.error} />}
			<button
				className="button secondary"
				type="button"
				disabled={inspect.isPending || commit.isPending}
				onClick={() => {
					pickerController.current?.abort();
					discard.mutate();
				}}
			>
				取消
			</button>
		</section>
	);
}
