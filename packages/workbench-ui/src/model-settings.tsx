import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import {
	api,
	type ConfiguredModel,
	type ModelProviderDto,
	type ModelSettingsDto,
	type SaveModelProviderInput,
} from "./api.ts";
import { ModelDiscovery } from "./model-discovery.tsx";
import { PiLogin } from "./pi-login.tsx";
import { ThinkingLevelEditor } from "./thinking-level-editor.tsx";
import { ErrorNotice, LoadingBlock } from "./ui.tsx";
import "./model-settings.css";

const formats = [
	{ value: "anthropic-messages", label: "Anthropic Messages (/v1/messages)" },
	{ value: "openai-completions", label: "Chat Completions (/chat/completions)" },
	{ value: "openai-responses", label: "Responses (/responses)" },
];

function ModelEditor({
	model,
	defaultThinkingPreset,
	onSave,
	onClose,
	native = false,
}: {
	model?: ConfiguredModel;
	defaultThinkingPreset: ConfiguredModel["thinkingPreset"];
	onSave: (model: ConfiguredModel) => void;
	onClose: () => void;
	native?: boolean;
}) {
	const [draft, setDraft] = useState<ConfiguredModel>(
		model ?? {
			modelId: "",
			name: "",
			enabled: true,
			reasoning: true,
			vision: false,
			contextWindow: 131072,
			maxTokens: 8192,
			thinkingPreset: defaultThinkingPreset,
		},
	);
	const [error, setError] = useState<string>();
	const [contextWindow, setContextWindow] = useState(String(draft.contextWindow));
	const [maxTokens, setMaxTokens] = useState(String(draft.maxTokens));
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const context = Number(contextWindow);
		const output = Number(maxTokens);
		if (
			!draft.modelId.trim() ||
			!draft.name.trim() ||
			!contextWindow ||
			!maxTokens ||
			!Number.isInteger(context) ||
			context < 1024 ||
			context > 10000000 ||
			!Number.isInteger(output) ||
			output < 128 ||
			output > 1000000 ||
			output > context
		) {
			setError("请填写模型 ID、名称，并确保输出上限不超过上下文窗口。");
			return;
		}
		onSave({ ...draft, contextWindow: context, maxTokens: output });
	};
	return (
		<form className="model-editor" onSubmit={submit} aria-label="编辑模型">
			<h3>{model ? "编辑模型" : "添加模型"}</h3>
			{error && <ErrorNotice error={error} />}
			<div className="model-form-grid">
				<label>
					模型 ID
					<input
						required
						value={draft.modelId}
						maxLength={200}
						placeholder="deepseek-flash"
						disabled={Boolean(model)}
						onChange={(event) =>
							setDraft({
								...draft,
								modelId: event.target.value,
								name: !draft.name || draft.name === draft.modelId ? event.target.value : draft.name,
							})
						}
					/>
				</label>
				<label>
					显示名称
					<input
						required
						value={draft.name}
						maxLength={200}
						disabled={native}
						onChange={(event) => setDraft({ ...draft, name: event.target.value })}
					/>
				</label>
				<label>
					上下文窗口
					<input
						type="number"
						required
						min={1024}
						max={10000000}
						value={contextWindow}
						disabled={native}
						onChange={(event) => setContextWindow(event.target.value)}
					/>
				</label>
				<label>
					最大输出 Token
					<input
						type="number"
						required
						min={128}
						max={1000000}
						value={maxTokens}
						disabled={native}
						onChange={(event) => setMaxTokens(event.target.value)}
					/>
				</label>
			</div>
			<div className="model-option-row">
				<label>
					<input
						type="checkbox"
						checked={draft.reasoning}
						disabled={native}
						onChange={(event) => setDraft({ ...draft, reasoning: event.target.checked })}
					/>
					支持思考
				</label>
				<label>
					<input
						type="checkbox"
						checked={draft.vision}
						disabled={native}
						onChange={(event) => setDraft({ ...draft, vision: event.target.checked })}
					/>
					支持图片
				</label>
			</div>
			<label>
				思考参数
				<select
					aria-label="思考参数"
					value={draft.thinkingPreset}
					disabled={native}
					onChange={(event) =>
						setDraft({
							...draft,
							thinkingPreset: event.target.value === "deepseek" ? "deepseek" : "auto",
							thinkingLevelMap: undefined,
						})
					}
				>
					<option value="auto">自动 / 标准 API 参数</option>
					<option value="deepseek">DeepSeek · none / low / high / max</option>
				</select>
			</label>
			<ThinkingLevelEditor model={draft} onChange={(thinkingLevelMap) => setDraft({ ...draft, thinkingLevelMap })} />
			<div className="model-actions">
				<button type="button" className="button secondary" onClick={onClose}>
					取消
				</button>
				<button className="button primary" type="submit">
					加入列表
				</button>
			</div>
		</form>
	);
}

