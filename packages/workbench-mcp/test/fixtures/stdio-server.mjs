import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new Server({ name: "workbench-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
server.setRequestHandler("tools/list", async () => ({ tools: [
	{ name: "echo", description: "Echo text with a structured result", inputSchema: schema },
	{ name: "fail", description: "Return a tool error", inputSchema: { type: "object" } },
	{ name: "wait", description: "Wait until cancelled", inputSchema: { type: "object" } },
] }));
server.setRequestHandler("tools/call", async (request) => {
	if (request.params.name === "fail") return { content: [{ type: "text", text: "Expected fixture failure" }], isError: true };
	if (request.params.name === "wait") await new Promise((resolve) => setTimeout(resolve, 30_000));
	const text = String(request.params.arguments?.text ?? "done");
	return { content: [{ type: "text", text }], structuredContent: { text }, isError: false };
});
await server.connect(new StdioServerTransport());
