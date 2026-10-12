import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type SaveAgentProfileRequest } from "./api.ts";
import { label } from "./labels.ts";
import { ErrorNotice, LoadingBlock } from "./ui.tsx";

export function CapabilityPicker({
	value,
	onChange,
}: {
	value: SaveAgentProfileRequest;
	onChange: (value: SaveAgentProfileRequest) => void;
}) {
	const [projectId, setProjectId] = useState("");
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	const catalog = useQuery({
		queryKey: ["capabilities", projectId],
		queryFn: () => api.capabilities(projectId || undefined),
	});
	const toggle = (key: "tools" | "skillIds", id: string, enabled: boolean) => {
		onChange({
			...value,
			[key]: enabled ? [...(value[key] ?? []), id] : (value[key] ?? []).filter((item) => item !== id),
		});
	};
	return (
		<div className="capability-picker">
			{catalog.isLoading && <LoadingBlock label="正在加载能力" />}
			{catalog.error && <ErrorNotice error={catalog.error} />}
			<section className="editor-section">
				<h2>技能</h2>
				<p>技能提供工作方法和资源；需要执行操作时，还要为助手选择相应工具。</p>
				<label className="field">
					显示项目技能
					<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
						<option value="">全局技能</option>
						{projects.data?.map((project) => (
							<option key={project.id} value={project.id}>
								{project.name}
							</option>
						))}
					</select>
				</label>
				<div className="capability-list">
					{catalog.data?.skills.map((skill) => (
						<label className="capability-option" key={skill.id}>
							<input
								type="checkbox"
								checked={value.skillIds?.includes(skill.id) ?? false}
								disabled={
									!skill.enabled ||
									skill.diagnostics.some(
										(value) => value.startsWith("error:") || value.startsWith("collision:"),
									)
								}
								onChange={(event) => toggle("skillIds", skill.id, event.target.checked)}
							/>
							<span>
								<strong>
									{skill.name} <small>{label(skill.scope)}</small>
								</strong>
								<small>{skill.description}</small>
								{(!skill.enabled || skill.diagnostics.length > 0) && (
									<small>{skill.diagnostics.join("; ") || "已停用"}</small>
								)}
							</span>
						</label>
					))}
				</div>
				{(value.skillIds ?? [])
					.filter((id) => !catalog.data?.skills.some((skill) => skill.id === id))
					.map((id) => (
						<div className="capability-option" key={id}>
							<span>当前范围外的技能： {id}</span>
							<button type="button" className="button secondary" onClick={() => toggle("skillIds", id, false)}>
								移除
							</button>
						</div>
					))}
				<Link to="/skills">导入或创建技能</Link>
			</section>
			<section className="editor-section">
				<h2>内置工具</h2>
				<div className="capability-list">
					{catalog.data?.builtinTools.map((tool) => (
						<label className="capability-option" key={tool.id}>
							<input
								type="checkbox"
								checked={value.tools?.includes(tool.id) ?? false}
								onChange={(event) => toggle("tools", tool.id, event.target.checked)}
							/>
							<span>
								<strong>{label(tool.label)}</strong>
								<small>{label(tool.description)}</small>
							</span>
						</label>
					))}
				</div>
			</section>
			<section className="editor-section">
				<h2>MCP 工具</h2>
				<p>选择具体工具，新发现的工具不会自动启用。</p>
				<p>“请求批准”模式始终逐次询问；“帮我批准”模式自动放行设置为“允许此工具”的 MCP 工具。</p>
				{catalog.data?.connections.map(({ connection, tools }) => (
					<div className="connection-capabilities" key={connection.id}>
						<h3>
							{connection.name} <small>{connection.enabled ? connection.transport : "已停用"}</small>
						</h3>
						{tools.map((tool) => {
							const binding = value.mcpBindings?.find(
								(item) => item.connectionId === connection.id && item.toolName === tool.name,
							);
							const changed = binding && binding.approvedDefinitionHash !== tool.definitionHash;
							const setBinding = (selected: boolean, approval: "ask" | "allow" = "ask") =>
								onChange({
									...value,
									mcpBindings: [
										...(value.mcpBindings ?? []).filter(
											(item) => !(item.connectionId === connection.id && item.toolName === tool.name),
										),
										...(selected
											? [
													{
														connectionId: connection.id,
														toolName: tool.name,
														approvedDefinitionHash: tool.definitionHash,
														approval,
													},
												]
											: []),
									],
								});
							return (
								<div className="capability-option" key={tool.name}>
									<label>
										<input
											type="checkbox"
											checked={Boolean(binding)}
											disabled={(!connection.enabled || Boolean(tool.diagnostic)) && !binding}
											onChange={(event) => setBinding(event.target.checked)}
										/>
										<span>
											<strong>{tool.title ?? tool.name}</strong>
											<small>{label(tool.description)}</small>
											{tool.diagnostic && <small>不可用： {tool.diagnostic}</small>}
										</span>
									</label>
									{binding && (
										<select
											aria-label={`${tool.name} 的批准方式`}
											value={binding.approval}
											onChange={(event) =>
												setBinding(true, event.target.value === "allow" ? "allow" : "ask")
											}
										>
											<option value="ask">逐次批准</option>
											<option value="allow">允许此工具</option>
										</select>
									)}
									{changed && (
										<button type="button" className="button secondary" onClick={() => setBinding(true)}>
											确认新的工具定义
										</button>
									)}
								</div>
							);
						})}
						{tools.length === 0 && <p>测试连接以发现工具。</p>}
					</div>
				))}
				<Link to="/connections">管理连接</Link>
			</section>
		</div>
	);
}
