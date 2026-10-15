import type { IncomingMessage, ServerResponse } from "node:http";
import { memoryPolicy, WorkbenchError } from "@earendil-works/workbench-core";
import { SemanticChangeSchema } from "@earendil-works/workbench-core/contracts";
import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";
import type { WorkbenchApplication } from "./application.ts";

const Proposal = Type.Object(
	{
		kind: Type.Union([Type.Literal("user"), Type.Literal("global"), Type.Literal("project")]),
		projectId: Type.Optional(Type.String({ minLength: 1 })),
		proposedText: Type.String({ minLength: 1, maxLength: 8000 }),
		reason: Type.String({ minLength: 1, maxLength: 1000 }),
		semanticChange: Type.Optional(SemanticChangeSchema),
	},
	{ additionalProperties: false },
);

/** Called after the existing Gateway Host/origin/token guards. Never exposes provider configuration. */
export async function handleMemoryLayerRequest(
	application: WorkbenchApplication,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	route: string[],
	send: (response: ServerResponse, status: number, value: unknown) => void,
): Promise<boolean> {
	const method = request.method ?? "GET";
	if (route[0] === "sessions" && route[2] === "memory") {
		const sessionId = route[1];
		await application.services.sessions.get(sessionId);
		const state = application.services.memoryState;
		if (route[3] === "workspace" && route.length === 4 && method === "GET") {
			send(response, 200, await application.services.sessionWorkspaces.describe(sessionId));
			return true;
		}
		if (route[3] === "rebuild" && route.length === 4 && method === "POST") {
			send(response, 200, {
				indexed: await application.configure((signal) => state.rebuildVectors(sessionId, signal)),
			});
			return true;
		}
		if (method === "GET" && route.length === 3) {
			send(response, 200, {
				checkpoint: await state.checkpoint(sessionId),
				episodes: await state.episodes(sessionId, {
					query: url.searchParams.get("q") ?? undefined,
					taskId: url.searchParams.get("taskId") ?? undefined,
					from: url.searchParams.get("from") ?? undefined,
					until: url.searchParams.get("until") ?? undefined,
				}),
				actual: await application.repositories.memoryState.getContext(sessionId),
			});
			return true;
		}
		if (route[3] === "episodes" && route.length === 5 && method === "DELETE") {
			await state.deleteEpisode(route[4], sessionId);
			send(response, 200, { deleted: true });
			return true;
		}
		if (route[3] === "episodes" && route[5] === "export" && route.length === 6 && method === "GET") {
			send(response, 200, { markdown: await state.exportEpisode(route[4], sessionId) });
			return true;
		}
		if (route[3] === "evidence" && method === "GET" && route.length === 4) {
			const index = Number(url.searchParams.get("index"));
			if (!Number.isInteger(index) || index < 0 || index > 100)
				throw new WorkbenchError("invalid_input", "证据序号无效");
			send(response, 200, await state.evidence(sessionId, index, url.searchParams.get("episodeId") ?? undefined));
			return true;
		}
		if (route[3] === "retrieve" && method === "GET" && route.length === 4) {
			const controller = new AbortController();
			const cancel = () => controller.abort();
			response.once("close", cancel);
			try {
				send(
					response,
					200,
					(
						await application.services.retrieval.retrieve({
							sessionId,
							query: url.searchParams.get("q") ?? "",
							signal: controller.signal,
						})
					).memory,
				);
			} finally {
				response.off("close", cancel);
			}
			return true;
		}
		throw new WorkbenchError("not_found", "会话记忆接口不存在");
	}
	if (route[0] === "memory" && route[1] === "maintenance" && route.length === 2) {
		if (method === "POST")
			await application.configure(() => application.services.memoryMaintenance.run(true), "memory-maintenance");
		else if (method !== "GET") throw new WorkbenchError("invalid_input", "记忆维护接口不支持此方法");
		send(response, 200, {
			policy: memoryPolicy((await application.services.settings.get("memory.policy"))?.value),
			completedAt: (await application.services.settings.get("memory.maintenance.completedAt"))?.value,
		});
		return true;
	}
	if (route[0] !== "memory" || !["semantic", "cleanup"].includes(route[1])) return false;
	if (route[1] === "cleanup" && method === "POST" && route.length === 2) {
		send(response, 200, { deleted: await application.services.memoryState.cleanup(), historyRetained: true });
		return true;
	}
	const projectId = url.searchParams.get("projectId") ?? undefined;
	const project = projectId ? await application.services.projects.get(projectId) : undefined;
	const scope = { project };
	if (method === "GET" && route.length === 2) {
		await application.services.memory.refreshIndex(scope);
		send(response, 200, await application.services.semantic.list(scope, url.searchParams.get("history") === "true"));
		return true;
	}
	if (method === "GET" && route.length === 4 && route[3] === "versions") {
		send(response, 200, await application.services.semantic.history(route[2], scope));
		return true;
	}
	if (method === "POST" && route.length === 3 && route[2] === "rebuild") {
		send(response, 200, {
			indexed: await application.configure((signal) => application.services.semantic.rebuildVectors(scope, signal)),
		});
		return true;
	}
	if (method === "POST" && route.length === 3 && route[2] === "proposals") {
		let body = "";
		for await (const chunk of request) {
			body += chunk.toString();
			if (Buffer.byteLength(body) > 32000) throw new WorkbenchError("invalid_input", "语义候选超过大小上限");
		}
		let input: Static<typeof Proposal>;
		try {
			input = Parse(Proposal, JSON.parse(body));
		} catch {
			throw new WorkbenchError("invalid_input", "语义候选字段无效");
		}
		const targetProject = input.projectId ? await application.services.projects.get(input.projectId) : undefined;
		if (input.kind === "project" && !targetProject) throw new WorkbenchError("invalid_input", "项目候选必须指定项目");
		send(response, 201, await application.services.memory.propose({ project: targetProject }, input));
		return true;
	}
	throw new WorkbenchError("not_found", "语义记忆接口不存在");
}
