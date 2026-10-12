import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createModelDataManifest } from "../packages/ai/scripts/model-data.ts";

function withLauncherFixture(dataState, verify, beforeLaunch = () => {}) {
	const root = mkdtempSync(join(tmpdir(), "workbench-launcher 中文 "));
	const write = (path, content = "") => {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	};
	try {
		write("package.json", JSON.stringify({
			name: "workbench-launcher-fixture",
			private: true,
			type: "module",
			scripts: {
				"check:model-data": "node packages/ai/scripts/check-model-data.ts",
				"hydrate:model-data": "node scripts/hydrate.mjs",
				"build:offline": "node scripts/build.mjs",
			},
		}));
		write("package-lock.json", "{}");
		write("node_modules/.package-lock.json", "{}");
		write("tsconfig.json", "{}");
		write("tsconfig.base.json", "{}");
		write("packages/ai/package.json", '{"type":"module"}');
		write("packages/ai/src/models.generated.ts", 'import { FIXTURE_MODELS } from "./providers/fixture.models.ts";\n');
		write("packages/ai/src/image-models.generated.ts", "export {};\n");
		write("packages/ai/src/providers/fixture.models.ts", "export const FIXTURE_MODELS = {};\n");
		mkdirSync(join(root, "packages/ai/scripts"), { recursive: true });
		for (const name of ["check-model-data.ts", "model-data.ts"]) {
			copyFileSync(new URL(`../packages/ai/scripts/${name}`, import.meta.url), join(root, "packages/ai/scripts", name));
		}
		copyFileSync(new URL("../start.bat", import.meta.url), join(root, "start.bat"));
		mkdirSync(join(root, "scripts"), { recursive: true });
		copyFileSync(new URL("./workbench-start-state.mjs", import.meta.url), join(root, "scripts/workbench-start-state.mjs"));

		const api = "openai-completions";
		const modelData = JSON.stringify({ [api]: { "fixture-model": {
			id: "fixture-model", provider: "fixture", api, name: "Fixture model", baseUrl: "https://example.invalid",
			reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		} } });
		const manifest = createModelDataManifest({ fixture: { "fixture-model": api } }, { "fixture.json": modelData }, "2026-10-02T00:00:00Z");
		write("scripts/model-data-fixture/fixture.json", modelData);
		write("scripts/model-data-fixture/.manifest.json", JSON.stringify(manifest));
		if (dataState !== "missing") {
			write("packages/ai/src/providers/data/fixture.json", modelData);
			write("packages/ai/src/providers/data/.manifest.json", JSON.stringify({
				...manifest, structureHash: dataState === "stale" ? "stale" : manifest.structureHash,
			}));
		}
		write("scripts/hydrate.mjs", `
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("packages/ai/src/providers/data", { recursive: true });
for (const name of ["fixture.json", ".manifest.json"]) {
	copyFileSync("scripts/model-data-fixture/" + name, "packages/ai/src/providers/data/" + name);
}
writeFileSync("hydrated", "");
`);
		const outputs = [
			"runtime/dist/index.js", "core/dist/index.js", "core/dist/memory-state-service.js", "core/dist/semantic-memory-service.js", "database/dist/index.js",
			"database/dist/migrations/015_knowledge_documents.sql", "database/dist/migrations/016_assistant_deletion.sql", "database/dist/migrations/017_project_learning.sql", "database/dist/migrations/018_structured_knowledge.sql", "database/dist/migrations/019_memory_state.sql", "database/dist/migrations/020_semantic_memory.sql", "database/dist/migrations/021_perceptual_memory.sql", "database/dist/migrations/022_episode_vectors.sql", "mcp/dist/index.js", "runtime-pi/dist/index.js", "runtime-pi/dist/ptc-worker.js",
			"ui/dist/assets/app.js", "ui/dist/assets/app.css", "ui/dist/assets/styles.css", "ui/dist/index.html",
			"server/dist/cli.js", "server/dist/memory-retrieval.js", "server/dist/perception-adapter.js", "server/dist/browser-use.js", "server/dist/computer-use-script.js", "server/dist/knowledge-parser-worker.js",
		].map((path) => `packages/workbench-${path}`);
		outputs.push("packages/workbench-database/dist/migrations/023_canonical_workspace_documents.sql");
		write("scripts/build.mjs", `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateGeneratedModelData } from "../packages/ai/scripts/model-data.ts";
validateGeneratedModelData("packages/ai");
for (const path of ${JSON.stringify(outputs)}) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
}
writeFileSync("built", "");
`);
		const stamp = spawnSync(process.execPath, ["scripts/workbench-start-state.mjs", "record-dependencies"], { cwd: root, encoding: "utf8" });
		assert.equal(stamp.status, 0, stamp.stderr);
		if (dataState === "valid") {
			for (const path of outputs) write(path);
			const built = spawnSync(process.execPath, ["scripts/workbench-start-state.mjs", "record-build"], { cwd: root, encoding: "utf8" });
			assert.equal(built.status, 0, built.stderr);
		}
		beforeLaunch(write);
		const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "start.bat", "--check"], {
			cwd: root, env: { ...process.env, CI: "1" }, encoding: "utf8", timeout: 30_000,
		});
		assert.ifError(result.error);
		verify(root, result);
	} finally {
		assert.equal(dirname(root), tmpdir());
		rmSync(root, { recursive: true, force: true });
	}
}

for (const state of ["missing", "stale"]) {
	test(`Windows launcher restores ${state} provider data when generated TypeScript catalogs already exist`, { skip: process.platform !== "win32" }, () => {
		withLauncherFixture(state, (root, result) => {
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.ok(existsSync(join(root, "hydrated")), "provider data was restored");
			assert.ok(existsSync(join(root, "built")), "offline build ran after restoring provider data");
			assert.match(result.stdout, /Environment check passed/u);
		});
	});
}

test("Windows launcher reuses valid provider data and a current build", { skip: process.platform !== "win32" }, () => {
	withLauncherFixture("valid", (root, result) => {
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(existsSync(join(root, "hydrated")), false);
		assert.equal(existsSync(join(root, "built")), false);
		assert.match(result.stdout, /Environment check passed/u);
	});
});

test("Windows launcher rejects an incomplete install even if npm reports success", { skip: process.platform !== "win32" }, () => {
	withLauncherFixture("valid", (_root, result) => {
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.doesNotMatch(result.stdout, /Environment check passed/u);
		assert.match(result.stderr, /Cannot record incomplete dependencies/u);
	}, (write) => {
		write("package-lock.json", JSON.stringify({ packages: { "node_modules/missing-fixture": { version: "1.0.0" } } }));
		write("npm.cmd", "@echo off\r\nexit /b 0\r\n");
	});
});
