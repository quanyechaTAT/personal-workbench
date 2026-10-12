import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { WorkbenchSession } from "@earendil-works/workbench-core";
import { expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("ordinary and project chats receive semantic titles from the full prompt; manual names persist across turns and restart", async () => {
	const generateTitle = vi.fn(async () => "修复 start.bat 启动失败");
	const fixture = await createAssistantFixture(undefined, { generateTitle });
	try {
		const project = await fixture.application.services.projects.create({ name: "标题项目" });
		for (const projectId of [undefined, project.id]) {
			let session = await fixture.application.createSession({ projectId, profileSlug: "standard" });
			expect(session.title).toBe("");
			fixture.faux.setResponses([fauxAssistantMessage("回答")]);
			const prompt = "麻烦帮我检查一下这个项目。\n双击 start.bat 后窗口立即退出，请找出原因并修复启动脚本。";
			const run = fixture.application.events.start(session.id, { text: prompt });
			for await (const _event of fixture.application.events.subscribe(run.runId)) {
			}
			await vi.waitFor(async () =>
				expect((await fixture.application.services.sessions.get(session.id)).title).toBe("修复 start.bat 启动失败"),
			);
			session = await fixture.application.services.sessions.get(session.id);
			expect(generateTitle).toHaveBeenLastCalledWith(session.runtimeSessionId, prompt, expect.any(AbortSignal));
			await fixture.application.services.sessions.rename(session.id, "我指定的名称", session.title);
			fixture.faux.setResponses([fauxAssistantMessage("后续回答")]);
			const next = fixture.application.events.start(session.id, { text: "换一个话题" });
			for await (const _event of fixture.application.events.subscribe(next.runId)) {
			}
			expect((await fixture.application.services.sessions.get(session.id)).title).toBe("我指定的名称");
		}
		expect(generateTitle).toHaveBeenCalledTimes(2);
		await fixture.restart();
		expect((await fixture.application.services.sessions.list()).map((session) => session.title)).toEqual([
			"我指定的名称",
			"我指定的名称",
		]);
	} finally {
		await fixture.close();
	}
});

test("Pi generates isolated, tool-free semantic titles without modifying the transcript or context usage", async () => {
	const fixture = await createAssistantFixture(undefined, { generateTitle: false });
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		let request: Context | undefined;
		fixture.faux.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage('{"title":"绘制鹈鹕骑行 SVG 动画"}');
			},
		]);
		const usage = await fixture.application.services.sessions.readUsage(session.id);
		const prompt = "麻烦帮我做一个页面。\nHTML 内用 SVG 实现鹈鹕骑自行车的 2D 动画，不需要测试。";
		const title = await fixture.application.runtime.generateSessionTitle!(
			session.runtimeSessionId,
			prompt,
			AbortSignal.timeout(5000),
		);
		expect(title).toBe("绘制鹈鹕骑行 SVG 动画");
		expect(request?.messages).toEqual([expect.objectContaining({ role: "user", content: prompt })]);
		expect(request?.tools ?? []).toEqual([]);
		expect(request?.systemPrompt).toContain("36");
		expect(await fixture.application.services.sessions.readTranscript(session.id)).toEqual([]);
		expect(await fixture.application.services.sessions.readUsage(session.id)).toEqual(usage);
	} finally {
		await fixture.close();
	}
});

test("Pi rejects empty, malformed, truncated and tool-calling title responses and bounds valid Unicode titles", async () => {
	const fixture = await createAssistantFixture(undefined, { generateTitle: false });
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		for (const response of [
			fauxAssistantMessage('{"title":""}'),
			fauxAssistantMessage("这是解释，不是标题数据"),
			fauxAssistantMessage('{"title":"未完成"}', { stopReason: "length" }),
			fauxAssistantMessage(fauxToolCall("powershell", { command: "never execute" }), { stopReason: "toolUse" }),
		]) {
			fixture.faux.setResponses([response]);
			expect(
				await fixture.application.runtime.generateSessionTitle!(
					session.runtimeSessionId,
					"任务",
					AbortSignal.timeout(5000),
				),
			).toBeUndefined();
		}
		fixture.faux.setResponses([fauxAssistantMessage(JSON.stringify({ title: `  **${"鹈鹕🚲".repeat(20)}**。  ` }))]);
		const title = await fixture.application.runtime.generateSessionTitle!(
			session.runtimeSessionId,
			"绘制动画",
			AbortSignal.timeout(5000),
		);
		expect(Array.from(title ?? "").length).toBeLessThanOrEqual(36);
		expect(title).not.toMatch(/[*。]|[\uD800-\uDBFF]$/u);
	} finally {
		await fixture.close();
	}
});

test("explicit initial names skip auxiliary generation", async () => {
	const generateTitle = vi.fn(async () => "绘制鹈鹕骑行 SVG 动画");
	const fixture = await createAssistantFixture(undefined, { generateTitle });
	try {
		for (const title of [undefined, "新对话"]) {
			const session = await fixture.application.createSession({ title, profileSlug: "standard" });
			fixture.faux.setResponses([fauxAssistantMessage("回答")]);
			const run = fixture.application.events.start(session.id, { text: "绘制鹈鹕骑自行车动画".repeat(20) });
			for await (const _event of fixture.application.events.subscribe(run.runId)) {
			}
			const actual = await fixture.application.services.sessions.get(session.id);
			await vi.waitFor(async () =>
				expect((await fixture.application.services.sessions.get(session.id)).title).toBe(
					title ?? "绘制鹈鹕骑行 SVG 动画",
				),
			);
			expect(actual.status).toBe("idle");
		}
		expect(generateTitle).toHaveBeenCalledTimes(1);
	} finally {
		await fixture.close();
	}
});