function ProviderEditor({
	provider,
	version,
	candidates,
	pending,
	onSave,
	onDelete,
}: {
	provider?: ModelProviderDto;
	version: number;
	candidates: ConfiguredModel[];
	pending: boolean;
	onSave: (input: SaveModelProviderInput) => void;
	onDelete?: () => void;
}) {
	const [name, setName] = useState(provider?.name ?? "");
	const keyId = useId();
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "https://api.deepseek.com");
	const [apiFormat, setApiFormat] = useState(provider?.api ?? "openai-completions");
	const [enabled, setEnabled] = useState(provider?.enabled ?? true);
	const [key, setKey] = useState("");
	const [models, setModels] = useState<ConfiguredModel[]>(provider?.models ?? []);
	const [editing, setEditing] = useState<ConfiguredModel | "new">();
	const [addingNative, setAddingNative] = useState(false);
	const [nativeId, setNativeId] = useState("");
	const [changed, setChanged] = useState(false);
	const native = provider?.source === "pi";
	const editableModels = !native || provider.supportsCustomModels === true;
	const available = candidates.filter((model) => !models.some((current) => current.modelId === model.modelId));
	const touch = () => setChanged(true);
	const save = () =>
		onSave({ name, baseUrl, api: apiFormat, enabled, models, apiKey: key || undefined, expectedVersion: version });
	return (
		<section className="provider-detail" aria-label="供应商配置">
			<div className="model-section-title">
				<h3>{provider?.name ?? "新供应商"}</h3>
				<label className="switch" aria-label="启用供应商">
					<input
						type="checkbox"
						checked={enabled}
						disabled={pending}
						onChange={(event) => {
							setEnabled(event.target.checked);
							touch();
						}}
					/>
					<span />
				</label>
			</div>
			{native && (
				<p className="quiet-copy">
					沿用 Pi 的登录凭证和连接信息。如需其他 Base URL 或 API 格式，可添加自定义供应商。
				</p>
			)}
			<label>
				供应商名称
				<input
					maxLength={100}
					value={name}
					disabled={pending}
					placeholder="例如 DeepSeek"
					onChange={(event) => {
						setName(event.target.value);
						touch();
					}}
				/>
			</label>
			<label>
				Base URL
				<input
					value={baseUrl}
					disabled={native || pending}
					onChange={(event) => {
						setBaseUrl(event.target.value);
						touch();
					}}
				/>
			</label>
			<label>
				API 格式
				<select
					aria-label="API 格式"
					value={apiFormat}
					disabled={native || pending}
					onChange={(event) => {
						setApiFormat(event.target.value);
						touch();
					}}
				>
					{!formats.some((format) => format.value === apiFormat) && <option value={apiFormat}>{apiFormat}</option>}
					{formats.map((format) => (
						<option key={format.value} value={format.value}>
							{format.label}
						</option>
					))}
				</select>
			</label>
			<label htmlFor={keyId}>
				API Key
				{native ? (
					<input
						id={keyId}
						type="password"
						value=""
						disabled
						placeholder={provider?.configured ? "已通过 Pi 配置" : "请使用上方 Pi 登录配置凭证"}
					/>
				) : (
					<input
						id={keyId}
						type="password"
						autoComplete="new-password"
						value={key}
						placeholder={provider?.configured ? "已配置，留空保留原凭证" : "填写 API Key"}
						onChange={(event) => {
							setKey(event.target.value);
							touch();
						}}
					/>
				)}
			</label>
			<div className="model-section-title">
				<h4>模型列表</h4>
				<button
					type="button"
					className="button secondary"
					disabled={pending}
					onClick={() => (editableModels ? setEditing("new") : setAddingNative(true))}
				>
					添加模型
				</button>
			</div>
			{native && editableModels && (
				<p className="quiet-copy">
					可手动填写模型 ID，或通过“获取模型列表”从 Pi 目录添加。请核对模型能力与 Token
					上限；实际可用性由供应商账户权限决定。
				</p>
			)}
			{native && !editableModels && (
				<p className="quiet-copy">
					当前供应商没有可复用的默认连接。请从 Pi 目录选择模型，或刷新 Pi 登录后重试；已有模型配置会保留。
				</p>
			)}
			{addingNative && (
				<div className="native-model-picker">
					<label>
						选择模型
						<select value={nativeId} onChange={(event) => setNativeId(event.target.value)}>
							<option value="">选择 Pi 目录中的模型</option>
							{available.map((model) => (
								<option value={model.modelId} key={model.modelId}>
									{model.name} · {model.modelId}
								</option>
							))}
						</select>
					</label>
					<div className="model-actions">
						<button type="button" className="button secondary" onClick={() => setAddingNative(false)}>
							取消
						</button>
						<button
							type="button"
							className="button primary"
							disabled={!nativeId}
							onClick={() => {
								const model = available.find((entry) => entry.modelId === nativeId);
								if (model) {
									setModels([...models, model]);
									touch();
								}
								setNativeId("");
								setAddingNative(false);
							}}
						>
							加入列表
						</button>
					</div>
				</div>
			)}
			<ModelDiscovery
				provider={provider}
				baseUrl={baseUrl}
				apiFormat={apiFormat}
				apiKey={key}
				models={models}
				nativeCandidates={candidates}
				pending={pending}
				onAdd={(entries) => {
					setModels([...models, ...entries]);
					touch();
				}}
			/>
			{editing && (
				<ModelEditor
					native={!editableModels}
					model={editing === "new" ? undefined : editing}
					defaultThinkingPreset={
						URL.canParse(baseUrl) && new URL(baseUrl).origin === "https://api.deepseek.com" ? "deepseek" : "auto"
					}
					onClose={() => setEditing(undefined)}
					onSave={(model) => {
						setModels([...models.filter((current) => current.modelId !== model.modelId), model]);
						setEditing(undefined);
						touch();
					}}
				/>
			)}
			<div className="configured-model-list">
				{models.map((model) => (
					<div className="configured-model-row" key={model.modelId}>
						<div>
							<strong>{model.name}</strong>
							<small>{model.modelId}</small>
							<div className="model-badges">
								<span>{Math.round(model.contextWindow / 1024)}K</span>
								{model.reasoning && <span>思考</span>}
								{model.vision && <span>视觉</span>}
							</div>
						</div>
						<div className="model-row-actions">
							{
								<button
									type="button"
									className="button secondary"
									disabled={pending}
									onClick={() => setEditing(model)}
								>
									{editableModels ? "编辑" : "思考档位"}
								</button>
							}
							<button
								type="button"
								className="button secondary"
								disabled={pending}
								aria-label={`移除模型 ${model.name}`}
								onClick={() => {
									setModels(models.filter((item) => item.modelId !== model.modelId));
									touch();
								}}
							>
								移除
							</button>
							<label className="switch" aria-label={`启用模型 ${model.name}`}>
								<input
									type="checkbox"
									checked={model.enabled}
									disabled={pending}
									onChange={(event) => {
										setModels(
											models.map((item) =>
												item.modelId === model.modelId ? { ...item, enabled: event.target.checked } : item,
											),
										);
										touch();
									}}
								/>
								<span />
							</label>
						</div>
					</div>
				))}
				{models.length === 0 && (
					<p className="settings-empty">还未添加模型。添加并保存后，模型才会出现在聊天列表中。</p>
				)}
			</div>
			<div className="model-actions">
				{onDelete && (
					<button type="button" className="button secondary" disabled={pending} onClick={onDelete}>
						删除供应商
					</button>
				)}
				{changed && <small>尚未保存</small>}
				<button
					type="button"
					className="button primary"
					disabled={pending || !name.trim() || (!changed && Boolean(provider))}
					onClick={save}
				>
					{pending ? "正在保存…" : "保存供应商"}
				</button>
			</div>
		</section>
	);
}

