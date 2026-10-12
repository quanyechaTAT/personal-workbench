import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.ts";
import { SearchResults } from "./search-results.tsx";
import { ErrorNotice, LoadingBlock } from "./ui.tsx";

export function SearchSettings() {
	const client = useQueryClient();
	const settings = useQuery({ queryKey: ["search-settings"], queryFn: api.searchSettings });
	const [query, setQuery] = useState("");
	const toggle = useMutation({
		mutationFn: (enabled: boolean) =>
			api.saveSearchSettings({ enabled, expectedVersion: settings.data?.version ?? 0 }),
		onSuccess: (result) => client.setQueryData(["search-settings"], result),
	});
	const test = useMutation({ mutationFn: () => api.testSearch(query) });
	if (settings.isLoading) return <LoadingBlock label="正在加载搜索设置" />;
	return (
		<div>
			<div className="settings-section-heading">
				<h2>联网搜索</h2>
				<p>使用 DeepSeek 官方原生搜索，复用 Pi 登录或模型设置中的 DeepSeek 官方 API Key。</p>
			</div>
			{(settings.error || toggle.error || test.error) && (
				<ErrorNotice error={settings.error ?? toggle.error ?? test.error} />
			)}
			<div className="setting-row">
				<div>
					<strong>启用联网搜索</strong>
					<small>允许已勾选“联网搜索”工具的助手检索互联网</small>
				</div>
				<label className="switch" aria-label="启用联网搜索">
					<input
						type="checkbox"
						disabled={toggle.isPending}
						checked={settings.data?.enabled ?? false}
						onChange={(event) => toggle.mutate(event.target.checked)}
					/>
					<span />
				</label>
			</div>
			<div className="setting-row">
				<div>
					<strong>凭证状态</strong>
					<small>只向 DeepSeek 官方地址发送 DeepSeek 凭证</small>
				</div>
				<span>{settings.data?.configured ? "已配置" : "未配置 DeepSeek 官方凭证"}</span>
			</div>
			<div className="setting-row stacked">
				<div>
					<strong>搜索模型与接口</strong>
					<small>{settings.data?.modelId}</small>
				</div>
				<code>{settings.data?.endpoint}</code>
			</div>
			<p className="search-settings-note">
				每次搜索会单独调用 DeepSeek 模型并产生 API 费用；每轮对话最多搜索 6
				次，每次最多使用一次原生搜索。搜索只发送查询词和域名筛选。
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					test.mutate();
				}}
				className="search-test-form"
			>
				<label>
					测试搜索
					<input
						value={query}
						placeholder="例如：DeepSeek 官方 API 文档"
						minLength={2}
						maxLength={512}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>
				<button
					className="button secondary"
					type="submit"
					disabled={
						test.isPending || query.trim().length < 2 || !settings.data?.enabled || !settings.data.configured
					}
				>
					{test.isPending ? "正在搜索…" : "执行一次搜索"}
				</button>
			</form>
			{test.data && <SearchResults text={JSON.stringify(test.data)} />}
		</div>
	);
}
