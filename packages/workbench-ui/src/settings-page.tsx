import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api, type DiagnosticEvent, type LogRecord, type SettingRecord } from "./api.ts";
import { Icons } from "./icons.tsx";
import { label, profileName } from "./labels.ts";
import { ModelSettings } from "./model-settings.tsx";
import { SandboxSettings } from "./sandbox-settings.tsx";
import { SearchSettings } from "./search-settings.tsx";
import { ErrorNotice, LoadingBlock, PageHeader } from "./ui.tsx";
import { listUiEvents, type UiDiagnosticEvent } from "./ui-events.ts";

type SettingsSection = "general" | "models" | "search" | "sandbox" | "agent" | "memory" | "developer";
type InspectorView = "raw.pi" | "normalized" | "ui" | "logs";

const sections: Array<{ id: SettingsSection; label: string; description: string }> = [
	{ id: "general", label: "常规", description: "工作区与本地存储" },
	{ id: "models", label: "模型", description: "模型服务与默认设置" },
	{ id: "search", label: "联网搜索", description: "DeepSeek 原生搜索" },
	{ id: "sandbox", label: "沙箱", description: "文件、命令和网络边界" },
	{ id: "agent", label: "助手", description: "个人助手默认设置" },
	{ id: "memory", label: "记忆", description: "候选审核方式" },
	{ id: "developer", label: "开发者", description: "事件、日志和运行时" },
];

function setting(records: SettingRecord[] | undefined, key: string): SettingRecord | undefined {
	return records?.find((record) => record.key === key);
}

function DiagnosticRows({ entries }: { entries: Array<DiagnosticEvent | UiDiagnosticEvent> }) {
	return (
		<div className="diagnostic-list">
			{entries.map((entry) => (
				<details key={`${entry.stage}-${entry.id}`}>
					<summary>
						<span className={`diagnostic-stage stage-${entry.stage.replace(".", "-")}`}>
							{label(entry.stage)}
						</span>
						<strong>{entry.type}</strong>
						<small>{new Date(entry.timestamp).toLocaleTimeString()}</small>
					</summary>
					<pre>{JSON.stringify(entry.payload, null, 2)}</pre>
				</details>
			))}
			{entries.length === 0 && <p className="settings-empty">本次启动尚未记录事件。</p>}
		</div>
	);
}

function LogRows({ entries }: { entries: LogRecord[] }) {
	return (
		<div className="diagnostic-list">
			{entries.map((entry, index) => (
				<details key={`${entry.timestamp}-${entry.event}-${index}`}>
					<summary>
						<span className="diagnostic-stage stage-log">log</span>
						<strong>{entry.event}</strong>
						<small>{new Date(entry.timestamp).toLocaleTimeString()}</small>
					</summary>
					<pre>{JSON.stringify(entry.data ?? {}, null, 2)}</pre>
				</details>
			))}
		</div>
	);
}