export function ModelSettings() {
	const client = useQueryClient();
	const catalog = useQuery({ queryKey: ["model-settings"], queryFn: api.modelSettings });
	const candidates = useQuery({ queryKey: ["model-candidates"], queryFn: api.modelCandidates });
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const [selectedId, setSelectedId] = useState<string>();
	const [adding, setAdding] = useState(false);
	const refresh = async (result: ModelSettingsDto) => {
		client.setQueryData(["model-settings"], result);
		await Promise.all(
			["models", "model-candidates", "sessions", "context", "settings"].map((key) =>
				client.invalidateQueries({ queryKey: [key] }),
			),
		);
	};
	const save = useMutation({
		mutationFn: (input: SaveModelProviderInput) =>
			api.saveModelProvider(adding ? undefined : (selectedId ?? catalog.data?.providers[0]?.id), input),
		onSuccess: async (result) => {
			setAdding(false);
			setSelectedId(result.providers.at(-1)?.id);
			await refresh(result);
		},
	});
	const remove = useMutation({
		mutationFn: (id: string) => api.removeModelProvider(id, catalog.data?.version ?? 0),
		onSuccess: async (result) => {
			setSelectedId(result.providers[0]?.id);
			await refresh(result);
		},
	});
	const refreshPi = useMutation({
		mutationFn: async () => {
			await client.fetchQuery({ queryKey: ["model-candidates"], queryFn: api.modelCandidates, staleTime: 0 });
			client.setQueryData(["model-settings"], await api.modelSettings());
			await client.invalidateQueries({ queryKey: ["models"] });
		},
	});
	const authenticated = async (providerId: string) => {
		const latest = await api.modelSettings();
		const result = latest.providers.some((entry) => entry.id === providerId)
			? latest
			: await api.importModelProvider(providerId, latest.version);
		setSelectedId(providerId);
		setAdding(false);
		await refresh(result);
	};
	const defaultModel = useMutation({
		mutationFn: (value: string) => {
			const slash = value.indexOf("/");
			return api.setSetting(
				"models.default",
				slash > 0 ? { provider: value.slice(0, slash), modelId: value.slice(slash + 1) } : null,
				settings.data?.find((setting) => setting.key === "models.default")?.version,
			);
		},
		onSuccess: () => void client.invalidateQueries({ queryKey: ["settings"] }),
	});
	const currentDefault = settings.data?.find((setting) => setting.key === "models.default")?.value;
	const defaultValue =
		typeof currentDefault === "object" &&
		currentDefault !== null &&
		"provider" in currentDefault &&
		"modelId" in currentDefault
			? `${currentDefault.provider}/${currentDefault.modelId}`
			: "";
	const provider = catalog.data?.providers.find((entry) => entry.id === selectedId) ?? catalog.data?.providers[0];
	const busy = save.isPending || remove.isPending || refreshPi.isPending;
	if (catalog.isLoading) return <LoadingBlock label="正在加载模型设置" />;
	return (
		<div className="model-settings">
			<div className="settings-section-heading">
				<h2>模型设置</h2>
				<p>管理模型供应商；只有已添加、启用且配置凭证的模型可用于聊天。</p>
			</div>
			{(catalog.error ||
				candidates.error ||
				save.error ||
				remove.error ||
				refreshPi.error ||
				defaultModel.error) && (
				<ErrorNotice
					error={
						catalog.error ??
						candidates.error ??
						save.error ??
						remove.error ??
						refreshPi.error ??
						defaultModel.error
					}
				/>
			)}
			<div className="model-actions">
				<button
					type="button"
					className="button secondary"
					disabled={busy}
					onClick={() => {
						save.reset();
						setAdding(true);
					}}
				>
					添加供应商
				</button>
				<button type="button" className="button secondary" disabled={busy} onClick={() => refreshPi.mutate()}>
					{refreshPi.isPending ? "正在刷新…" : "刷新 Pi 登录"}
				</button>
			</div>
			<div className="provider-layout">
				<nav aria-label="模型供应商" className="provider-list">
					{catalog.data?.providers.map((entry) => (
						<button
							type="button"
							key={entry.id}
							disabled={busy}
							className={!adding && provider?.id === entry.id ? "active" : ""}
							onClick={() => {
								setSelectedId(entry.id);
								setAdding(false);
								save.reset();
							}}
						>
							<span>{entry.name}</span>
							<span className={`status-dot ${entry.enabled && entry.configured ? "online" : ""}`} />
						</button>
					))}
					{catalog.data?.providers.length === 0 && <p>尚未添加供应商</p>}
				</nav>
				<div>
					{adding ? (
						<>
							<PiLogin candidates={candidates.data ?? []} pending={busy} onAuthenticated={authenticated} />
							<ProviderEditor
								key="new"
								version={catalog.data?.version ?? 0}
								candidates={[]}
								pending={busy}
								onSave={(input) => save.mutate(input)}
							/>
						</>
					) : provider ? (
						<>
							{provider.source === "pi" && (
								<PiLogin
									key={provider.id}
									fixedProviderId={provider.id}
									candidates={candidates.data ?? []}
									pending={busy}
									onAuthenticated={authenticated}
								/>
							)}
							<ProviderEditor
								key={`${provider.id}-${catalog.data?.version}`}
								provider={provider}
								version={catalog.data?.version ?? 0}
								candidates={candidates.data?.find((entry) => entry.id === provider.id)?.models ?? []}
								pending={busy}
								onSave={(input) => save.mutate(input)}
								onDelete={() => {
									if (
										window.confirm(
											`删除供应商“${provider.name}”？相关模型将无法用于新的消息，对话历史仍可查看。`,
										)
									)
										remove.mutate(provider.id);
								}}
							/>
						</>
					) : (
						<p className="settings-empty">点击“添加供应商”开始配置模型。</p>
					)}
				</div>
			</div>
			<div className="setting-row">
				<div>
					<strong>默认模型</strong>
					<small>用于未指定模型的新会话</small>
				</div>
				<select
					aria-label="默认模型"
					value={defaultValue}
					disabled={defaultModel.isPending}
					onChange={(event) => defaultModel.mutate(event.target.value)}
				>
					<option value="">首个可用模型</option>
					{models.data?.models
						.filter((model) => model.available)
						.map((model) => (
							<option value={`${model.provider}/${model.modelId}`} key={`${model.provider}/${model.modelId}`}>
								{model.name} · {model.providerName ?? model.provider}
							</option>
						))}
				</select>
			</div>
		</div>
	);
}
