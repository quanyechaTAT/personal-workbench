// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { type AgentProfile, api, type Project, type WorkbenchSession } from "../src/api.ts";
import { ChatPage } from "../src/chat-page.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

const profile: AgentProfile = {
	id: "standard",
	slug: "standard",
	name: "标准助手",
	description: "",
	systemPrompt: "test",
	tools: [],
	skillIds: [],
	mcpBindings: [],
	status: "active",
	version: 1,
	isBuiltin: true,
	createdAt: "2026-10-03",
	updatedAt: "2026-10-03",
};
const projects: Project[] = ["Beta", "Empty", "Alpha"].map((name) => ({
	id: name.toLowerCase(),
	slug: name.toLowerCase(),
	name,
	description: "",
	status: "active",
	workspacePath: `F:/projects/${name}`,
	projectFilePath: "PROJECT.md",
	memoryFilePath: "MEMORY.md",
	createdAt: "2026-10-01",
	updatedAt: "2026-10-01",
}));
const sessions: WorkbenchSession[] = [
	{ id: "personal-old", title: "普通旧会话", lastActiveAt: "2026-10-01" },
	{ id: "beta-chat", title: "Beta 会话", projectId: "beta", lastActiveAt: "2026-10-03" },
	{ id: "alpha-new", title: "Alpha 新会话", projectId: "alpha", lastActiveAt: "2026-10-04" },
	{ id: "personal-new", title: "普通新会话", lastActiveAt: "2026-10-05" },
	{ id: "alpha-old", title: "Alpha 旧会话", projectId: "alpha", lastActiveAt: "2026-10-02" },
	{
		id: "alpha-archive",
		title: "Alpha 已归档",
		projectId: "alpha",
		lastActiveAt: "2026-10-06",
		archivedAt: "2026-10-06",
	},
].map((session) => ({
	...session,
	kind: session.projectId ? "project" : "personal",
	agentProfileId: profile.id,
	status: "idle",
	createdAt: "2026-10-01",
}));

async function mount() {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
	vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
	Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => undefined });
	Object.defineProperties(HTMLDialogElement.prototype, {
		showModal: {
			configurable: true,
			value(this: HTMLDialogElement) {
				this.setAttribute("open", "");
			},
		},
		close: {
			configurable: true,
			value(this: HTMLDialogElement) {
				this.removeAttribute("open");
			},
		},
	});
	let currentProjects = [...projects];
	let currentSessions = [...sessions];
	vi.spyOn(api, "profiles").mockResolvedValue([profile]);
	vi.spyOn(api, "projects").mockImplementation(async () => currentProjects);
	vi.spyOn(api, "sessions").mockImplementation(async (projectId) =>
		currentSessions.filter((session) => !projectId || session.projectId === projectId),
	);
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
	vi.spyOn(api, "settings").mockResolvedValue([]);
	vi.spyOn(api, "approvals").mockResolvedValue([]);
	vi.spyOn(api, "commands").mockResolvedValue([]);
	vi.spyOn(api, "chatCapabilities").mockResolvedValue({ items: [], diagnostics: [] });
	vi.spyOn(api, "context").mockResolvedValue({ runtime: {}, sources: [] });
	vi.spyOn(api, "transcript").mockResolvedValue([]);
	vi.spyOn(api, "permissionMode").mockResolvedValue({ mode: "ask" });
	vi.spyOn(api, "setPermissionMode").mockResolvedValue({ mode: "ask" });
	vi.spyOn(api, "startMessage").mockResolvedValue({ runId: "" });
	vi.spyOn(api, "sessionState").mockResolvedValue({ activeRunId: null });
	const requests: Array<{ signal?: AbortSignal; resolve(result: { path: string | null }): void }> = [];
	const picker = vi
		.spyOn(api, "pickProjectDirectory")
		.mockImplementation((signal) => new Promise((resolve) => requests.push({ signal, resolve })));
	const createProject = vi.spyOn(api, "createProject").mockImplementation(async ({ sourcePath }) => {
		const project: Project = { ...projects[0], id: "created", slug: "created", name: "Created", sourcePath };
		currentProjects = [...currentProjects, project];
		return project;
	});
	const createSession = vi.spyOn(api, "createSession").mockImplementation(async (input) => {
		const session: WorkbenchSession = {
			id: "created-chat",
			projectId: input.projectId,
			title: input.title ?? "新对话",
			agentProfileId: input.profileId!,
			kind: input.projectId ? "project" : "personal",
			status: "idle",
			createdAt: "2026-10-07",
			lastActiveAt: "2026-10-07",
		};
		currentSessions = [...currentSessions, session];
		return session;
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(MemoryRouter, { initialEntries: ["/chat?session=personal-old"] }, createElement(ChatPage)),
			),
		),
	);
	await act(async () => {
		await vi.waitFor(() => expect(container.querySelectorAll(".session-item")).toHaveLength(5));
	});
	const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
	return {
		container,
		client,
		requests,
		picker,
		createProject,
		createSession,
		button,
		close: async () => {
			await act(async () => root.unmount());
			client.clear();
		},
	};
}

test("ordinary chats and project chats occupy separate groups with latest activity first", async () => {
	const page = await mount();
	try {
		const ordinary = page.container.querySelector('section[aria-label="普通会话"]');
		expect(ordinary).not.toBeNull();
		expect([...ordinary!.querySelectorAll(".session-item strong")].map((item) => item.textContent)).toEqual([
			"普通新会话",
			"普通旧会话",
		]);
		const groups = [...page.container.querySelectorAll(".project-session-group")];
		expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
			"项目 Alpha",
			"项目 Beta",
			"项目 Empty",
		]);
		expect([...groups[0].querySelectorAll(".session-item strong")].map((item) => item.textContent)).toEqual([
			"Alpha 新会话",
			"Alpha 旧会话",
		]);
		expect(groups[2].textContent).toContain("暂无会话");
		expect(ordinary!.textContent).not.toContain("Alpha");
	} finally {
		await page.close();
	}
});