test("renaming during a live run wins over delayed generation and run settlement without interrupting the run", async () => {
	let finishTitle: (title: string) => void = () => undefined;
	let finishReply: () => void = () => undefined;
	const titleResult = new Promise<string>((resolve) => {
		finishTitle = resolve;
	});
	const replyReady = new Promise<void>((resolve) => {
		finishReply = resolve;
	});
	const generateTitle = vi.fn(async () => titleResult);
	const fixture = await createAssistantFixture(undefined, { generateTitle });
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			async () => {
				await replyReady;
				return fauxAssistantMessage("正常回答");
			},
		]);
		const run = fixture.application.events.start(session.id, { text: "帮我修复登录界面的错误" });
		const completed = (async () => {
			for await (const _event of fixture.application.events.subscribe(run.runId)) {
			}
		})();
		await vi.waitFor(() => expect(generateTitle).toHaveBeenCalledTimes(1));
		const before = await fixture.application.services.sessions.get(session.id);
		expect(before.status).toBe("running");
		const response = await fixture.request(`/sessions/${session.id}/title`, {
			method: "PUT",
			body: JSON.stringify({ title: "我手动指定的名称", expectedTitle: before.title }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			title: "我手动指定的名称",
			status: "running",
			model: before.model,
			lastActiveAt: before.lastActiveAt,
		});
		expect(fixture.application.services.sessions.getActiveRunId(session.id)).toBe(run.runId);
		finishTitle("修复登录错误");
		finishReply();
		await completed;
		expect(await fixture.application.services.sessions.get(session.id)).toMatchObject({
			title: "我手动指定的名称",
			status: "idle",
		});
		expect(
			(await fixture.application.services.sessions.readTranscript(session.id)).filter(
				(message) => message.role === "assistant",
			),
		).toHaveLength(1);
		const stale = await fixture.request(`/sessions/${session.id}/title`, {
			method: "PUT",
			body: JSON.stringify({ title: "旧页面覆盖", expectedTitle: before.title }),
		});
		expect(stale.status).toBe(409);
		await fixture.restart();
		expect((await fixture.application.services.sessions.get(session.id)).title).toBe("我手动指定的名称");
	} finally {
		finishTitle("延迟标题");
		finishReply();
		await fixture.close();
	}
});

test("failed auxiliary generation leaves a provisional title and never fails the conversation", async () => {
	const fixture = await createAssistantFixture(undefined, {
		generateTitle: async () => {
			throw new Error("title service unavailable");
		},
	});
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([fauxAssistantMessage("回答已完成")]);
		const run = fixture.application.events.start(session.id, { text: "排查启动错误" });
		const events = [];
		for await (const entry of fixture.application.events.subscribe(run.runId)) events.push(entry.event);
		expect(events.filter((event) => ["run.completed", "run.failed", "run.aborted"].includes(event.type))).toEqual([
			expect.objectContaining({ type: "run.completed" }),
		]);
		expect(events.some((event) => event.type === "run.failed")).toBe(false);
		expect(await fixture.application.services.sessions.get(session.id)).toMatchObject({
			title: "排查启动错误",
			status: "idle",
		});
	} finally {
		await fixture.close();
	}
});

test.each(["model", "archive"] as const)(
	"%s metadata updates preserve names saved while the runtime is awaiting",
	async (operation) => {
		let finishTitle: (title: string) => void = () => undefined;
		let finishChange: () => void = () => undefined;
		let changeStarted: () => void = () => undefined;
		const titleReady = new Promise<string>((resolve) => {
			finishTitle = resolve;
		});
		const changeReady = new Promise<void>((resolve) => {
			finishChange = resolve;
		});
		const started = new Promise<void>((resolve) => {
			changeStarted = resolve;
		});
		const fixture = await createAssistantFixture(undefined, { generateTitle: async () => titleReady });
		try {
			const session = await fixture.application.createSession({ profileSlug: "standard" });
			fixture.faux.setResponses([fauxAssistantMessage("回答已完成")]);
			const run = fixture.application.events.start(session.id, { text: "请排查启动脚本的问题" });
			for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			}
			let change: Promise<WorkbenchSession>;
			if (operation === "model") {
				const selectModel = fixture.application.runtime.selectModel.bind(fixture.application.runtime);
				vi.spyOn(fixture.application.runtime, "selectModel").mockImplementation(async (id, model) => {
					changeStarted();
					await changeReady;
					await selectModel(id, model);
				});
				expect(session.model).toBeDefined();
				change = fixture.application.services.sessions.selectModel(session.id, session.model!);
			} else {
				const releaseSession = fixture.application.runtime.releaseSession.bind(fixture.application.runtime);
				vi.spyOn(fixture.application.runtime, "releaseSession").mockImplementation(async (id) => {
					changeStarted();
					await changeReady;
					await releaseSession(id);
				});
				change = fixture.application.services.sessions.archive(session.id, true);
			}
			await started;
			const title = operation === "model" ? "用户手动设置的名称" : "修复启动脚本";
			if (operation === "model") await fixture.application.services.sessions.rename(session.id, title);
			finishTitle(title);
			await vi.waitFor(async () =>
				expect((await fixture.application.services.sessions.get(session.id)).title).toBe(title),
			);
			finishChange();
			expect((await change).title).toBe(title);
			expect((await fixture.application.services.sessions.get(session.id)).title).toBe(title);
		} finally {
			finishTitle("修复启动脚本");
			finishChange();
			await fixture.close();
		}
	},
);
