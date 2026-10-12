// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../src/api.ts";
import { ProjectsPage } from "../src/projects-page.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

async function mountProjects() {
	vi.spyOn(api, "projects").mockResolvedValue([]);
	const requests: Array<{ signal?: AbortSignal; resolve(value: { path: string | null }): void }> = [];
	const picker = vi
		.spyOn(api, "pickProjectDirectory")
		.mockImplementation((signal) => new Promise((resolve) => requests.push({ signal, resolve })));
	const create = vi.spyOn(api, "createProject");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			createElement(QueryClientProvider, { client }, createElement(MemoryRouter, {}, createElement(ProjectsPage))),
		),
	);
	const button = (text: string) =>
		[...container.querySelectorAll("button")].find((element) => element.textContent === text)!;
	return {
		container,
		requests,
		picker,
		create,
		button,
		unmount: async () => {
			await act(async () => root.unmount());
			client.clear();
		},
	};
}

test("opening a project immediately selects a folder, prevents duplicate pickers and aborts on Cancel", async () => {
	const page = await mountProjects();
	try {
		await act(async () => page.button("打开文件夹为项目").click());
		expect(page.picker).toHaveBeenCalledTimes(1);
		expect(page.button("打开文件夹为项目").disabled).toBe(true);
		expect(page.button("正在选择…").disabled).toBe(true);
		expect(page.container.textContent).toContain("请在系统弹窗中选择文件夹");
		expect(page.requests[0].signal?.aborted).toBe(false);
		await act(async () => page.button("取消").click());
		expect(page.requests[0].signal?.aborted).toBe(true);
		expect(page.container.querySelector("form")).toBeNull();
		await act(async () => page.requests[0].resolve({ path: "F:\\stale-project" }));
		await act(async () => page.button("打开文件夹为项目").click());
		expect(page.picker).toHaveBeenCalledTimes(2);
		expect(page.container.querySelector<HTMLInputElement>("input")?.value).toBe("");
		expect(page.create).not.toHaveBeenCalled();
	} finally {
		await page.unmount();
	}
});

test("reselecting a folder disables project creation until the new selection completes", async () => {
	const page = await mountProjects();
	try {
		await act(async () => page.button("打开文件夹为项目").click());
		await act(async () => page.requests[0].resolve({ path: "F:\\first-project" }));
		await act(async () => {
			await vi.waitFor(() => expect(page.button("创建项目").disabled).toBe(false));
		});
		expect(page.container.querySelector<HTMLInputElement>("input")?.value).toBe("F:\\first-project");
		await act(async () => page.button("浏览文件夹…").click());
		expect(page.button("创建项目").disabled).toBe(true);
		await act(async () => page.container.querySelector("form")!.requestSubmit());
		expect(page.create).not.toHaveBeenCalled();
		await act(async () => page.requests[1].resolve({ path: null }));
		await act(async () => {
			await vi.waitFor(() => expect(page.button("浏览文件夹…").disabled).toBe(false));
		});
		expect(page.button("创建项目").disabled).toBe(true);
		expect(page.container.querySelector<HTMLInputElement>("input")?.value).toBe("");
	} finally {
		await page.unmount();
	}
});

test("leaving the project page aborts its pending native folder dialog", async () => {
	const page = await mountProjects();
	await act(async () => page.button("打开文件夹为项目").click());
	await page.unmount();
	expect(page.requests[0].signal?.aborted).toBe(true);
});
