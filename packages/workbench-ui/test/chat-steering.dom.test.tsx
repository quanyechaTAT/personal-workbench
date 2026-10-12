// @vitest-environment jsdom

import type { DevelopmentState } from "@earendil-works/workbench-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { type AgentStreamEvent, api } from "../src/api.ts";
import { ChatPage } from "../src/chat-page.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

class TestEventSource {
	static CLOSED = 2;
	static current: TestEventSource;
	readyState = 1;
	onerror?: () => void;
	private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
	constructor() {
		TestEventSource.current = this;
	}
	addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
		this.listeners.set(name, listener);
	}
	close() {
		this.readyState = TestEventSource.CLOSED;
	}
	emit(event: AgentStreamEvent) {
		this.listeners.get(event.type)?.(new MessageEvent(event.type, { data: JSON.stringify(event) }));
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

async function mountRunningChat(response: () => Promise<Response>, development?: DevelopmentState) {
	vi.stubGlobal("EventSource", TestEventSource);
	vi.stubGlobal("fetch", vi.fn(response));
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
	vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
	Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => undefined });
	vi.spyOn(api, "projects").mockResolvedValue([]);
	vi.spyOn(api, "profiles").mockResolvedValue([]);
	vi.spyOn(api, "sessions").mockResolvedValue([
		{
			id: "session-1",
			agentProfileId: "profile",
			title: "运行中",
			kind: "personal",
			status: "running",
			createdAt: "2026-10-02T00:00:00Z",
			lastActiveAt: "2026-10-02T00:00:00Z",
			model: { provider: "fixture", modelId: "test" },
		},
	]);
	vi.spyOn(api, "models").mockResolvedValue({
		capabilities: { steering: true },
		models: [
			{
				provider: "fixture",
				modelId: "test",
				name: "Fixture",
				available: true,
				reasoning: false,
				contextWindow: 10000,
				maxTokens: 1000,
			},
		],
	});
	vi.spyOn(api, "settings").mockResolvedValue([]);
	vi.spyOn(api, "approvals").mockResolvedValue([]);
	vi.spyOn(api, "chatCapabilities").mockResolvedValue({ items: [], diagnostics: [] });
	vi.spyOn(api, "commands").mockResolvedValue([]);
	vi.spyOn(api, "transcript").mockResolvedValue([]);
	vi.spyOn(api, "context").mockResolvedValue({ runtime: {}, sources: [] });
	vi.spyOn(api, "permissionMode").mockResolvedValue({ mode: "ask" });
	vi.spyOn(api, "sessionState").mockResolvedValue({ activeRunId: "run-1", ...(development ? { development } : {}) });
	const abort = vi.spyOn(api, "abort").mockResolvedValue({ status: "aborting" });
	const startMessage = vi.spyOn(api, "startMessage");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(
					MemoryRouter,
					{ initialEntries: ["/chat?session=session-1&run=run-1"] },
					createElement(ChatPage),
				),
			),
		),
	);
	await act(async () => {
		await vi.waitFor(() => expect(container.querySelector('[aria-label="停止执行"]')).not.toBeNull());
	});
	return {
		container,
		queryClient,
		abort,
		startMessage,
		unmount: async () => {
			await act(async () => root.unmount());
			queryClient.clear();
		},
	};
}

async function enterAndSubmit(container: HTMLElement, text: string, steer = true) {
	const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入"]')!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		if (steer) container.querySelector<HTMLButtonElement>('[aria-label="立即纠偏"]')!.click();
		else input.form!.requestSubmit();
	});
	return input;
}

test("restoring an expired stream silently refreshes history and keeps execution and real errors visible", async () => {
	const chat = await mountRunningChat(async () => new Response("{}"));
	try {
		const source = TestEventSource.current;
		vi.mocked(api.transcript).mockResolvedValue([
			{
				id: "saved-reply",
				role: "assistant",
				timestamp: "2026-10-02T00:00:01Z",
				content: [{ type: "text", text: "已保存的回复" }],
			},
		]);
		await act(async () => {
			source.emit({ type: "stream.reset", data: { reason: "buffer_exhausted" } });
		});
		await act(async () => {
			await vi.waitFor(() => expect(chat.container.textContent).toContain("已保存的回复"));
		});
		expect(chat.container.textContent).not.toContain("连接已恢复");
		expect(chat.container.querySelector(".error-notice")).toBeNull();
		expect(chat.container.querySelector(".toolbar-state")?.textContent).toBe("执行中");
		expect(source.readyState).toBe(1);
		expect(chat.abort).not.toHaveBeenCalled();
		await act(async () => {
			source.emit({
				id: "continued-reply",
				type: "message.text.delta",
				sessionId: "session-1",
				runId: "run-1",
				occurredAt: "2026-10-02T00:00:02Z",
				data: { messageId: "continued", contentIndex: 0, delta: "恢复后继续输出" },
			});
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		});
		expect(chat.container.textContent).toContain("恢复后继续输出");
		await act(async () => {
			source.emit({
				id: "real-failure",
				type: "run.failed",
				sessionId: "session-1",
				runId: "run-1",
				occurredAt: "2026-10-02T00:00:03Z",
				data: { code: "runtime_failure", message: "模型服务不可用" },
			});
		});
		expect(chat.container.textContent).toContain("模型服务不可用");
	} finally {
		await chat.unmount();
	}
});

