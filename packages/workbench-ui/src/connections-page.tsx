import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api, type McpConnectionDto, type McpToolRecord } from "./api.ts";
import { ConnectionEditor } from "./connection-editor.tsx";
import { label } from "./labels.ts";
import { EmptyState, ErrorNotice, LoadingBlock, PageHeader, StatusPill } from "./ui.tsx";

function ConnectionTools({ id }: { id: string }) {
	const tools = useQuery({ queryKey: ["connection-tools", id], queryFn: () => api.connectionTools(id) });
	return (
		<div className="tool-catalog">
			{tools.error && <ErrorNotice error={tools.error} />}
			{tools.data?.map((tool: McpToolRecord) => (
				<details key={tool.name}>
					<summary>{tool.title ?? tool.name}</summary>
					<p>{label(tool.description)}</p>
					{tool.diagnostic && <ErrorNotice error={`不可用：${tool.diagnostic}`} />}
					<pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
				</details>
			))}
			{tools.data?.length === 0 && <p>测试连接以发现工具。</p>}
		</div>
	);
}

export function ConnectionsPage() {
	const client = useQueryClient();
	const [params] = useSearchParams();
	const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
	const [editing, setEditing] = useState<McpConnectionDto | "new">();
	const [notice, setNotice] = useState("");
	const refresh = async () => {
		await Promise.all([
			client.invalidateQueries({ queryKey: ["connections"] }),
			client.invalidateQueries({ queryKey: ["connection-tools"] }),
			client.invalidateQueries({ queryKey: ["capabilities"] }),
		]);
	};
	const test = useMutation({
		mutationFn: api.testConnection,
		onSuccess: async (result) => {
			setNotice(`连接成功，发现 ${result.tools.length} 个工具。`);
			await refresh();
		},
		onError: () => void refresh(),
	});
	const toggle = useMutation({ mutationFn: api.toggleConnection, onSuccess: refresh });
	const authorize = useMutation({
		mutationFn: api.authorizeConnection,
		onSuccess: (result) => {
			if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
			else setNotice("此连接已授权。");
		},
	});
	const disconnect = useMutation({ mutationFn: api.disconnectAuthorization, onSuccess: refresh });
	return (
		<div className="page-container">
			<PageHeader
				eyebrow="外部能力"
				title="连接"
				description="接入 MCP 服务，发现工具，再为助手选择具体能力。"
				actions={
					<button className="button primary" type="button" onClick={() => setEditing("new")}>
						添加连接
					</button>
				}
			/>
			{params.get("oauth") === "success" && (
				<output className="success-notice">授权已完成。请测试连接以刷新工具列表。</output>
			)}
			{params.get("oauth") === "failed" && <ErrorNotice error="授权失败或已过期，请重新授权。" />}
			{notice && <output className="success-notice">{notice}</output>}
			{editing && (
				<ConnectionEditor
					key={editing === "new" ? "new" : editing.id}
					connection={editing === "new" ? undefined : editing}
					onClose={() => setEditing(undefined)}
				/>
			)}
			{connections.isLoading && <LoadingBlock />}
			{(connections.error || test.error || toggle.error || authorize.error || disconnect.error) && (
				<ErrorNotice
					error={connections.error ?? test.error ?? toggle.error ?? authorize.error ?? disconnect.error}
				/>
			)}
			<div className="assistant-grid">
				{connections.data?.map((connection) => (
					<article className="assistant-card" key={connection.id}>
						<header>
							<h2>{connection.name}</h2>
							<StatusPill value={connection.enabled ? "enabled" : "disabled"} />
						</header>
						<p>
							{label(connection.transport)} · {label(connection.authKind)}
						</p>
						<code>{connection.remote?.url ?? connection.stdio?.command}</code>
						{connection.authKind === "oauth" && <p>{connection.authentication?.oauth ? "已授权" : "需要授权"}</p>}
						{connection.authKind === "headers" && (
							<p>{connection.authentication?.configured ? "已配置凭证" : "需要凭证"}</p>
						)}
						{connection.lastConnectedAt && (
							<small>最近连接： {new Date(connection.lastConnectedAt).toLocaleString()}</small>
						)}
						{connection.lastError && <ErrorNotice error={connection.lastError} />}
						<div className="card-actions">
							<button className="button secondary" type="button" onClick={() => setEditing(connection)}>
								编辑
							</button>
							<button
								className="button primary"
								type="button"
								disabled={test.isPending}
								onClick={() => {
									setNotice("");
									test.mutate(connection.id);
								}}
							>
								{test.isPending && test.variables === connection.id
									? "正在连接…"
									: connection.transport === "stdio"
										? "运行命令并测试"
										: "测试连接"}
							</button>
							<button
								className="button secondary"
								type="button"
								disabled={toggle.isPending}
								onClick={() => toggle.mutate(connection)}
							>
								{connection.enabled ? "停用" : "启用"}
							</button>
							{connection.authKind === "oauth" && (
								<>
									<button
										className="button secondary"
										type="button"
										disabled={authorize.isPending}
										onClick={() => authorize.mutate(connection.id)}
									>
										授权
									</button>
									<button
										className="button secondary"
										type="button"
										onClick={() => disconnect.mutate(connection.id)}
									>
										清除授权
									</button>
								</>
							)}
						</div>
						<ConnectionTools id={connection.id} />
					</article>
				))}
			</div>
			{connections.data?.length === 0 && (
				<EmptyState
					title="接入第一个 MCP 服务"
					description="添加本地命令或远程 MCP 地址，再到助手编辑器中绑定工具。"
				/>
			)}
		</div>
	);
}
