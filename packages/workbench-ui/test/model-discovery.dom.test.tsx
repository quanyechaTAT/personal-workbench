// @vitest-environment jsdom

import type { DiscoveredModelCatalog } from "@earendil-works/workbench-runtime";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { api } from "../src/api.ts";
import { ModelDiscovery } from "../src/model-discovery.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("a delayed model list cannot overwrite a result for an edited provider address", async () => {
	let resolveOld: (value: DiscoveredModelCatalog) => void = () => undefined;
	const oldResult = new Promise<DiscoveredModelCatalog>((resolve) => {
		resolveOld = resolve;
	});
	const discovery = vi
		.spyOn(api, "discoverModels")
		.mockReturnValueOnce(oldResult)
		.mockResolvedValueOnce({
			endpoint: "https://new.example/v1/models",
			models: [{ modelId: "new-model", name: "新供应商模型" }],
			warnings: [],
		});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const render = async (baseUrl: string) =>
		act(async () =>
			root.render(
				<ModelDiscovery
					baseUrl={baseUrl}
					apiFormat="openai-responses"
					apiKey="fixture-key"
					models={[]}
					nativeCandidates={[]}
					pending={false}
					onAdd={() => undefined}
				/>,
			),
		);
	const fetchButton = () => container.querySelector<HTMLButtonElement>("button")!;
	try {
		await render("https://old.example/v1");
		await act(async () => {
			fetchButton().click();
		});
		expect(fetchButton().disabled).toBe(true);
		await render("https://new.example/v1");
		expect(fetchButton().disabled).toBe(false);
		await act(async () => {
			fetchButton().click();
		});
		expect(container.textContent).toContain("新供应商模型");
		await act(async () =>
			resolveOld({
				endpoint: "https://old.example/v1/models",
				models: [{ modelId: "old-model", name: "过期模型" }],
				warnings: [],
			}),
		);
		expect(container.textContent).toContain("新供应商模型");
		expect(container.textContent).not.toContain("过期模型");
		expect(discovery.mock.calls[1]?.[0].baseUrl).toBe("https://new.example/v1");
	} finally {
		await act(async () => root.unmount());
		discovery.mockRestore();
		container.remove();
	}
});
