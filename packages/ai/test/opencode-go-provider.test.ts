import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../src/models.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Context, Model } from "../src/types.ts";

const model: Model<"google-generative-ai"> = {
	id: "gemini-4-argon-contributor",
	name: "Gemini test model",
	api: "google-generative-ai",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

afterEach(() => vi.unstubAllGlobals());

describe("OpenCode Go Google API routing", () => {
	it.each(["stream", "streamSimple"] as const)("dispatches %s with the session header", async (method) => {
		const requests: Request[] = [];
		vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			requests.push(new Request(input, init));
			return new Response(
				`data: ${JSON.stringify({
					candidates: [{ content: { role: "model", parts: [{ text: "hello back" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
				})}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const provider: Provider = opencodeGoProvider();
		const response = await provider[method](model, context, {
			apiKey: "test-key",
			sessionId: "conversation-1",
			cacheRetention: "none",
		}).result();

		expect(response.errorMessage).toBeUndefined();
		expect(response.stopReason).toBe("stop");
		expect(response.content).toContainEqual(expect.objectContaining({ type: "text", text: "hello back" }));
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toContain("https://opencode.ai/zen/go/v1/");
		expect(requests[0].headers.get("x-opencode-session")).toBe("conversation-1");
	});
});
