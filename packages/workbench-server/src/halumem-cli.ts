import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfiguredModelSchema } from "@earendil-works/workbench-core/contracts";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { HaluMemServer } from "./halumem-server.ts";
import { HaluMemService } from "./halumem-service.ts";

try {
	process.loadEnvFile();
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const sourceUrl = new URL(process.env.HALUMEM_WORKBENCH_URL ?? "http://127.0.0.1:4242");
if (sourceUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(sourceUrl.hostname))
	throw new Error("The model source must be a local Workbench instance");
const sourceToken = process.env.HALUMEM_WORKBENCH_TOKEN;
const token = process.env.HALUMEM_API_TOKEN;
if (!sourceToken || !token)
	throw new Error("Set HALUMEM_WORKBENCH_TOKEN and HALUMEM_API_TOKEN before starting evaluation");
const response = await fetch(new URL("/api/v1/models/providers", sourceUrl), {
	headers: { authorization: `Bearer ${sourceToken}` },
	signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error(`Cannot read the configured model from Workbench (${response.status})`);
const catalog = Parse(
	Type.Object(
		{
			providers: Type.Array(
				Type.Object(
					{
						id: Type.String(),
						name: Type.String(),
						baseUrl: Type.String(),
						api: Type.String(),
						models: Type.Array(ConfiguredModelSchema),
					},
					{ additionalProperties: true },
				),
			),
		},
		{ additionalProperties: true },
	),
	await response.json(),
);
const provider = catalog.providers.find((entry) => entry.id === "openai-codex");
const model = provider?.models.find((entry) => entry.modelId === "gpt-6-luna" && entry.enabled);
if (!provider || !model) throw new Error("Enable openai-codex/gpt-6-luna in the source Workbench first");
const prompts = JSON.parse(
	await readFile(resolve(process.env.HALUMEM_PROMPTS ?? ".cache/halumem/prompts.json"), "utf8"),
) as { PROMPT_MEMZERO?: string };
if (!prompts.PROMPT_MEMZERO?.includes("{context}") || !prompts.PROMPT_MEMZERO.includes("{question}"))
	throw new Error("Fetch the pinned official HaluMem QA prompt first");
const service = new HaluMemService({
	root: resolve(process.env.HALUMEM_DATA_ROOT ?? ".cache/halumem/state"),
	agentDir: process.env.HALUMEM_AGENT_DIR,
	embeddingEnvFile: process.env.HALUMEM_EMBEDDING_ENV_FILE,
	qaPrompt: prompts.PROMPT_MEMZERO,
	onQuotaExhausted: () => console.error("HaluMem evaluated model quota exhausted"),
	provider: { name: provider.name, baseUrl: provider.baseUrl, api: provider.api, enabled: true, models: [model] },
});
const server = new HaluMemServer(service, token);
const port = Number(process.env.HALUMEM_PORT ?? 4243);
if (!Number.isInteger(port) || port < 0 || port > 65535)
	throw new Error("HALUMEM_PORT must be an integer from 0 to 65535");
console.log(`HaluMem evaluation API: ${await server.start(port)}; target=openai-codex/gpt-6-luna`);
let closing = false;
const close = () => {
	if (closing) return;
	closing = true;
	void server.close().then(
		() => process.exit(0),
		() => process.exit(1),
	);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
