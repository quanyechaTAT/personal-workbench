// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { ConnectionEditor } from "../src/connection-editor.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("MCP timeout can be cleared and re-entered without a leftover zero", async () => {
	const client = new QueryClient();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<ConnectionEditor onClose={() => undefined} />
				</QueryClientProvider>,
			),
		);
		const field = container.querySelector<HTMLInputElement>('input[type="number"]')!;
		for (const text of ["", "15"]) {
			await act(async () => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
				field.dispatchEvent(new Event("input", { bubbles: true }));
			});
			expect(field.value).toBe(text);
		}
	} finally {
		await act(async () => root.unmount());
		client.clear();
		container.remove();
	}
});
