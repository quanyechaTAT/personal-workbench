import {
	DEFAULT_SANDBOX_POLICY,
	isSandboxSettings,
	type RuntimeSandboxPolicy,
} from "@earendil-works/workbench-runtime";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type RuntimeInfo, type SettingRecord } from "./api.ts";
import { ErrorNotice } from "./ui.tsx";

export function SandboxSettings({ records, runtime }: { records: SettingRecord[]; runtime?: RuntimeInfo }) {
	const client = useQueryClient();
	const saved = records.find((record) => record.key === "sandbox.policy");
	const policy = isSandboxSettings(saved?.value) ? saved.value : DEFAULT_SANDBOX_POLICY;
	const save = useMutation({
		mutationFn: (value: Omit<RuntimeSandboxPolicy, "protectedPaths">) =>
			api.setSetting("sandbox.policy", value, saved?.version),
		onSuccess: () => client.invalidateQueries({ queryKey: ["settings"] }),
	});
	const pick = useMutation({
		mutationFn: async () => {
			const selected = await api.pickProjectDirectory();
			if (selected.path && !policy.writableRoots.includes(selected.path))
				await save.mutateAsync({ ...policy, writableRoots: [...policy.writableRoots, selected.path] });
		},
	});
	const pending = save.isPending || pick.isPending;
	return (
		<>
			<div className="settings-section-heading">
				<span className="eyebrow">执行边界</span>
				<h2>沙箱</h2>
				<p>限制文件修改和本地命令及其子进程。批准策略决定是否询问，沙箱决定批准后仍能访问什么。</p>
			</div>
			{(save.error || pick.error) && <ErrorNotice error={save.error ?? pick.error} />}
			{saved && !isSandboxSettings(saved.value) && (
				<ErrorNotice error="已保存的沙箱设置无效；请选择模式并重新保存。" />
			)}
			<div className="setting-row">
				<div>
					<strong>执行模式</strong>
					<small>默认只允许写入当前会话目录和明确添加的目录</small>
				</div>
				<select
					aria-label="沙箱执行模式"
					value={policy.mode}
					disabled={pending}
					onChange={(event) => {
						const mode = event.target.value;
						if (mode !== "read-only" && mode !== "workspace-write" && mode !== "danger-full-access") return;
						save.mutate({
							...policy,
							mode,
							networkAccess: mode === "danger-full-access" ? true : policy.networkAccess,
						});
					}}
				>
					<option value="read-only">只读</option>
					<option value="workspace-write">工作区可写（默认）</option>
					<option value="danger-full-access">无限制访问（关闭沙箱）</option>
				</select>
			</div>
			<div className="setting-row">
				<div>
					<strong>命令网络访问</strong>
					<small>
						{policy.mode === "danger-full-access"
							? "关闭沙箱后网络访问不受限制"
							: "默认关闭；安装依赖、访问服务时可开启"}
					</small>
				</div>
				<label className="switch" aria-label="允许沙箱命令联网">
					<input
						type="checkbox"
						checked={policy.mode === "danger-full-access" || policy.networkAccess}
						disabled={pending || policy.mode === "danger-full-access"}
						onChange={(event) => save.mutate({ ...policy, networkAccess: event.target.checked })}
					/>
					<span />
				</label>
			</div>
			<div className="setting-row stacked">
				<div>
					<strong>额外可写目录</strong>
					<small>工作区可写模式下生效，最多 16 个目录</small>
				</div>
				{policy.writableRoots.map((root) => (
					<div className="setting-row" key={root}>
						<code>{root}</code>
						<button
							type="button"
							className="button secondary"
							aria-label={`移除可写目录 ${root}`}
							disabled={pending}
							onClick={() =>
								save.mutate({ ...policy, writableRoots: policy.writableRoots.filter((item) => item !== root) })
							}
						>
							移除
						</button>
					</div>
				))}
				<button
					type="button"
					className="button secondary"
					disabled={pending || policy.mode !== "workspace-write" || policy.writableRoots.length >= 16}
					onClick={() => pick.mutate()}
				>
					{pick.isPending ? "正在选择文件夹…" : "添加可写目录…"}
				</button>
			</div>
			{runtime?.platform === "win32" && (
				<div className="setting-row">
					<div>
						<strong>Windows 隔离方式</strong>
						<small>增强隔离首次使用需要 Windows 管理员确认；失败时不会改为无沙箱运行</small>
					</div>
					<select
						aria-label="Windows 沙箱隔离方式"
						value={policy.windowsImplementation ?? "elevated"}
						disabled={pending || policy.mode === "danger-full-access"}
						onChange={(event) => {
							const windowsImplementation = event.target.value;
							if (windowsImplementation === "elevated" || windowsImplementation === "unelevated")
								save.mutate({ ...policy, windowsImplementation });
						}}
					>
						<option value="elevated">增强隔离（推荐）</option>
						<option value="unelevated">受限令牌（网络隔离较弱）</option>
					</select>
				</div>
			)}
			<div className="settings-note">
				<span>
					更改在下一次请求生效，旧终端会关闭。文件工具继续保护凭证和内部状态；沙箱内的 .git、.codex、.agents
					目录只读。浏览器、桌面、搜索和 MCP 使用各自的授权设置。
					{runtime?.platform === "win32" && " Windows 防火墙不拦截本机回环服务，受限令牌模式也不保证阻断网络。"}
				</span>
			</div>
			{policy.mode === "danger-full-access" && (
				<div className="settings-note">
					<span>当前已关闭操作系统沙箱。命令可以修改项目外文件并访问网络。</span>
				</div>
			)}
		</>
	);
}
