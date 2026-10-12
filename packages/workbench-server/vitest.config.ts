import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			testTimeout: 30_000,
			// Integration files start real Pi runtimes, native SQLite and MCP subprocesses.
			// Keep files sequential; multi-session concurrency is exercised inside each fixture.
			fileParallelism: false,
			maxWorkers: 1,
			env: { PI_OFFLINE: "1" },
		},
		resolve: {
			alias: [
				{ find: /^@earendil-works\/workbench-core\/contracts$/, replacement: fileURLToPath(new URL("../workbench-core/src/contracts/index.ts", import.meta.url)) },
				{ find: /^@earendil-works\/workbench-mcp$/, replacement: fileURLToPath(new URL("../workbench-mcp/src/index.ts", import.meta.url)) },
				{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
				{
					find: /^@earendil-works\/workbench-core$/,
					replacement: fileURLToPath(new URL("../workbench-core/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/workbench-database$/,
					replacement: fileURLToPath(new URL("../workbench-database/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/workbench-runtime-pi$/,
					replacement: fileURLToPath(new URL("../workbench-runtime-pi/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/workbench-runtime$/,
					replacement: fileURLToPath(new URL("../workbench-runtime/src/index.ts", import.meta.url)),
				},
			],
		},
	}),
);