export function SettingsPage() {
	const queryClient = useQueryClient();
	const [searchParams, setSearchParams] = useSearchParams();
	const section = sections.find((entry) => entry.id === searchParams.get("section"))?.id ?? "general";
	const [inspector, setInspector] = useState<InspectorView>("raw.pi");
	const [, setUiRevision] = useState(0);
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const runtime = useQuery({ queryKey: ["runtime-info"], queryFn: api.runtimeInfo });
	const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles, enabled: section === "agent" });
	const diagnostics = useQuery({
		queryKey: ["diagnostics", inspector],
		queryFn: () => api.diagnosticEvents(inspector === "raw.pi" || inspector === "normalized" ? inspector : undefined),
		enabled: section === "developer" && (inspector === "raw.pi" || inspector === "normalized"),
	});
	const logs = useQuery({
		queryKey: ["logs"],
		queryFn: api.logs,
		enabled: section === "developer" && inspector === "logs",
	});
	const save = useMutation({
		mutationFn: ({ key, value }: { key: string; value: unknown }) =>
			api.setSetting(key, value, setting(settings.data, key)?.version),
		onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
	});
	const defaultProfileId = setting(settings.data, "agent.defaultProfileId")?.value;
	const memoryBehavior = setting(settings.data, "memory.candidateBehavior")?.value;
	const rawViewer = setting(settings.data, "developer.rawEventViewer")?.value !== false;
	const autoCompactEnabled = setting(settings.data, "context.autoCompactEnabled")?.value !== false;
	const compactThreshold = setting(settings.data, "context.autoCompactThresholdPercent")?.value;
	const uiEvents = listUiEvents();
	if (settings.isLoading || runtime.isLoading) return <LoadingBlock label="正在加载设置" />;
	return (
		<div className="page-container settings-page">
			<PageHeader title="设置" description="配置模型、联网能力和执行权限。" />
			{(settings.error || runtime.error || save.error) && (
				<ErrorNotice error={settings.error ?? runtime.error ?? save.error} />
			)}
			<div className="settings-layout">
				<nav className="settings-nav">
					{sections.map((item) => (
						<button
							type="button"
							key={item.id}
							className={section === item.id ? "active" : ""}
							onClick={() => setSearchParams({ section: item.id })}
						>
							<strong>{item.label}</strong>
							<small>{item.description}</small>
						</button>
					))}
				</nav>
				<section className="settings-content">
					{section === "general" && (
						<>
							<div className="settings-section-heading">
								<span className="eyebrow">常规</span>
								<h2>本地工作区</h2>
								<p>可备份的 Markdown 工作区与运行状态、凭证分开存放。</p>
							</div>
							<div className="setting-row stacked">
								<div>
									<strong>工作区路径</strong>
									<small>项目、记忆、技能、成果和文件</small>
								</div>
								<code>{runtime.data?.workspacePath}</code>
							</div>
							<div className="setting-row stacked">
								<div>
									<strong>状态目录</strong>
									<small>数据库、Pi 会话、索引、日志和缓存</small>
								</div>
								<code>{runtime.data?.statePath}</code>
							</div>
							<div className="settings-note">
								<Icons.Project />
								<span>
									启动前设置 <code>PERSONAL_WORKBENCH_HOME</code> 可使用其他数据目录，已有工作区不会自动搬迁。
								</span>
							</div>
							<div className="settings-section-heading">
								<h2>上下文压缩</h2>
								<p>保留任务目标与进度，压缩较早的上下文；历史记录继续保留。手动压缩可使用 /compact。</p>
							</div>
							<div className="setting-row">
								<div>
									<strong>自动压缩</strong>
									<small>按当前模型的上下文窗口检查用量</small>
								</div>
								<label className="switch" aria-label="自动压缩上下文">
									<input
										type="checkbox"
										checked={autoCompactEnabled}
										onChange={(event) =>
											save.mutate({ key: "context.autoCompactEnabled", value: event.target.checked })
										}
									/>
									<span />
								</label>
							</div>
							<div className="setting-row">
								<div>
									<strong>自动压缩阈值</strong>
									<small>默认 80%，修改后在下一次请求生效</small>
								</div>
								<select
									aria-label="自动压缩阈值"
									value={typeof compactThreshold === "number" ? compactThreshold : 80}
									disabled={!autoCompactEnabled || save.isPending}
									onChange={(event) =>
										save.mutate({
											key: "context.autoCompactThresholdPercent",
											value: Number(event.target.value),
										})
									}
								>
									{[
										...new Set([
											50,
											60,
											70,
											80,
											85,
											90,
											95,
											...(typeof compactThreshold === "number" ? [compactThreshold] : []),
										]),
									]
										.sort((a, b) => a - b)
										.map((value) => (
											<option key={value} value={value}>
												{value}%
											</option>
										))}
								</select>
							</div>
						</>
					)}

					{section === "models" && <ModelSettings />}
					{section === "search" && <SearchSettings />}
					{section === "sandbox" && <SandboxSettings records={settings.data ?? []} runtime={runtime.data} />}
					{section === "agent" && (
						<>
							<div className="settings-section-heading">
								<span className="eyebrow">助手</span>
								<h2>个人助手</h2>
								<p>选择首页与对话中新建会话使用的默认助手。</p>
							</div>
							<div className="setting-row">
								<div>
									<strong>默认助手</strong>
									<small>系统指令、工具、技能和默认模型</small>
								</div>
								<select
									value={
										typeof defaultProfileId === "string"
											? defaultProfileId
											: (profiles.data?.find((profile) => profile.slug === "standard")?.id ?? "")
									}
									onChange={(event) =>
										save.mutate({ key: "agent.defaultProfileId", value: event.target.value })
									}
								>
									{profiles.data?.map((profile) => (
										<option value={profile.id} key={profile.id}>
											{profileName(profile)}
										</option>
									))}
								</select>
							</div>
							<div className="profile-cards">
								{profiles.data?.map((profile) => (
									<article key={profile.id}>
										<div>
											<Icons.Spark />
											<strong>{profileName(profile)}</strong>
										</div>
										<p>{profile.isBuiltin ? label(profile.description) : profile.description}</p>
										<small>
											{profile.tools.length} 个工具 · {profile.skillIds.length} 个技能 ·{" "}
											{profile.mcpBindings.length} MCP 工具
										</small>
									</article>
								))}
							</div>
						</>
					)}

					{section === "memory" && (
						<>
							<div className="settings-section-heading">
								<span className="eyebrow">记忆</span>
								<h2>长期记忆审核</h2>
								<p>Markdown 是记忆原文，助手的候选需确认后才能写入。</p>
							</div>
							<div className="setting-row">
								<div>
									<strong>候选处理方式</strong>
									<small>控制长期记忆候选的处理方式</small>
								</div>
								<select
									value={typeof memoryBehavior === "string" ? memoryBehavior : "review"}
									onChange={(event) =>
										save.mutate({ key: "memory.candidateBehavior", value: event.target.value })
									}
								>
									<option value="review">始终需要确认</option>
									<option value="disabled">停用助手记忆候选</option>
								</select>
							</div>
							<div className="settings-note">
								<Icons.Memory />
								<span>文件页对用户、全局、每日和项目记忆的修改，统一通过记忆服务进行冲突检查。</span>
							</div>
						</>
					)}

					{section === "developer" && (
						<>
							<div className="settings-section-heading">
								<span className="eyebrow">开发者</span>
								<h2>运行时检查</h2>
								<p>原始 Pi 事件经过脱敏并限量保存，对话页面只使用统一事件。</p>
							</div>
							<div className="runtime-grid">
								<div>
									<span>运行时</span>
									<strong>
										{runtime.data?.runtime} {runtime.data?.version}
									</strong>
								</div>
								<div>
									<span>Node</span>
									<strong>{runtime.data?.nodeVersion}</strong>
								</div>
								<div>
									<span>平台</span>
									<strong>
										{runtime.data?.platform} / {runtime.data?.architecture}
									</strong>
								</div>
								<div>
									<span>Pi 会话</span>
									<strong title={runtime.data?.piSessionsPath}>{runtime.data?.piSessionsPath}</strong>
								</div>
							</div>
							<div className="setting-row">
								<div>
									<strong>原始事件查看器</strong>
									<small>显示开发者事件面板</small>
								</div>
								<label className="switch" aria-label="切换原始事件查看器">
									<input
										type="checkbox"
										checked={rawViewer}
										onChange={(event) =>
											save.mutate({ key: "developer.rawEventViewer", value: event.target.checked })
										}
									/>
									<span />
								</label>
							</div>
							{rawViewer && (
								<div className="event-inspector">
									<header>
										<div className="page-segmented">
											{(["raw.pi", "normalized", "ui", "logs"] as InspectorView[]).map((view) => (
												<button
													type="button"
													key={view}
													className={inspector === view ? "active" : ""}
													onClick={() => setInspector(view)}
												>
													{view === "raw.pi"
														? "Pi 原始事件"
														: view === "normalized"
															? "统一事件"
															: view === "ui"
																? "界面事件"
																: "日志"}
												</button>
											))}
										</div>
										<button
											type="button"
											className="button secondary"
											onClick={() => {
												if (inspector === "logs") void logs.refetch();
												else if (inspector === "ui") setUiRevision((value) => value + 1);
												else void diagnostics.refetch();
											}}
										>
											刷新
										</button>
									</header>
									{inspector === "ui" ? (
										<DiagnosticRows entries={uiEvents} />
									) : inspector === "logs" ? (
										<LogRows entries={logs.data ?? []} />
									) : (
										<DiagnosticRows entries={diagnostics.data ?? []} />
									)}
								</div>
							)}
						</>
					)}
				</section>
			</div>
		</div>
	);
}
