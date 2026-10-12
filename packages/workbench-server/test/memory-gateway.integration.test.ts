import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type {
	EpisodicMemory,
	MemoryCandidate,
	SemanticMemory,
	WorkingCheckpoint,
} from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("Gateway scopes checkpoints, retained episode evidence, semantic version candidates, conflict and rollback", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "中文 空格 记忆接口" });
		const session = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			fauxAssistantMessage("目录检查完成，真实服务权限尚未验证。"),
		]);
		const submitted = await fixture.request(`/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "完成项目目录检查\n约束：不要提交" }),
		});
		const run = (await submitted.json()) as { runId: string };
		await (await fixture.request(`/runs/${run.runId}/events`)).text();
		const state = (await (await fixture.request(`/sessions/${session.id}/memory`)).json()) as {
			checkpoint: WorkingCheckpoint;
			episodes: EpisodicMemory[];
		};
		expect(state.checkpoint.constraints).toContain("约束：不要提交");
		expect(state.episodes).toHaveLength(1);
		const episode = state.episodes[0];
		expect(
			(
				(await (await fixture.request(`/sessions/${session.id}/memory/episodes/${episode.id}/export`)).json()) as {
					markdown: string;
				}
			).markdown,
		).toContain("操作与证据");
		const index = episode.sources.findIndex((source) => source.piEntryId);
		expect(
			(
				(await (
					await fixture.request(`/sessions/${session.id}/memory/evidence?episodeId=${episode.id}&index=${index}`)
				).json()) as { availability: string }
			).availability,
		).toBe("present");
		const unrelated = await fixture.application.createProject({ name: "隔离项目" });
		const other = await fixture.application.createSession({ projectId: unrelated.id });
		expect((await fixture.request(`/sessions/${other.id}/memory/episodes/${episode.id}/export`)).status).toBe(404);
		const propose = async (
			text: string,
			semanticChange?: {
				operation: "supersede" | "rollback" | "invalidate";
				targetId: string;
				expectedVersion: number;
				rollbackVersion?: number;
			},
		) => {
			const response = await fixture.request("/memory/semantic/proposals", {
				method: "POST",
				body: JSON.stringify({
					kind: "project",
					projectId: project.id,
					proposedText: text,
					reason: "用户明确迁移",
					semanticChange,
				}),
			});
			expect(response.status).toBe(201);
			return response.json() as Promise<MemoryCandidate>;
		};
		const first = await propose("项目使用 Python 3.10。");
		await fixture.request(`/memory/candidates/${first.id}/accept`, { method: "POST" });
		const list = async () =>
			(await fixture.request(`/memory/semantic?projectId=${project.id}&history=true`)).json() as Promise<
				SemanticMemory[]
			>;
		const old = (await list())[0];
		const update = await propose("项目使用 Python 3.12。", {
			operation: "supersede",
			targetId: old.id,
			expectedVersion: old.version,
		});
		await fixture.request(`/memory/candidates/${update.id}/accept`, { method: "POST" });
		expect((await list()).filter((value) => value.status === "active").map((value) => value.text)).toEqual([
			"项目使用 Python 3.12。",
		]);
		expect((await fixture.request(`/memory/semantic/${old.id}/versions?projectId=${unrelated.id}`)).status).toBe(404);
		expect(
			await (await fixture.request(`/memory/semantic/${old.id}/versions?projectId=${project.id}`)).json(),
		).toHaveLength(2);
		const stale = await fixture.request("/memory/semantic/proposals", {
			method: "POST",
			body: JSON.stringify({
				kind: "project",
				projectId: project.id,
				proposedText: "项目使用 Python 3.11。",
				reason: "迟到操作",
				semanticChange: { operation: "supersede", targetId: old.id, expectedVersion: old.version },
			}),
		});
		expect(stale.status).toBe(409);
		const historical = (await list()).find((value) => value.id === old.id)!;
		const rollback = await propose("项目使用 Python 3.10。", {
			operation: "rollback",
			targetId: old.id,
			expectedVersion: historical.version,
			rollbackVersion: 1,
		});
		await fixture.request(`/memory/candidates/${rollback.id}/accept`, { method: "POST" });
		expect((await list()).filter((value) => value.status === "active").map((value) => value.text)).toEqual([
			"项目使用 Python 3.10。",
		]);
		const restored = (await list()).find((value) => value.status === "active")!;
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("memory_search", { query: "Python", layer: "all" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("memory_propose", {
					kind: "project",
					proposedText: "项目使用 Python 3.12。",
					reason: "用户明确迁移",
					semanticChange: { operation: "supersede", targetId: restored.id, expectedVersion: restored.version },
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已提出替代候选，等待审核。"),
		]);
		const toolRun = fixture.application.events.start(session.id, {
			text: "检索当前 Python 事实并提出 3.12 替代候选",
		});
		const events = [];
		for await (const event of fixture.application.events.subscribe(toolRun.runId)) events.push(event);
		expect(events.at(-1)?.event.type).toBe("run.completed");
		expect(
			events.some(
				({ event }) =>
					event.type === "tool.completed" && event.data.toolName === "memory_search" && !event.data.isError,
			),
		).toBe(true);
		const toolCandidate = (await fixture.application.services.memory.listCandidates("pending")).find(
			(candidate) => candidate.runId === toolRun.runId,
		)!;
		expect(toolCandidate.semanticChange).toMatchObject({ operation: "supersede", targetId: restored.id });
		expect((await list()).find((value) => value.status === "active")?.text).toContain("3.10");
		await expect(
			fixture.application.services.memory.propose(
				{ project },
				{
					kind: "project",
					proposedText: "无效时间候选",
					reason: "时间校验",
					semanticChange: {
						operation: "create",
						validFrom: "2030-01-01T00:00:00.000Z",
						validUntil: "2029-01-01T00:00:00.000Z",
					},
				},
			),
		).rejects.toThrow("失效时间");
		await fixture.application.services.sessions.delete(session.id);
		expect(await fixture.application.services.memoryState.episodes(other.id)).toEqual([]);
		const sameProject = await fixture.application.createSession({ projectId: project.id });
		const retained = await fixture.application.services.memoryState.episodes(sameProject.id);
		expect(
			retained[0].sources
				.filter((source) => source.kind === "tool" || source.kind === "message")
				.every((source) => source.availability === "retained_excerpt"),
		).toBe(true);
	} finally {
		await fixture.close();
	}
});
