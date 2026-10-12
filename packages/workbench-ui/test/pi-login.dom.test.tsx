// @vitest-environment jsdom

import type { ModelLoginState } from "@earendil-works/workbench-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { api, type ModelProviderDto } from "../src/api.ts";
import { ModelSettings } from "../src/model-settings.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

const provider: ModelProviderDto = {
	id: "openai-codex",
	name: "OpenAI Codex",
	source: "pi",
	baseUrl: "https://chatgpt.com/backend-api",
	api: "openai-codex-responses",
	enabled: true,
	configured: true,
	models: [],
};

async function mount(imported: boolean) {
	const catalog = vi
		.spyOn(api, "modelSettings")
		.mockResolvedValue({ version: 1, providers: imported ? [provider] : [] });
	const candidates = vi.spyOn(api, "modelCandidates").mockResolvedValue([provider]);
	vi.spyOn(api, "models").mockResolvedValue({ capabilities: {}, models: [] });
	vi.spyOn(api, "settings").mockResolvedValue([]);
	const importProvider = vi.spyOn(api, "importModelProvider").mockResolvedValue({ version: 2, providers: [provider] });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<ModelSettings />
			</QueryClientProvider>,
		),
	);
	await act(async () => vi.waitFor(() => expect(container.textContent).toContain("添加供应商")));
	const button = (label: string) => {
		const match = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === label);
		expect(match, label).toBeDefined();
		return match!;
	};
	await act(async () => button("添加供应商").click());
	return {
		container,
		catalog,
		candidates,
		importProvider,
		button,
		close: async () => {
			await act(async () => root.unmount());
			client.clear();
			container.remove();
		},
	};
}

test("reuse Pi login selects an automatically imported provider without importing it twice", async () => {
	const page = await mount(true);
	try {
		expect(page.container.textContent).not.toContain("复用 Pi 登录");
		const select = page.container.querySelector<HTMLSelectElement>('[aria-label="Pi 登录供应商"]')!;
		expect(select.querySelector('option[value="openai-codex"]')).not.toBeNull();
		await act(async () => {
			select.value = provider.id;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => page.button("使用已登录账户").click());
		await act(async () =>
			vi.waitFor(() => expect(page.container.querySelector(".provider-detail h3")?.textContent).toBe(provider.name)),
		);
		expect(page.importProvider).not.toHaveBeenCalled();
		expect(page.container.querySelector(".provider-detail h3")?.textContent).toBe(provider.name);
		expect(page.container.querySelector<HTMLInputElement>('input[placeholder="已通过 Pi 配置"]')?.disabled).toBe(
			true,
		);
	} finally {
		await page.close();
	}
});

test("refresh Pi login finds credentials added while the settings page is open", async () => {
	const page = await mount(false);
	try {
		page.candidates.mockResolvedValue([{ ...provider, id: "new-pi-login", name: "新登录" }]);
		await act(async () => page.button("刷新 Pi 登录").click());
		await act(async () =>
			vi.waitFor(() => expect(page.container.querySelector('option[value="new-pi-login"]')).not.toBeNull()),
		);
		expect(page.catalog.mock.calls.length).toBeGreaterThan(1);
		const select = page.container.querySelector<HTMLSelectElement>('[aria-label="Pi 登录供应商"]')!;
		await act(async () => {
			select.value = "new-pi-login";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => page.button("使用已登录账户").click());
		await act(async () => vi.waitFor(() => expect(page.importProvider).toHaveBeenCalled()));
		expect(page.importProvider).toHaveBeenCalledWith("new-pi-login", 1);
	} finally {
		await page.close();
	}
});

test("model token limits can be cleared and replaced without a leftover zero", async () => {
	const page = await mount(false);
	try {
		await act(async () => page.button("添加模型").click());
		for (const field of page.container.querySelectorAll<HTMLInputElement>('.model-editor input[type="number"]')) {
			await act(async () => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "");
				field.dispatchEvent(new Event("input", { bubbles: true }));
			});
			expect(field.value).toBe("");
			await act(async () => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "16384");
				field.dispatchEvent(new Event("input", { bubbles: true }));
			});
			expect(field.value).toBe("16384");
		}
	} finally {
		await page.close();
	}
});

