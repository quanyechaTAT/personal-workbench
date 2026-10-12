// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { type AgentProfile, api } from "../src/api.ts";
import { ChatPage } from "../src/chat-page.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});
const profiles: AgentProfile[] = ["standard", "ptc"].map((slug) => ({
	id: slug,
	slug,
	name: slug,
	description: "",
	systemPrompt: "test",
	tools: [],
	skillIds: [],
	mcpBindings: [],
	status: "active",
	version: 1,
	isBuiltin: true,
	createdAt: "2026-10-02",
	updatedAt: "2026-10-02",
}));
async function mount(existing = false) {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
	vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
	Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => undefined });
	vi.spyOn(api, "profiles").mockResolvedValue(profiles);
	vi.spyOn(api, "projects").mockResolvedValue([]);
	const session = {
		id: "chat",
		agentProfileId: "standard",
		title: "原会话",
		kind: "personal" as const,
		status: "idle" as const,
		createdAt: "2026-10-02",
		lastActiveAt: "2026-10-02",
	};
	vi.spyOn(api, "sessions").mockResolvedValue(existing ? [session] : []);
	vi.spyOn(api, "models").mockResolvedValue({
		capabilities: {},
		models: [
			{
				provider: "test",
				modelId: "test",
				name: "test",
				available: true,
				reasoning: false,
				contextWindow: 10000,
				maxTokens: 1000,
			},
		],
	});
	vi.spyOn(api, "settings").mockResolvedValue([{ key: "agent.defaultProfileId", value: "standard", version: 1 }]);
	vi.spyOn(api, "approvals").mockResolvedValue([]);
	vi.spyOn(api, "chatCapabilities").mockResolvedValue({ items: [], diagnostics: [] });
	vi.spyOn(api, "commands").mockResolvedValue([
		{ name: "compact", action: "compact", description: "压缩上下文", requiresSession: true },
	]);
	vi.spyOn(api, "transcript").mockResolvedValue([
		{ id: "user", role: "user", content: [{ type: "text", text: "已有历史" }], timestamp: "2026-10-02" },
	]);
	vi.spyOn(api, "context").mockResolvedValue({ runtime: {}, sources: [] });
	vi.spyOn(api, "permissionMode").mockResolvedValue({ mode: "ask" });
	vi.spyOn(api, "sessionState").mockResolvedValue({
		activeRunId: null,
		usage: {
			turns: 1,
			steps: 1,
			tokens: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2100, cost: 0 },
			llmMs: 0,
			decodeMs: 0,
			decodeTokens: 0,
			firstTokenMs: 0,
			timedSteps: 0,
			incomplete: false,
			contextTokens: 2100,
			contextWindow: 10000,
		},
	});
	const create = vi.spyOn(api, "createSession");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(
					MemoryRouter,
					{ initialEntries: [existing ? "/chat?session=chat" : "/chat"] },
					createElement(ChatPage),
				),
			),
		),
	);
	await act(async () => {
		await vi.waitFor(() => expect(container.querySelector('[aria-label="助手"] option[value="ptc"]')).not.toBeNull());
	});
	return {
		container,
		client,
		session,
		create,
		close: async () => {
			await act(async () => root.unmount());
			client.clear();
		},
	};
}
test("a new chat starts without a default assistant and cannot send until one is selected", async () => {
	const chat = await mount();
	try {
		const assistant = chat.container.querySelector<HTMLSelectElement>('[aria-label="助手"]')!;
		expect(assistant.value).toBe("");
		expect(assistant.textContent).not.toContain("默认助手");
		expect(chat.container.querySelector<HTMLSelectElement>('[aria-label="项目"]')?.value).toBe("");
		expect(chat.container.textContent).not.toContain("个人工作区");
		const input = chat.container.querySelector<HTMLTextAreaElement>('[aria-label="消息输入"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "测试");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(chat.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(true);
		await act(async () => {
			assistant.value = "ptc";
			assistant.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(input.value).toBe("测试");
		expect(chat.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(false);
		expect(chat.create).not.toHaveBeenCalled();
	} finally {
		await chat.close();
	}
});

test("compact shortcut uses the session command and refreshes context statistics", async () => {
	const compact = vi.spyOn(api, "sessionCommand").mockResolvedValue({
		type: "compaction",
		tokensBefore: 2100,
		estimatedTokensAfter: 500,
		summary: "保留任务目标和进度",
	});
	const chat = await mount(true);
	try {
		const button = chat.container.querySelector<HTMLButtonElement>(".usage-compact")!;
		expect(button.disabled).toBe(false);
		await act(async () => {
			button.click();
		});
		expect(compact).toHaveBeenCalledWith(
			"chat",
			{ name: "compact", instructions: undefined },
			expect.any(AbortSignal),
		);
		expect(chat.container.textContent).toContain("已压缩上下文：2100 → 500 Token");
		expect(chat.create).not.toHaveBeenCalled();
	} finally {
		await chat.close();
	}
});
test("changing assistant preserves the selected conversation and its history", async () => {
	const select = vi.spyOn(api, "selectAssistant").mockImplementation(async (_id, profileId) => ({
		id: "chat",
		agentProfileId: profileId,
		title: "原会话",
		kind: "personal",
		status: "idle",
		createdAt: "2026-10-02",
		lastActiveAt: "2026-10-02",
	}));
	const chat = await mount(true);
	try {
		const assistant = chat.container.querySelector<HTMLSelectElement>('[aria-label="助手"]')!;
		await act(async () => {
			assistant.value = "ptc";
			assistant.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(select).toHaveBeenCalledWith("chat", "ptc", "standard");
		expect(chat.container.querySelector<HTMLSelectElement>('[aria-label="切换会话"]')?.value).toBe("chat");
		expect(chat.container.textContent).toContain("已有历史");
		expect(chat.create).not.toHaveBeenCalled();
	} finally {
		await chat.close();
	}
});
