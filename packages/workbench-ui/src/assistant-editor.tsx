import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { type AgentProfile, api, type SaveAgentProfileRequest } from "./api.ts";
import { CapabilityPicker } from "./capability-picker.tsx";
import { ErrorNotice, LoadingBlock, PageHeader } from "./ui.tsx";

export const EMPTY_ASSISTANT: SaveAgentProfileRequest = {
	name: "",
	description: "",
	systemPrompt: "",
	tools: ["read"],
	skillIds: [],
	mcpBindings: [],
};

export function AssistantForm({
	initial,
	onSave,
	pending,
	error,
	saveLabel = "保存助手",
}: {
	initial: SaveAgentProfileRequest;
	onSave: (value: SaveAgentProfileRequest) => void;
	pending: boolean;
	error?: unknown;
	saveLabel?: string;
}) {
	const [value, setValue] = useState<SaveAgentProfileRequest>(initial);
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const submit = (event: FormEvent) => {
		event.preventDefault();
		onSave(value);
	};
	return (
		<form className="assistant-form" onSubmit={submit}>
			<section className="editor-section">
				<h2>身份与模型</h2>
				<div className="field-grid">
					<label className="field">
						名称
						<input
							required
							maxLength={120}
							value={value.name}
							onChange={(event) => setValue({ ...value, name: event.target.value })}
						/>
					</label>
					<label className="field">
						默认模型
						<select
							value={value.defaultModel ? `${value.defaultModel.provider}/${value.defaultModel.modelId}` : ""}
							onChange={(event) => {
								const [provider, ...id] = event.target.value.split("/");
								setValue({
									...value,
									defaultModel: provider ? { provider, modelId: id.join("/") } : undefined,
								});
							}}
						>
							<option value="">工作台默认</option>
							{models.data?.models
								.filter((model) => model.available)
								.map((model) => (
									<option
										key={`${model.provider}/${model.modelId}`}
										value={`${model.provider}/${model.modelId}`}
									>
										{model.name} · {model.providerName ?? model.provider}
									</option>
								))}
						</select>
					</label>
				</div>
				<label className="field">
					用途
					<textarea
						rows={2}
						value={value.description ?? ""}
						onChange={(event) => setValue({ ...value, description: event.target.value })}
					/>
				</label>
			</section>
			<section className="editor-section">
				<h2>指令</h2>
				<p>描述助手的角色、工作流程、输出要求和限制。</p>
				<label className="field">
					系统指令
					<textarea
						className="code-input"
						required
						rows={10}
						value={value.systemPrompt}
						onChange={(event) => setValue({ ...value, systemPrompt: event.target.value })}
					/>
				</label>
			</section>
			<CapabilityPicker value={value} onChange={setValue} />
			{error != null && <ErrorNotice error={error} />}
			<div className="editor-actions">
				<span>修改在下一轮运行生效，已有对话记录会保留。</span>
				<button className="button primary" type="submit" disabled={pending}>
					{pending ? "正在保存…" : saveLabel}
				</button>
			</div>
		</form>
	);
}

function profileInput(profile: AgentProfile): SaveAgentProfileRequest {
	return {
		name: profile.name,
		description: profile.description,
		systemPrompt: profile.systemPrompt,
		defaultModel: profile.defaultModel,
		tools: profile.tools,
		skillIds: profile.skillIds,
		mcpBindings: profile.mcpBindings,
	};
}

export function AssistantEditor() {
	const { profileId } = useParams();
	const navigate = useNavigate();
	const client = useQueryClient();
	const profile = useQuery({
		queryKey: ["profile", profileId],
		queryFn: () => api.profile(profileId!),
		enabled: Boolean(profileId),
	});
	const save = useMutation({
		mutationFn: (input: SaveAgentProfileRequest) =>
			profile.data ? api.updateProfile(profile.data.id, input, profile.data.version) : api.createProfile(input),
		onSuccess: async (saved) => {
			await Promise.all([
				client.invalidateQueries({ queryKey: ["profiles"] }),
				client.invalidateQueries({ queryKey: ["profile", saved.id] }),
				client.invalidateQueries({ queryKey: ["context"] }),
			]);
			navigate(`/assistants/${saved.id}`);
		},
	});
	if (profile.isLoading) return <LoadingBlock label="正在加载助手" />;
	if (profile.error)
		return (
			<div className="page-container">
				<ErrorNotice error={profile.error} />
			</div>
		);
	return (
		<div className="page-container editor-page">
			<PageHeader
				eyebrow={profile.data ? `版本 ${profile.data.version}` : "个人助手"}
				title={profile.data?.name ?? "创建助手"}
				description="配置指令、模型、技能和工具。"
				actions={
					<>
						<Link className="button secondary" to="/assistants">
							全部助手
						</Link>
						{profile.data && (
							<Link className="button primary" to={`/chat?assistant=${profile.data.id}`}>
								在对话中试用
							</Link>
						)}
					</>
				}
			/>
			{profile.data?.bindingDiagnostics?.map((message) => (
				<ErrorNotice key={message} error={message} />
			))}
			<AssistantForm
				key={`${profile.data?.id ?? "new"}-${profile.data?.version ?? 0}`}
				initial={profile.data ? profileInput(profile.data) : EMPTY_ASSISTANT}
				onSave={(input) => save.mutate(input)}
				pending={save.isPending}
				error={save.error}
			/>
		</div>
	);
}