test("running chats allow renaming while archive and deletion remain disabled", async () => {
	const page = await mount();
	try {
		page.client.setQueryData<WorkbenchSession[]>(["sessions", undefined], (current) =>
			current?.map((session) => (session.id === "personal-old" ? { ...session, status: "running" } : session)),
		);
		await act(async () => page.button("会话操作 普通旧会话").click());
		const menu = page.container.querySelector(".session-action-menu")!;
		const buttons = [...menu.querySelectorAll("button")];
		expect(buttons.find((button) => button.textContent === "重命名会话")?.disabled).toBe(false);
		expect(buttons.find((button) => button.textContent === "归档会话")?.disabled).toBe(true);
		expect(buttons.find((button) => button.textContent === "删除会话")?.disabled).toBe(true);
		await act(async () => buttons.find((button) => button.textContent === "重命名会话")!.click());
		expect(page.container.querySelector("dialog")?.textContent).toContain("重命名会话");
	} finally {
		await page.close();
	}
});

test("archive filtering keeps each chat in its own project", async () => {
	const page = await mount();
	try {
		await act(async () =>
			[...page.container.querySelectorAll("button")].find((button) => button.textContent === "已归档")!.click(),
		);
		expect(page.container.querySelectorAll(".session-item")).toHaveLength(1);
		expect(page.container.querySelector('section[aria-label="项目 Alpha"]')?.textContent).toContain("Alpha 已归档");
		expect(page.container.querySelector('section[aria-label="普通会话"]')?.textContent).not.toContain("Alpha 已归档");
	} finally {
		await page.close();
	}
});

test("a project group prepares an unnamed draft and only creates a chat when its first message is sent", async () => {
	const page = await mount();
	try {
		expect(page.button("新建项目会话 Beta")).not.toBeNull();
		await act(async () => page.button("新建项目会话 Beta").click());
		const dialog = page.container.querySelector("dialog")!;
		expect(dialog.textContent).toContain("Beta");
		expect(dialog.querySelector("input")).toBeNull();
		const assistant = dialog.querySelector<HTMLSelectElement>('[aria-label="新会话助手"]')!;
		await act(async () => {
			assistant.value = profile.id;
			assistant.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => dialog.querySelector("form")!.requestSubmit());
		expect(page.createSession).not.toHaveBeenCalled();
		const input = page.container.querySelector<HTMLTextAreaElement>('[aria-label="消息输入"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "处理 Beta 项目");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => page.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click());
		await act(async () => {
			await vi.waitFor(() => expect(page.createSession).toHaveBeenCalled());
		});
		expect(page.createSession).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "beta", profileId: profile.id }),
		);
		expect(page.container.querySelector('section[aria-label="项目 Beta"] .session-item.selected')).not.toBeNull();
	} finally {
		await page.close();
	}
});

test("new chat in the list creates an ordinary chat even after selecting a project chat", async () => {
	const page = await mount();
	try {
		await act(async () =>
			page.container.querySelector<HTMLButtonElement>('section[aria-label="项目 Alpha"] .session-item')!.click(),
		);
		await act(async () =>
			page.container.querySelector<HTMLButtonElement>(".session-sidebar .new-chat-button")!.click(),
		);
		const dialog = page.container.querySelector("dialog")!;
		const assistant = dialog.querySelector<HTMLSelectElement>('[aria-label="新会话助手"]')!;
		await act(async () => {
			assistant.value = profile.id;
			assistant.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => dialog.querySelector("form")!.requestSubmit());
		expect(page.createSession).not.toHaveBeenCalled();
		const input = page.container.querySelector<HTMLTextAreaElement>('[aria-label="消息输入"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "普通讨论");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => page.container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click());
		await act(async () => {
			await vi.waitFor(() => expect(page.createSession).toHaveBeenCalled());
		});
		expect(page.createSession).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: undefined, profileId: profile.id }),
		);
		expect(page.container.querySelector('section[aria-label="普通会话"] .session-item.selected')).not.toBeNull();
	} finally {
		await page.close();
	}
});

test("new project chooses a native folder and offers an explicitly bound new chat", async () => {
	const page = await mount();
	try {
		expect(page.button("新建项目")).not.toBeNull();
		await act(async () => page.button("新建项目").click());
		expect(page.picker).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.waitFor(() => expect(page.button("新建项目").disabled).toBe(true));
		});
		await act(async () => page.requests[0].resolve({ path: "F:/projects/Created" }));
		await act(async () => {
			await vi.waitFor(() =>
				expect(page.container.querySelector('section[aria-label="项目 Created"]')).not.toBeNull(),
			);
		});
		expect(page.createProject).toHaveBeenCalledWith({ sourcePath: "F:/projects/Created" });
		expect(page.container.querySelector("dialog")?.textContent).toContain("Created");
	} finally {
		await page.close();
	}
});

test("cancelled or abandoned folder selection never registers a project", async () => {
	const page = await mount();
	try {
		expect(page.button("新建项目")).not.toBeNull();
		await act(async () => page.button("新建项目").click());
		await act(async () => page.requests[0].resolve({ path: null }));
		expect(page.createProject).not.toHaveBeenCalled();
		await act(async () => page.button("新建项目").click());
		await page.close();
		expect(page.requests[1].signal?.aborted).toBe(true);
		await act(async () => page.requests[1].resolve({ path: "F:/abandoned" }));
		expect(page.createProject).not.toHaveBeenCalled();
	} catch (error) {
		await page.close();
		throw error;
	}
});