test("submitting during execution steers the existing run and leaves Stop and streaming active", async () => {
	const chat = await mountRunningChat(async () => new Response(JSON.stringify({ runId: "run-1" })));
	try {
		expect(chat.container.querySelector('[aria-label="立即纠偏"]')).not.toBeNull();
		const source = TestEventSource.current;
		const input = await enterAndSubmit(chat.container, "只修改启动脚本");
		expect(fetch).toHaveBeenCalledWith(
			"/api/v1/sessions/session-1/steer",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ runId: "run-1", text: "只修改启动脚本" }),
			}),
		);
		expect(input.value).toBe("");
		expect(chat.abort).not.toHaveBeenCalled();
		expect(chat.startMessage).not.toHaveBeenCalled();
		expect(TestEventSource.current).toBe(source);
		expect(source.readyState).toBe(1);
		expect(chat.container.querySelector(".toolbar-state")?.textContent).toBe("执行中");
		await act(async () => {
			source.emit({
				id: "queued",
				type: "input.queue",
				sessionId: "session-1",
				runId: "run-1",
				occurredAt: "2026-10-02T00:00:01Z",
				data: { steering: ["只修改启动脚本"] },
			});
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		});
		expect(chat.container.querySelector('[aria-label="等待送达的指令"]')?.textContent).toContain("只修改启动脚本");
		await act(async () => {
			source.emit({
				id: "delivered-queue",
				type: "input.queue",
				sessionId: "session-1",
				runId: "run-1",
				occurredAt: "2026-10-02T00:00:02Z",
				data: { steering: [] },
			});
			source.emit({
				id: "delivered-input",
				type: "message.started",
				sessionId: "session-1",
				runId: "run-1",
				occurredAt: "2026-10-02T00:00:02Z",
				data: { messageId: "correction", role: "user", text: "只修改启动脚本", steering: true },
			});
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		});
		expect(chat.container.querySelector('[aria-label="等待送达的指令"]')).toBeNull();
		expect(chat.container.querySelector(".steering-message")?.textContent).toContain("已送达");
		expect(chat.container.querySelector(".steering-message")?.textContent).toContain("只修改启动脚本");
		await act(async () => chat.container.querySelector<HTMLButtonElement>('[aria-label="停止执行"]')!.click());
		expect(chat.abort).toHaveBeenCalledWith("session-1");
	} finally {
		await chat.unmount();
	}
});

test("a rejected correction preserves its draft and the current event stream", async () => {
	const chat = await mountRunningChat(
		async () =>
			new Response(JSON.stringify({ error: { code: "conflict", message: "当前任务已结束" } }), { status: 409 }),
	);
	try {
		const source = TestEventSource.current;
		const input = await enterAndSubmit(chat.container, "保留待发送指令");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("保留待发送指令");
		expect(chat.container.textContent).toContain("当前任务已结束");
		expect(source.readyState).toBe(1);
		expect(chat.container.querySelector(".toolbar-state")?.textContent).toBe("执行中");
	} finally {
		await chat.unmount();
	}
});

test("Enter queues the next request and the dock supports editing, removing and promoting occurrences", async () => {
	const queued = { revision: 1, steering: [], followUp: [{ id: "item-1", text: "下一项任务" }] };
	const chat = await mountRunningChat(async () => new Response(JSON.stringify(queued)));
	const update = vi.spyOn(api, "updateQueuedMessage").mockResolvedValue(queued);
	try {
		const input = await enterAndSubmit(chat.container, "下一项任务", false);
		expect(fetch).toHaveBeenCalledWith(
			"/api/v1/sessions/session-1/queue",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ runId: "run-1", text: "下一项任务" }),
			}),
		);
		expect(input.value).toBe("");
		await act(async () =>
			vi.waitFor(() => expect(chat.container.querySelector('[aria-label="排队消息"]')).not.toBeNull()),
		);
		const click = async (name: string) => {
			await act(async () => chat.container.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!.click());
		};
		await click("编辑排队消息");
		const editor = chat.container.querySelector<HTMLTextAreaElement>('[aria-label="编辑消息内容"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "修改后的任务");
			editor.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await click("保存排队消息");
		expect(update).toHaveBeenLastCalledWith("session-1", "run-1", "item-1", { kind: "edit", text: "修改后的任务" });
		await click("删除排队消息");
		expect(update).toHaveBeenLastCalledWith("session-1", "run-1", "item-1", { kind: "remove" });
		await click("立即发送排队消息");
		expect(update).toHaveBeenLastCalledWith("session-1", "run-1", "item-1", { kind: "steer" });
		expect(chat.abort).not.toHaveBeenCalled();
		expect(chat.startMessage).not.toHaveBeenCalled();
	} finally {
		await chat.unmount();
	}
});

