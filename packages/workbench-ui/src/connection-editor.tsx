import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, type McpConnectionDto, type SaveMcpConnectionRequest } from "./api.ts";
import { ErrorNotice } from "./ui.tsx";

function stringMap(text: string): Record<string, string> {
	const value: unknown = JSON.parse(text || "{}");
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.values(value).some((item) => typeof item !== "string")
	)
		throw new Error("请输入值均为字符串的 JSON 对象");
	return value as Record<string, string>;
}

export function ConnectionEditor({ connection, onClose }: { connection?: McpConnectionDto; onClose: () => void }) {
	const client = useQueryClient();
	const [name, setName] = useState(connection?.name ?? "");
	const [transport, setTransport] = useState<SaveMcpConnectionRequest["transport"]>(
		connection?.transport ?? "streamable-http",
	);
	const [authKind, setAuthKind] = useState<SaveMcpConnectionRequest["authKind"]>(connection?.authKind ?? "none");
	const [command, setCommand] = useState(connection?.stdio?.command ?? "");
	const [args, setArgs] = useState(JSON.stringify(connection?.stdio?.args ?? []));
	const [cwd, setCwd] = useState(connection?.stdio?.cwd ?? "");
	const [url, setUrl] = useState(connection?.remote?.url ?? "");
	const [clientId, setClientId] = useState(connection?.remote?.clientId ?? "");
	const [clientSecret, setClientSecret] = useState("");
	const [timeout, setTimeout] = useState(String((connection?.callTimeoutMs ?? 120000) / 1000));
	const [token, setToken] = useState("");
	const [headers, setHeaders] = useState("");
	const [environment, setEnvironment] = useState("");
	const [replaceSecrets, setReplaceSecrets] = useState(!connection);
	const save = useMutation({
		mutationFn: async () => {
			const timeoutSeconds = Number(timeout);
			if (!timeout || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600)
				throw new Error("工具超时必须是 1 到 600 秒的整数");
			const parsedArgs: unknown = JSON.parse(args);
			if (!Array.isArray(parsedArgs) || parsedArgs.some((item) => typeof item !== "string"))
				throw new Error("参数必须是字符串组成的 JSON 数组");
			const headerValues = stringMap(headers);
			const environmentValues = stringMap(environment);
			const input: SaveMcpConnectionRequest = {
				name,
				callTimeoutMs: timeoutSeconds * 1000,
				transport,
				authKind: transport === "stdio" ? "none" : authKind,
				stdio:
					transport === "stdio"
						? {
								command,
								args: parsedArgs,
								cwd: cwd || undefined,
								environmentKeys: replaceSecrets
									? Object.keys(environmentValues)
									: (connection?.stdio?.environmentKeys ?? []),
							}
						: undefined,
				remote:
					transport !== "stdio"
						? {
								url,
								clientId: clientId || undefined,
								headerNames: replaceSecrets
									? Object.keys(headerValues)
									: (connection?.remote?.headerNames ?? []),
							}
						: undefined,
				secret: replaceSecrets
					? {
							clientSecret: clientSecret || undefined,
							bearerToken: token || undefined,
							headers: headerValues,
							environment: environmentValues,
						}
					: undefined,
			};
			return connection
				? api.updateConnection(connection.id, input, connection.version)
				: api.createConnection(input);
		},
		onSuccess: async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: ["connections"] }),
				client.invalidateQueries({ queryKey: ["capabilities"] }),
			]);
			onClose();
		},
	});
	const submit = (event: FormEvent) => {
		event.preventDefault();
		save.mutate();
	};
	return (
		<form className="editor-section connection-editor" onSubmit={submit}>
			<h2>{connection ? "编辑连接" : "添加 MCP 连接"}</h2>
			<div className="field-grid">
				<label className="field">
					名称
					<input required value={name} onChange={(event) => setName(event.target.value)} />
				</label>
				<label className="field">
					传输方式
					<select
						value={transport}
						onChange={(event) => setTransport(event.target.value as SaveMcpConnectionRequest["transport"])}
					>
						<option value="streamable-http">Streamable HTTP</option>
						<option value="stdio">本地进程（stdio）</option>
						<option value="sse">旧版 HTTP + SSE</option>
					</select>
				</label>
			</div>
			{transport === "stdio" ? (
				<>
					<p>测试或使用此连接会以当前用户权限运行所填程序。</p>
					<label className="field">
						命令
						<input
							required
							value={command}
							onChange={(event) => setCommand(event.target.value)}
							placeholder="node"
						/>
					</label>
					<label className="field">
						参数（JSON 数组）
						<input
							required
							value={args}
							onChange={(event) => setArgs(event.target.value)}
							placeholder={'["C:/mcp/server.mjs"]'}
						/>
					</label>
					<label className="field">
						工作目录（可选）
						<input value={cwd} onChange={(event) => setCwd(event.target.value)} />
					</label>
				</>
			) : (
				<>
					<label className="field">
						MCP 地址
						<input
							required
							type="url"
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							placeholder="https://service.example/mcp"
						/>
					</label>
					<label className="field">
						认证方式
						<select
							value={authKind}
							onChange={(event) => setAuthKind(event.target.value as SaveMcpConnectionRequest["authKind"])}
						>
							<option value="none">无</option>
							<option value="headers">API Key / 自定义请求头</option>
							<option value="oauth">OAuth</option>
						</select>
					</label>
					{authKind === "oauth" && (
						<label className="field">
							已注册 Client ID（可选）
							<input value={clientId} onChange={(event) => setClientId(event.target.value)} />
							<small>服务支持动态注册时可留空。保存后点击授权。</small>
						</label>
					)}
				</>
			)}
			{connection && (
				<label className="inline-check">
					<input
						type="checkbox"
						checked={replaceSecrets}
						onChange={(event) => setReplaceSecrets(event.target.checked)}
					/>
					替换已存凭证（不会回显原值）
				</label>
			)}
			{replaceSecrets &&
				(transport === "stdio" ? (
					<label className="field">
						环境变量凭证（JSON 对象）
						<input
							type="password"
							autoComplete="new-password"
							value={environment}
							onChange={(event) => setEnvironment(event.target.value)}
							placeholder={'{"API_KEY":"…"}'}
						/>
					</label>
				) : (
					authKind === "headers" && (
						<>
							<label className="field">
								Bearer Token / API Key
								<input
									type="password"
									autoComplete="new-password"
									value={token}
									onChange={(event) => setToken(event.target.value)}
								/>
							</label>
							<label className="field">
								自定义请求头（JSON 对象）
								<input
									type="password"
									autoComplete="new-password"
									value={headers}
									onChange={(event) => setHeaders(event.target.value)}
									placeholder={'{"X-API-Key":"…"}'}
								/>
							</label>
						</>
					)
				))}
			{save.error && <ErrorNotice error={save.error} />}
			{authKind === "oauth" && replaceSecrets && (
				<label className="field">
					已注册 Client Secret（可选）
					<input
						type="password"
						autoComplete="new-password"
						value={clientSecret}
						onChange={(event) => setClientSecret(event.target.value)}
					/>
				</label>
			)}
			<label className="field">
				工具超时（秒）
				<input
					type="number"
					min={1}
					max={600}
					required
					value={timeout}
					onChange={(event) => setTimeout(event.target.value)}
				/>
			</label>
			<div className="card-actions">
				<button className="button secondary" type="button" onClick={onClose}>
					取消
				</button>
				<button className="button primary" disabled={save.isPending} type="submit">
					{save.isPending ? "正在保存…" : "保存连接"}
				</button>
			</div>
		</form>
	);
}
