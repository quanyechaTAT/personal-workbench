import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: { environment: "node" },
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/workbench-core$/,
					replacement: fileURLToPath(new URL("../workbench-core/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/workbench-runtime$/,
					replacement: fileURLToPath(new URL("../workbench-runtime/src/index.ts", import.meta.url)),
				},
			],
		},
	}),
);