test("accepting a correction preserves text typed while its request was pending", async () => {
	let resolveResponse: ((response: Response) => void) | undefined;
	const response = new Promise<Response>((resolve) => {
		resolveResponse = resolve;
	});
	const chat = await mountRunningChat(() => response);
	try {
		const input = await enterAndSubmit(chat.container, "第一条追加指令");
		await act(async () => {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		});
		expect(chat.container.querySelector<HTMLButtonElement>('[aria-label="立即纠偏"]')?.disabled).toBe(true);
		expect(chat.container.querySelector<HTMLButtonElement>('[aria-label="停止执行"]')?.disabled).toBe(false);
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "下一条草稿");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			resolveResponse?.(new Response(JSON.stringify({ runId: "run-1" })));
		});
		expect(input.value).toBe("下一条草稿");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(chat.container.querySelector(".toolbar-state")?.textContent).toBe("执行中");
	} finally {
		resolveResponse?.(new Response(JSON.stringify({ runId: "run-1" })));
		await chat.unmount();
	}
});

test("internal development evidence stays hidden after restore and streaming updates", async () => {
	const development: DevelopmentState = {
		runId: "run-1",
		revision: 0,
		requiresAcceptance: true,
		acceptance: { status: "pending", reason: "等待验收", criteria: [] },
		plan: [{ step: "修复启动", status: "completed" }],
		changedFiles: ["start.bat"],
		checks: [
			{ id: "check", command: "node test.mjs", status: "passed", exitCode: 0, output: "checks passed", revision: 0 },
		],
	};
	const chat = await mountRunningChat(async () => new Response("{}"), development);
	try {
		expect(chat.container.querySelector('[aria-label="开发流程"]')).toBeNull();
		await act(async () => {
			TestEventSource.current.emit({
				id: "stale-check",
				type: "development.updated",
				sessionId: "session-1",
				runId: "run-1",
				occurredAt: "2026-10-02T00:00:04Z",
				data: { ...development, checks: [{ ...development.checks[0], status: "stale" }] },
			});
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		});
		expect(chat.container.querySelector('[aria-label="开发流程"]')).toBeNull();
		expect(chat.container.textContent).not.toContain("需要重新验证");
		expect(chat.container.textContent).not.toContain("start.bat");
	} finally {
		await chat.unmount();
	}
});

test("unverified internal development states never create user-facing panels", async () => {
	const chat = await mountRunningChat(async () => new Response("{}"), {
		runId: "run-1",
		revision: 0,
		requiresAcceptance: true,
		acceptance: { status: "needs_verification", reason: "尚未运行检查", criteria: [] },
		plan: [{ step: "修改代码", status: "completed" }],
		changedFiles: ["app.ts"],
		checks: [],
	});
	try {
		expect(chat.container.querySelector('[aria-label="开发流程"]')).toBeNull();
		expect(chat.container.textContent).not.toContain("尚未运行检查");
	} finally {
		await chat.unmount();
	}
});

test("permission switching during execution updates the saved mode without interrupting the stream", async () => {
	vi.spyOn(window, "confirm").mockReturnValue(true);
	const save = vi.spyOn(api, "setPermissionMode").mockResolvedValue({ mode: "full-access" });
	const chat = await mountRunningChat(async () => new Response("{}"));
	try {
		const source = TestEventSource.current;
		const select = chat.container.querySelector<HTMLSelectElement>('[aria-label="权限模式"]')!;
		await act(async () => {
			await vi.waitFor(() => expect(select.disabled).toBe(false));
		});
		await act(async () => {
			select.value = "full-access";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			await vi.waitFor(() => expect(select.value).toBe("full-access"));
		});
		expect(save).toHaveBeenCalledWith("session-1", "full-access");
		expect(chat.queryClient.getQueryData(["permission-mode", "session-1"])).toEqual({ mode: "full-access" });
		expect(chat.container.textContent).toContain("权限已切换");
		expect(chat.abort).not.toHaveBeenCalled();
		expect(chat.startMessage).not.toHaveBeenCalled();
		expect(TestEventSource.current).toBe(source);
		expect(source.readyState).toBe(1);
		expect(chat.container.querySelector<HTMLButtonElement>('[aria-label="停止执行"]')?.disabled).toBe(false);
	} finally {
		await chat.unmount();
	}
});