test("add-model settings offer native Pi OAuth before login and render its provider-owned steps", async () => {
	const page = await mount(false);
	let state: ModelLoginState = {
		id: "native-login",
		providerId: provider.id,
		authType: "oauth",
		status: "waiting",
		events: [],
		prompt: {
			id: "method",
			type: "select",
			message: "选择授权方式",
			options: [
				{ id: "browser", label: "浏览器登录" },
				{ id: "device", label: "设备验证码" },
			],
		},
	};
	const start = vi.spyOn(api, "startModelLogin").mockImplementation(async () => state);
	vi.spyOn(api, "modelLogin").mockImplementation(async () => state);
	const cancel = vi.spyOn(api, "cancelModelLogin").mockImplementation(async () => ({ ...state, status: "cancelled" }));
	const answer = vi.spyOn(api, "answerModelLogin").mockImplementation(async (_id, promptId) => {
		if (promptId === "method")
			state = {
				...state,
				events: [{ type: "auth_url", url: "https://example.com/pi-authorize", instructions: "完成授权后粘贴地址" }],
				prompt: { id: "callback", type: "manual_code", message: "回调地址" },
			};
		else {
			state = { ...state, status: "succeeded", prompt: undefined };
			page.catalog.mockResolvedValue({ version: 2, providers: [provider] });
		}
		return state;
	});
	try {
		page.candidates.mockResolvedValue([
			{ ...provider, configured: false, authMethods: [{ type: "oauth", label: "ChatGPT 账户" }] },
		]);
		await act(async () => page.button("刷新 Pi 登录").click());
		await act(async () =>
			vi.waitFor(() =>
				expect(
					page.container.querySelector('[aria-label="Pi 登录供应商"] option[value="openai-codex"]'),
				).not.toBeNull(),
			),
		);
		const select = page.container.querySelector<HTMLSelectElement>('[aria-label="Pi 登录供应商"]')!;
		await act(async () => {
			select.value = provider.id;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => page.button("登录 Pi").click());
		expect(start).toHaveBeenCalledWith(provider.id, "oauth");
		await act(async () =>
			vi.waitFor(() => expect(page.container.querySelector('[aria-label="Pi 登录步骤"]')).not.toBeNull()),
		);
		const method = page.container.querySelector<HTMLSelectElement>('[aria-label="Pi 登录步骤"]')!;
		await act(async () => {
			method.value = "browser";
			method.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => method.form!.requestSubmit());
		expect(answer).toHaveBeenCalledWith(state.id, "method", "browser");
		await act(async () =>
			vi.waitFor(() =>
				expect(page.container.querySelector('a[href="https://example.com/pi-authorize"]')).not.toBeNull(),
			),
		);
		const field = page.container.querySelector<HTMLInputElement>('[aria-label="Pi 登录信息"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
				field,
				"fixture-callback-code",
			);
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => field.form!.requestSubmit());
		expect(answer).toHaveBeenCalledWith(state.id, "callback", "fixture-callback-code");
		await act(async () =>
			vi.waitFor(() => expect(page.container.querySelector(".provider-detail h3")?.textContent).toBe(provider.name)),
		);
		expect(page.container.textContent).not.toContain("fixture-callback-code");
	} finally {
		await page.close();
	}
	// The completed flow is harmless to cancel when its add-form is replaced.
	expect(cancel).toHaveBeenCalledWith("native-login");
});

test("leaving model settings cancels a pending native login", async () => {
	const page = await mount(false);
	const state: ModelLoginState = {
		id: "pending-login",
		providerId: provider.id,
		authType: "oauth",
		status: "running",
		events: [],
	};
	vi.spyOn(api, "startModelLogin").mockResolvedValue(state);
	vi.spyOn(api, "modelLogin").mockResolvedValue(state);
	const cancel = vi.spyOn(api, "cancelModelLogin").mockResolvedValue({ ...state, status: "cancelled" });
	page.candidates.mockResolvedValue([
		{ ...provider, configured: false, authMethods: [{ type: "oauth", label: "账户" }] },
	]);
	await act(async () => page.button("刷新 Pi 登录").click());
	await act(async () =>
		vi.waitFor(() =>
			expect(
				page.container.querySelector('[aria-label="Pi 登录供应商"] option[value="openai-codex"]'),
			).not.toBeNull(),
		),
	);
	const select = page.container.querySelector<HTMLSelectElement>('[aria-label="Pi 登录供应商"]')!;
	await act(async () => {
		select.value = provider.id;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await act(async () => page.button("登录 Pi").click());
	await act(async () => vi.waitFor(() => expect(page.container.textContent).toContain("取消登录")));
	await page.close();
	expect(cancel).toHaveBeenCalledWith(state.id);
});
