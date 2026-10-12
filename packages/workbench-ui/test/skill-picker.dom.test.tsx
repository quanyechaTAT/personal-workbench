// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../src/api.ts";
import { SkillImportDialog } from "../src/skill-import-dialog.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});
async function mount() {
	vi.spyOn(api, "projects").mockResolvedValue([]);
	const onClose = vi.fn();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(createElement(QueryClientProvider, { client }, createElement(SkillImportDialog, { onClose }))),
	);
	return {
		container,
		onClose,
		close: async () => {
			await act(async () => root.unmount());
			client.clear();
		},
	};
}
function button(container: HTMLElement, text: string) {
	const element = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
	if (!element) throw new Error(`Missing button: ${text}`);
	return element;
}
test("local skill import selects SKILL.md through a file dialog and previews its complete parent directory", async () => {
	const choose = vi
		.spyOn(api, "pickSkillFile")
		.mockResolvedValue({ path: "C:/技能/示例/SKILL.md", directory: "C:/技能/示例" });
	const inspect = vi.spyOn(api, "previewSkillImport").mockImplementation(async () => {
		throw new Error("controlled preview");
	});
	const view = await mount();
	try {
		expect(view.container.querySelector<HTMLInputElement>('[aria-label="技能文件"]')?.readOnly).toBe(true);
		expect(button(view.container, "预览导入").disabled).toBe(true);
		await act(async () => button(view.container, "选择文件…").click());
		await act(async () => {
			await vi.waitFor(() => expect(button(view.container, "预览导入").disabled).toBe(false));
		});
		expect(choose.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
		expect(view.container.querySelector<HTMLInputElement>('[aria-label="技能文件"]')?.value).toBe(
			"C:/技能/示例/SKILL.md",
		);
		await act(async () => button(view.container, "预览导入").click());
		expect(inspect).toHaveBeenCalledWith({ source: "local", location: "C:/技能/示例", scope: "global" });
	} finally {
		await view.close();
	}
});
test("cancel and unmount abort the native file dialog and ignore a late selection", async () => {
	let signal: AbortSignal | undefined;
	let finish: ((value: { path: string; directory: string }) => void) | undefined;
	vi.spyOn(api, "pickSkillFile").mockImplementation(async (current) => {
		signal = current;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	const view = await mount();
	try {
		await act(async () => button(view.container, "选择文件…").click());
		await act(async () => button(view.container, "取消").click());
		expect(signal?.aborted).toBe(true);
		expect(view.onClose).toHaveBeenCalledTimes(1);
		await act(async () => finish?.({ path: "C:/late/SKILL.md", directory: "C:/late" }));
		expect(view.container.querySelector<HTMLInputElement>('[aria-label="技能文件"]')?.value).toBe("");
		expect(button(view.container, "预览导入").disabled).toBe(true);
	} finally {
		await view.close();
	}
});