test("declining full access leaves the existing permission and running stream unchanged", async () => {
	vi.spyOn(window, "confirm").mockReturnValue(false);
	const save = vi.spyOn(api, "setPermissionMode");
	const chat = await mountRunningChat(async () => new Response("{}"));
	try {
		const source = TestEventSource.current;
		const select = chat.container.querySelector<HTMLSelectElement>('[aria-label="权限模式"]')!;
		await act(async () => {
			await vi.waitFor(() => expect(select.disabled).toBe(false));
		});
		await act(async () => {
			select.value = "full-access";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(save).not.toHaveBeenCalled();
		expect(select.value).toBe("ask");
		expect(source.readyState).toBe(1);
	} finally {
		await chat.unmount();
	}
});

test.each(["resolved", "rejected"] as const)(
	"a late %s permission request stays scoped to its original session",
	async (outcome) => {
		let resolveMode: ((value: { mode: "auto" }) => void) | undefined;
		let rejectMode: ((error: Error) => void) | undefined;
		const result = new Promise<{ mode: "auto" }>((resolve, reject) => {
			resolveMode = resolve;
			rejectMode = reject;
		});
		vi.spyOn(api, "setPermissionMode").mockReturnValue(result);
		const chat = await mountRunningChat(async () => new Response("{}"));
		try {
			const select = chat.container.querySelector<HTMLSelectElement>('[aria-label="权限模式"]')!;
			await act(async () => {
				await vi.waitFor(() => expect(select.disabled).toBe(false));
			});
			await act(async () => {
				select.value = "auto";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			});
			expect(select.value).toBe("ask");
			await act(async () => {
				const sessions = await api.sessions();
				vi.mocked(api.sessions).mockResolvedValue([
					...sessions,
					{ ...sessions[0], id: "session-2", title: "另一会话", status: "idle" },
				]);
				vi.mocked(api.sessionState).mockResolvedValue({ activeRunId: null });
				await chat.queryClient.invalidateQueries({ queryKey: ["sessions"] });
			});
			await act(async () => {
				await vi.waitFor(() =>
					expect(chat.container.querySelector('[aria-label="切换会话"] option[value="session-2"]')).not.toBeNull(),
				);
			});
			await act(async () => {
				const sessions = chat.container.querySelector<HTMLSelectElement>('[aria-label="切换会话"]')!;
				sessions.value = "session-2";
				sessions.dispatchEvent(new Event("change", { bubbles: true }));
			});
			expect(chat.container.querySelector<HTMLSelectElement>('[aria-label="切换会话"]')?.value).toBe("session-2");
			await act(async () => {
				if (outcome === "resolved") resolveMode?.({ mode: "auto" });
				else rejectMode?.(new Error("原会话权限保存失败"));
			});
			await act(async () => {
				await vi.waitFor(() => expect(select.disabled).toBe(false));
			});
			expect(select.value).toBe("ask");
			expect(chat.queryClient.getQueryData(["permission-mode", "session-2"])).toEqual({ mode: "ask" });
			expect(chat.container.textContent).not.toContain("权限已切换");
			expect(chat.container.textContent).not.toContain("原会话权限保存失败");
			if (outcome === "resolved")
				expect(chat.queryClient.getQueryData(["permission-mode", "session-1"])).toEqual({ mode: "auto" });
		} finally {
			resolveMode?.({ mode: "auto" });
			await chat.unmount();
		}
	},
);

test("a failed permission save preserves its previous mode and leaves Stop available", async () => {
	vi.spyOn(api, "setPermissionMode").mockRejectedValue(new Error("权限保存失败"));
	const chat = await mountRunningChat(async () => new Response("{}"));
	try {
		const source = TestEventSource.current;
		const select = chat.container.querySelector<HTMLSelectElement>('[aria-label="权限模式"]')!;
		await act(async () => {
			await vi.waitFor(() => expect(select.disabled).toBe(false));
		});
		await act(async () => {
			select.value = "auto";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			await vi.waitFor(() => expect(chat.container.textContent).toContain("权限保存失败"));
		});
		expect(select.value).toBe("ask");
		expect(source.readyState).toBe(1);
		await act(async () => chat.container.querySelector<HTMLButtonElement>('[aria-label="停止执行"]')!.click());
		expect(chat.abort).toHaveBeenCalledWith("session-1");
	} finally {
		await chat.unmount();
	}
});
