// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/api.ts";
import { ChatPage } from "../src/chat-page.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

async function mountChatPage(scrollTo: () => unknown) {
	const scroll = vi.fn(scrollTo);
	Object.defineProperty(Element.prototype, "scrollTo", {
		configurable: true,
		value: scroll,
	});
	vi.spyOn(api, "projects").mockResolvedValue([]);
	vi.spyOn(api, "profiles").mockResolvedValue([]);
	vi.spyOn(api, "sessions").mockResolvedValue([]);
	vi.spyOn(api, "models").mockResolvedValue({ capabilities: {}, models: [] });
	vi.spyOn(api, "settings").mockResolvedValue([]);
	vi.spyOn(api, "approvals").mockResolvedValue([]);
	vi.spyOn(api, "chatCapabilities").mockResolvedValue({ items: [], diagnostics: [] });
	vi.spyOn(api, "commands").mockResolvedValue([]);

	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () => {
		root.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(MemoryRouter, {}, createElement(ChatPage)),
			),
		);
	});
	return {
		container,
		scroll,
		unmount: async () => {
			await act(async () => root.unmount());
			queryClient.clear();
		},
	};
}

describe("Chat lifecycle", () => {
	test("keeps session details closed until requested and returns focus when closed", async () => {
		const { container, unmount } = await mountChatPage(() => undefined);
		try {
			const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="会话详情"]');
			expect(toggle).not.toBeNull();
			expect(toggle?.getAttribute("aria-expanded")).toBe("false");
			expect(container.querySelector(".context-inspector")).toBeNull();
			await act(async () => toggle?.click());
			expect(toggle?.getAttribute("aria-expanded")).toBe("true");
			expect(container.querySelector(".context-inspector")?.textContent).toContain("上下文来源");
			await act(async () => {
				container.querySelector<HTMLButtonElement>('button[aria-label="关闭会话详情"]')?.click();
			});
			expect(container.querySelector(".context-inspector")).toBeNull();
			expect(document.activeElement).toBe(toggle);
		} finally {
			await unmount();
		}
	});

	test("does not treat the browser scroll promise as an effect cleanup", async () => {
		const { scroll, unmount } = await mountChatPage(() => Promise.resolve());
		expect(scroll).toHaveBeenCalled();
		await expect(unmount()).resolves.toBeUndefined();
	});

	test("supports browsers where scrolling returns void", async () => {
		const { scroll, unmount } = await mountChatPage(() => undefined);
		expect(scroll).toHaveBeenCalled();
		await expect(unmount()).resolves.toBeUndefined();
	});
});
