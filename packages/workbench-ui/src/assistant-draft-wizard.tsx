import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, type SaveAgentProfileRequest } from "./api.ts";
import { AssistantForm } from "./assistant-editor.tsx";
import { ErrorNotice, LoadingBlock, PageHeader } from "./ui.tsx";

export function AssistantDraftWizard() {
	const [params, setParams] = useSearchParams();
	const draftId = params.get("draft");
	const [requirement, setRequirement] = useState("");
	const [model, setModel] = useState("");
	const navigate = useNavigate();
	const client = useQueryClient();
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const draft = useQuery({
		queryKey: ["assistant-draft", draftId],
		queryFn: () => api.draft(draftId!),
		enabled: Boolean(draftId),
		refetchInterval: (query) => (query.state.data?.status === "generating" ? 1000 : false),
	});
	const start = useMutation({
		mutationFn: () => {
			const [provider, ...id] = model.split("/");
			return api.startDraft(requirement, provider ? { provider, modelId: id.join("/") } : undefined);
		},
		onSuccess: ({ draft: value }) => {
			client.setQueryData(["assistant-draft", value.id], value);
			setParams({ draft: value.id });
		},
	});
	const confirm = useMutation({
		mutationFn: async (config: SaveAgentProfileRequest) => {
			if (!draft.data) throw new Error("草稿不可用");
			await api.saveDraft(draft.data, config);
			return api.createDraftProfile(draft.data.id);
		},
		onSuccess: async (profile) => {
			await client.invalidateQueries({ queryKey: ["profiles"] });
			navigate(`/assistants/${profile.createdProfileId}`);
		},
	});
	const cancel = useMutation({
		mutationFn: () => api.cancelDraft(draftId!),
		onSuccess: () => client.invalidateQueries({ queryKey: ["assistant-draft", draftId] }),
	});
	return (
		<div className="page-container editor-page">
			<PageHeader
				title="描述你的助手"
				description="模型会生成指令草稿并建议可用能力，确认后再创建助手。"
				actions={
					<Link className="button secondary" to="/assistants/new">
						手动配置
					</Link>
				}
			/>
			{!draftId && (
				<form
					className="editor-section"
					onSubmit={(event) => {
						event.preventDefault();
						start.mutate();
					}}
				>
					<label className="field">
						你希望助手帮你做什么？
						<textarea
							required
							rows={6}
							value={requirement}
							onChange={(event) => setRequirement(event.target.value)}
							placeholder="例如：我需要一个研究计算机视觉、比较论文和整理实验的助手。"
						/>
					</label>
					<label className="field">
						模型
						<select value={model} onChange={(event) => setModel(event.target.value)}>
							<option value="">工作台默认</option>
							{models.data?.models
								.filter((value) => value.available)
								.map((value) => (
									<option
										key={`${value.provider}/${value.modelId}`}
										value={`${value.provider}/${value.modelId}`}
									>
										{value.name} · {value.providerName ?? value.provider}
									</option>
								))}
						</select>
					</label>
					<button className="button primary" disabled={start.isPending || !requirement.trim()} type="submit">
						生成草稿
					</button>
				</form>
			)}
			{(start.error || draft.error || confirm.error || cancel.error) && (
				<ErrorNotice error={start.error ?? draft.error ?? confirm.error ?? cancel.error} />
			)}
			{draft.data?.status === "generating" && (
				<section className="editor-section">
					<LoadingBlock label="正在等待模型生成助手草稿" />
					<button className="button secondary" type="button" onClick={() => cancel.mutate()}>
						取消生成
					</button>
				</section>
			)}
			{draft.data && <p className="quiet-copy">{draft.data.requirement}</p>}
			{draft.data?.status === "ready" && draft.data.config && (
				<AssistantForm
					key={draft.data.id}
					initial={draft.data.config}
					onSave={(config) => confirm.mutate(config)}
					pending={confirm.isPending}
					saveLabel="创建这个助手"
				/>
			)}
			{(draft.data?.status === "failed" || draft.data?.status === "cancelled") && (
				<section className="editor-section">
					<ErrorNotice error={draft.data.errorMessage ?? "生成已取消"} />
					<button
						className="button secondary"
						type="button"
						onClick={() => {
							setRequirement(draft.data?.requirement ?? "");
							setParams({});
						}}
					>
						重试
					</button>
				</section>
			)}
			{draft.data?.status === "created" && (
				<Link className="button primary" to={`/assistants/${draft.data.createdProfileId}`}>
					打开已创建的助手
				</Link>
			)}
		</div>
	);
}
