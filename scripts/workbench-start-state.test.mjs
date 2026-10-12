import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("launcher fingerprints detect lockfile and source changes independently", () => {
	const root = mkdtempSync(join(tmpdir(), "workbench-start-state 中文 "));
	try {
		const write = (path, text = "") => { const target = join(root, path); mkdirSync(join(target, ".."), {recursive: true}); writeFileSync(target, text); };
		write("package.json", "{}"); write("package-lock.json", "{}"); write("node_modules/.package-lock.json", "{}");
		write("tsconfig.json", "{}"); write("tsconfig.base.json", "{}"); write("scripts/placeholder", "");
		copyFileSync(new URL("./workbench-start-state.mjs", import.meta.url), join(root, "scripts", "workbench-start-state.mjs"));
		for (const name of ["runtime", "core", "database", "mcp", "runtime-pi", "ui", "server"]) {
			write(`packages/workbench-${name}/package.json`, "{}");
			write(`packages/workbench-${name}/src/index.ts`, "export {};");
			write(`packages/workbench-${name}/dist/${name === "ui" ? "assets/app.js" : name === "server" ? "cli.js" : "index.js"}`);
		}
		for (const path of ["assets/app.css", "assets/styles.css", "index.html"]) write(`packages/workbench-ui/dist/${path}`);
		write("packages/workbench-server/dist/knowledge-parser-worker.js");
		for (const name of ["015_knowledge_documents", "016_assistant_deletion", "017_project_learning", "018_structured_knowledge", "019_memory_state", "020_semantic_memory", "021_perceptual_memory", "022_episode_vectors"]) write(`packages/workbench-database/dist/migrations/${name}.sql`);
		for (const name of ["memory-state-service", "semantic-memory-service"]) write(`packages/workbench-core/dist/${name}.js`);
		for (const name of ["memory-retrieval", "perception-adapter", "browser-use", "computer-use-script"]) write(`packages/workbench-server/dist/${name}.js`);
		write("packages/workbench-runtime-pi/dist/ptc-worker.js");
		write("packages/workbench-database/dist/migrations/023_canonical_workspace_documents.sql");
		for (const name of ["024_learning_loop", "025_learning_cadence", "026_background_learning"]) write(`packages/workbench-database/dist/migrations/${name}.sql`);
		const run = (command) => spawnSync(process.execPath, [join(root, "scripts", "workbench-start-state.mjs"), command], {encoding: "utf8"});
		assert.equal(run("build").status, 1);
		assert.equal(run("record-dependencies").status, 0);
		assert.equal(run("record-build").status, 0);
		assert.equal(run("build").status, 0);
		for (const name of ["024_learning_loop", "025_learning_cadence", "026_background_learning"]) {
			unlinkSync(join(root, `packages/workbench-database/dist/migrations/${name}.sql`));
			assert.equal(run("build").status, 1);
			assert.equal(run("record-build").status, 1);
			write(`packages/workbench-database/dist/migrations/${name}.sql`);
			assert.equal(run("build").status, 0);
		}
		unlinkSync(join(root, "packages/workbench-ui/dist/assets/app.css"));
		assert.equal(run("build").status, 1);
		write("packages/workbench-ui/dist/assets/app.css");
		assert.equal(run("build").status, 0);
		unlinkSync(join(root, "packages/workbench-server/dist/knowledge-parser-worker.js"));
		assert.equal(run("build").status, 1);
		write("packages/workbench-server/dist/knowledge-parser-worker.js");
		assert.equal(run("build").status, 0);
		write("packages/workbench-core/src/index.ts", "export const changed = true;");
		assert.equal(run("build").status, 1);
		assert.equal(run("dependencies").status, 0);
		write("package-lock.json", "{\"lockfileVersion\": 3}");
		assert.equal(run("dependencies").status, 1);
	} finally { assert.equal(dirname(root), tmpdir()); rmSync(root, {recursive: true, force: true}); }
});

test("an interrupted install cannot be certified, including a missing internal worker after certification", () => {
	const root = mkdtempSync(join(tmpdir(), "workbench-incomplete-install 中文 "));
	const write = (path, text = "") => { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); };
	try {
		write("package.json", "{}"); mkdirSync(join(root, "packages"));
		write("package-lock.json", JSON.stringify({ packages: { "node_modules/playwright": { version: "1.63.0" }, "node_modules/optional-platform": { optional: true }, "node_modules/unused": { extraneous: true } } }));
		write("node_modules/.package-lock.json", "{}"); write("scripts/placeholder");
		copyFileSync(new URL("./workbench-start-state.mjs", import.meta.url), join(root, "scripts/workbench-start-state.mjs"));
		const run = (command) => spawnSync(process.execPath, [join(root, "scripts/workbench-start-state.mjs"), command], { encoding: "utf8" });
		assert.equal(run("record-dependencies").status, 1);
		assert.equal(existsSync(join(root, ".workbench-start.json")), false);
		write("node_modules/playwright/package.json", JSON.stringify({ version: "1.63.0", main: "index.js", bin: { playwright: "cli.js" } }));
		write("node_modules/playwright/index.js"); write("node_modules/playwright/cli.js"); write("node_modules/playwright/lib/worker/workerProcessEntry.js");
		assert.equal(run("record-dependencies").status, 0);
		const before = readFileSync(join(root, ".workbench-start.json"), "utf8");
		unlinkSync(join(root, "node_modules/playwright/lib/worker/workerProcessEntry.js"));
		assert.equal(run("dependencies").status, 1);
		assert.equal(run("record-dependencies").status, 1);
		assert.equal(readFileSync(join(root, ".workbench-start.json"), "utf8"), before);
		write("node_modules/playwright/lib/worker/workerProcessEntry.js");
		unlinkSync(join(root, "node_modules/playwright/cli.js"));
		assert.equal(run("dependencies").status, 1);
		write("node_modules/playwright/cli.js"); write("node_modules/playwright/package.json", '{"version":"1.62.0"}');
		assert.equal(run("record-dependencies").status, 1);
	} finally { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); }
});
