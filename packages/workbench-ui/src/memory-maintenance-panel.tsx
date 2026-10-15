import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.ts";
import { ErrorNotice, LoadingBlock } from "./ui.tsx";

type Policy = Awaited<ReturnType<typeof api.memoryMaintenance>>["policy"];
export function MemoryMaintenancePanel() {
	const client = useQueryClient();
	const status = useQuery({ queryKey: ["memory-maintenance"], queryFn: () => api.memoryMaintenance() });
	const [draft, setDraft] = useState<Policy>();
	const save = useMutation({
		mutationFn: () => api.setSetting("memory.policy", draft),
		onSuccess: async () => {
			setDraft(undefined);
			await client.invalidateQueries({ queryKey: ["memory-maintenance"] });
		},
	});
	const run = useMutation({
		mutationFn: () => api.memoryMaintenance(true),
		onSuccess: async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: ["memory-maintenance"] }),
				client.invalidateQueries({ queryKey: ["memory-files"] }),
			]);
		},
	});
	const policy = draft ?? status.data?.policy;
	return (
		<details className="create-panel">
			<summary>记忆维护与浓缩</summary>
			{status.isLoading && <LoadingBlock />}
			{policy && (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<p>先查看成功与失败记录，成功后提炼结构化经验。短索引 → 完整方案 → 原始证据，逐层展开。</p>
					{(
						[
							["confidenceThreshold", "置信度淘汰阈值", 0, 1, 0.05],
							["staleAfterDays", "过期复核提醒（天）", 1, 3650, 1],
							["consolidationIntervalHours", "自动浓缩间隔（小时）", 1, 8760, 1],
							["maxEntryCharacters", "main.md 每条正文上限（字）", 20, 500, 1],
						] as const
					).map(([key, title, min, max, step]) => (
						<label key={key} className="field">
							{title}
							<input
								type="number"
								required
								value={policy[key]}
								min={min}
								max={max}
								step={step}
								onChange={(event) => setDraft({ ...policy, [key]: event.target.valueAsNumber })}
							/>
						</label>
					))}
					<p>
						{status.data?.completedAt
							? `上次完成：${new Date(status.data.completedAt).toLocaleString()}`
							: "尚未浓缩；工作台运行期间按设定间隔执行。"}
					</p>
					<div className="card-actions">
						<button className="button primary" type="submit" disabled={!draft || save.isPending || run.isPending}>
							保存参数
						</button>
						<button
							className="button secondary"
							type="button"
							disabled={run.isPending || save.isPending || Boolean(draft)}
							onClick={() => run.mutate()}
						>
							{run.isPending ? "正在浓缩…" : "立即浓缩"}
						</button>
					</div>
					{run.isSuccess && <output>记忆维护已完成。</output>}
				</form>
			)}
			{(status.error || save.error || run.error) && <ErrorNotice error={status.error ?? save.error ?? run.error} />}
		</details>
	);
}
