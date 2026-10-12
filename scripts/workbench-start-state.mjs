import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = join(root, ".workbench-start.json");
const require = createRequire(import.meta.url);
const outputs = ["runtime/dist/index.js", "core/dist/index.js", "core/dist/memory-state-service.js", "core/dist/semantic-memory-service.js", "database/dist/index.js", "database/dist/migrations/015_knowledge_documents.sql", "database/dist/migrations/016_assistant_deletion.sql", "database/dist/migrations/017_project_learning.sql", "database/dist/migrations/018_structured_knowledge.sql", "database/dist/migrations/019_memory_state.sql", "database/dist/migrations/020_semantic_memory.sql", "database/dist/migrations/021_perceptual_memory.sql", "database/dist/migrations/022_episode_vectors.sql", "mcp/dist/index.js", "runtime-pi/dist/index.js", "runtime-pi/dist/ptc-worker.js", "ui/dist/assets/app.js", "ui/dist/assets/app.css", "ui/dist/assets/styles.css", "ui/dist/index.html", "server/dist/cli.js", "server/dist/memory-retrieval.js", "server/dist/perception-adapter.js", "server/dist/browser-use.js", "server/dist/computer-use-script.js", "server/dist/knowledge-parser-worker.js"].map((path) => `packages/workbench-${path}`);

outputs.push("packages/workbench-database/dist/migrations/023_canonical_workspace_documents.sql");
outputs.push("packages/workbench-database/dist/migrations/024_learning_loop.sql", "packages/workbench-database/dist/migrations/025_learning_cadence.sql");
outputs.push("packages/workbench-database/dist/migrations/026_background_learning.sql");

function filesUnder(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
	});
}

function fingerprint(kind) {
	const files = [join(root, "package-lock.json"), join(root, "package.json")];
	for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const directory = join(root, "packages", entry.name);
		if (existsSync(join(directory, "package.json"))) files.push(join(directory, "package.json"));
		if (kind === "build") {
			files.push(...filesUnder(join(directory, "src")), ...filesUnder(join(directory, "scripts")));
			for (const name of readdirSync(directory)) if (/^tsconfig.*\.json$/u.test(name)) files.push(join(directory, name));
		}
	}
	if (kind === "build") files.push(...filesUnder(join(root, "scripts")), join(root, "tsconfig.base.json"), join(root, "tsconfig.json"));
	const hash = createHash("sha256").update(`${process.versions.node}:${process.platform}:${process.arch}`);
	for (const path of [...new Set(files)].sort()) hash.update(relative(root, path)).update(readFileSync(path));
	return hash.digest("hex");
}

function missingDependencies() {
	const missing = [];
	if (!existsSync(join(root, "node_modules/.package-lock.json"))) missing.push("node_modules/.package-lock.json");
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	for (const [path, entry] of Object.entries(lock.packages ?? {})) {
		if (!path.includes("node_modules/") || entry.optional || entry.link || entry.extraneous) continue;
		const directory = join(root, path);
		const manifestPath = join(directory, "package.json");
		if (!existsSync(manifestPath)) { missing.push(`${path}/package.json`); continue; }
		let manifest;
		try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
		catch { missing.push(`${path}/package.json (invalid)`); continue; }
		if (manifest.version !== entry.version) missing.push(`${path}/package.json (version mismatch)`);
		if (typeof manifest.main === "string" && manifest.main) {
			try { require.resolve(resolve(directory, manifest.main)); }
			catch { missing.push(`${path}/${manifest.main}`); }
		}
		for (const binary of typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {}))
			if (!existsSync(join(directory, binary))) missing.push(`${path}/${binary}`);
	}
	// These worker files are not package entry points, but interrupted installs can remove them independently.
	for (const [packagePath, worker] of [["node_modules/playwright", "lib/worker/workerProcessEntry.js"]])
		if (lock.packages?.[packagePath] && !existsSync(join(root, packagePath, worker))) missing.push(`${packagePath}/${worker}`);
	return missing;
}

let state = {};
if (existsSync(statePath)) {
	try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch (error) { console.warn(`Ignoring invalid build state: ${error.message}`); }
}
const command = process.argv[2];
const kind = command?.replace(/^record-/u, "");
if (kind !== "dependencies" && kind !== "build") throw new Error("Usage: workbench-start-state.mjs [record-]dependencies|[record-]build");
const expected = fingerprint(kind);
const missing = kind === "dependencies" ? missingDependencies() : outputs.filter((path) => !existsSync(join(root, path)));
if (command.startsWith("record-")) {
	if (missing.length) {
		console.error(`Cannot record incomplete ${kind}:\n${missing.slice(0, 10).join("\n")}`);
		process.exitCode = 1;
	} else {
		state[kind] = expected;
		const temporary = `${statePath}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
		renameSync(temporary, statePath);
	}
} else {
	process.exitCode = missing.length === 0 && state[kind] === expected ? 0 : 1;
}
