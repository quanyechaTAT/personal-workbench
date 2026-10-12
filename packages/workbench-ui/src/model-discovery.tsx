import type { DiscoveredModelCatalog } from "@earendil-works/workbench-runtime";
import { useEffect, useRef, useState } from "react";
import { api, type ConfiguredModel, type ModelProviderDto } from "./api.ts";
import { ErrorNotice } from "./ui.tsx";

export function ModelDiscovery({
	provider,
	baseUrl,
	apiFormat,
	apiKey,
	models,
	nativeCandidates,
	pending,
	onAdd,
}: {
	provider?: ModelProviderDto;
	baseUrl: string;
	apiFormat: string;
	apiKey: string;
	models: ConfiguredModel[];
	nativeCandidates: ConfiguredModel[];
	pending: boolean;
	onAdd(models: ConfiguredModel[]): void;
}) {
	const [result, setResult] = useState<DiscoveredModelCatalog>();
	const [selected, setSelected] = useState<string[]>([]);
	const [modelsUrl, setModelsUrl] = useState("");
	const [fetching, setFetching] = useState(false);
	const [error, setError] = useState<unknown>();
	const generation = useRef(0);
	const requestOptions = useRef({
		providerId: provider?.id,
		baseUrl,
		api: apiFormat,
		apiKey: apiKey || undefined,
		modelsUrl: modelsUrl || undefined,
	});
	useEffect(() => {
		requestOptions.current = {
			providerId: provider?.id,
			baseUrl,
			api: apiFormat,
			apiKey: apiKey || undefined,
			modelsUrl: modelsUrl || undefined,
		};
		generation.current += 1;
		setResult(undefined);
		setSelected([]);
		setError(undefined);
		setFetching(false);
		return () => {
			generation.current += 1;
		};
	}, [baseUrl, apiFormat, apiKey, modelsUrl, provider?.id]);
	const allowed = (id: string) =>
		!models.some((model) => model.modelId === id) &&
		(provider?.source !== "pi" || nativeCandidates.some((model) => model.modelId === id));
	const fetchModels = async () => {
		const revision = ++generation.current;
		setFetching(true);
		setResult(undefined);
		setSelected([]);
		setError(undefined);
		try {
			const value = await api.discoverModels(requestOptions.current);
			if (generation.current === revision) setResult(value);
		} catch (error) {
			if (generation.current === revision) setError(error);
		} finally {
			if (generation.current === revision) setFetching(false);
		}
	};
	const addSelected = () => {
		const entries =
			result?.models.filter((model) => selected.includes(model.modelId) && allowed(model.modelId)) ?? [];
		if (entries.length + models.length > 200) {
			setError("一个供应商最多添加 200 个模型，请减少选择");
			return;
		}
		onAdd(
			entries.map((model) => {
				const native = nativeCandidates.find((entry) => entry.modelId === model.modelId);
				return (
					native ?? {
						modelId: model.modelId,
						name: model.name,
						enabled: true,
						reasoning: model.reasoning ?? false,
						vision: model.vision ?? false,
						contextWindow: model.contextWindow ?? 131072,
						maxTokens: Math.min(model.maxTokens ?? 8192, model.contextWindow ?? 131072),
						thinkingPreset: model.thinkingPreset ?? "auto",
					}
				);
			}),
		);
		setSelected([]);
	};
	return (
		<section className="model-discovery" aria-label="获取供应商模型">
			<div className="model-section-title">
				<button
					type="button"
					className="button secondary"
					disabled={pending || fetching || !baseUrl.trim() || (!apiKey && !provider?.configured)}
					onClick={() => void fetchModels()}
				>
					{fetching ? "正在获取…" : "获取模型列表"}
				</button>
				<small>
					{provider?.source === "pi"
						? "读取 Pi 模型目录，沿用 Pi 登录，选择后加入并保存。"
						: "直接读取供应商目录，选择后加入并保存。"}
				</small>
			</div>
			{["openai-completions", "anthropic-messages", "openai-responses"].includes(apiFormat) && (
				<details>
					<summary>自定义模型列表地址（可选）</summary>
					<label>
						模型列表地址
						<input
							value={modelsUrl}
							placeholder="留空自动查找 /models 接口"
							onChange={(event) => setModelsUrl(event.target.value)}
						/>
					</label>
				</details>
			)}
			{error != null && <ErrorNotice error={error} />}
			{result && (
				<>
					<p className="quiet-copy">
						发现 {result.models.length} 个模型 · {result.endpoint}
					</p>
					{result.warnings.map((warning) => (
						<p className="quiet-copy" key={warning}>
							{warning}
						</p>
					))}
					{result.models.length === 0 && <p>供应商返回了空模型列表，可继续手动添加。</p>}
					<div className="discovered-models">
						{result.models.map((model) => (
							<label key={model.modelId} className="discovered-model">
								<input
									type="checkbox"
									aria-label={`选择模型 ${model.modelId}`}
									checked={selected.includes(model.modelId)}
									disabled={!allowed(model.modelId) || pending}
									onChange={(event) =>
										setSelected((ids) =>
											event.target.checked
												? [...ids, model.modelId]
												: ids.filter((id) => id !== model.modelId),
										)
									}
								/>
								<span>
									<strong>{model.name}</strong>
									<small>
										{model.modelId}
										{models.some((entry) => entry.modelId === model.modelId)
											? " · 已添加"
											: !allowed(model.modelId)
												? " · Pi 目录未定义，请添加自定义供应商"
												: ""}
									</small>
								</span>
							</label>
						))}
					</div>
					<div className="model-actions">
						<button
							type="button"
							className="button secondary"
							onClick={() =>
								setSelected(
									result.models.filter((model) => allowed(model.modelId)).map((model) => model.modelId),
								)
							}
						>
							全选可添加模型
						</button>
						<button
							type="button"
							className="button primary"
							disabled={pending || selected.length === 0}
							onClick={addSelected}
						>
							加入所选模型（{selected.length}）
						</button>
					</div>
				</>
			)}
		</section>
	);
}
