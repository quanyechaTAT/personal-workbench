import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { type AgentProfile, api } from "./api.ts";
import { label, profileName } from "./labels.ts";
import { ErrorNotice, LoadingBlock, PageHeader, StatusPill } from "./ui.tsx";

export function AssistantsPage() {
	const client = useQueryClient();
	const navigate = useNavigate();
	const [archived, setArchived] = useState(false);
	const profiles = useQuery({ queryKey: ["profiles", "all"], queryFn: api.allProfiles });
	const update = useMutation({
		mutationFn: async ({ profile, action }: { profile: AgentProfile; action: "archive" | "restore" | "delete" }) => {
			if (action === "delete") await api.deleteProfile(profile);
			else await api.profileStatus(profile, action);
		},
		onSuccess: () =>
			Promise.all([
				client.invalidateQueries({ queryKey: ["profiles"] }),
				client.invalidateQueries({ queryKey: ["settings"] }),
				client.invalidateQueries({ queryKey: ["capabilities"] }),
			]),
	});
	const clone = useMutation({
		mutationFn: api.cloneProfile,
		onSuccess: async (profile) => {
			await client.invalidateQueries({ queryKey: ["profiles"] });
			navigate(`/assistants/${profile.id}`);
		},
	});
	return (
		<div className="page-container">
			<PageHeader
				eyebrow="你的助手"
				title="助手"
				description="为每个助手配置用途、指令和需要的能力。"
				actions={
					<>
						<Link className="button secondary" to="/assistants/generate">
							描述需求生成
						</Link>
						<Link className="button primary" to="/assistants/new">
							手动创建
						</Link>
					</>
				}
			/>
			<label className="inline-check">
				<input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />
				显示已归档助手
			</label>
			{profiles.isLoading && <LoadingBlock />}
			{(profiles.error || update.error || clone.error) && (
				<ErrorNotice error={profiles.error ?? update.error ?? clone.error} />
			)}
			<div className="assistant-grid">
				{profiles.data
					?.filter((profile) => archived || profile.status === "active")
					.map((profile) => (
						<article className="assistant-card" key={profile.id}>
							<header>
								<h2>{profileName(profile)}</h2>
								<StatusPill value={profile.status} />
							</header>
							<p>{(profile.isBuiltin ? label(profile.description) : profile.description) || "个人助手"}</p>
							<small>
								v{profile.version} · {profile.tools.length} 个内置工具 · {profile.skillIds.length} 个技能 ·{" "}
								{profile.mcpBindings.length} MCP 工具
							</small>
							<div className="card-actions">
								<Link className="button secondary" to={`/assistants/${profile.id}`}>
									编辑
								</Link>
								{profile.status === "active" && (
									<Link className="button primary" to={`/chat?assistant=${profile.id}`}>
										对话
									</Link>
								)}
								<button
									className="button secondary"
									type="button"
									disabled={clone.isPending}
									onClick={() => clone.mutate(profile.id)}
								>
									复制
								</button>
								<button
									className="button secondary"
									type="button"
									disabled={update.isPending}
									onClick={() =>
										update.mutate({ profile, action: profile.status === "active" ? "archive" : "restore" })
									}
								>
									{profile.status === "active" ? "归档" : "恢复"}
								</button>
								<button
									type="button"
									className="button secondary danger-text"
									disabled={update.isPending}
									onClick={() => {
										if (
											window.confirm(
												`删除助手“${profile.name}”？删除后不再提供选择，已有会话和历史会保留，可改选其他助手继续。`,
											)
										)
											update.mutate({ profile, action: "delete" });
									}}
								>
									删除
								</button>
							</div>
						</article>
					))}
			</div>
		</div>
	);
}
