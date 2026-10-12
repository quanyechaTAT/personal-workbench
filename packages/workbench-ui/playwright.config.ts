import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	tsconfig: "./tsconfig.e2e.json",
	fullyParallel: false,
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	use: { actionTimeout: 15_000, channel: process.env.WORKBENCH_BROWSER_CHANNEL ?? "msedge", headless: true, viewport: { width: 1440, height: 960 }, screenshot: "only-on-failure", trace: "retain-on-failure" },
	reporter: "list",
});
