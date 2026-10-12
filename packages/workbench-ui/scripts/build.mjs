import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "assets"), { recursive: true });
await build({
	entryPoints: [resolve(root, "src/main.tsx")],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	minify: true,
	sourcemap: true,
	outfile: resolve(output, "assets/app.js"),
	jsx: "automatic",
});
await cp(resolve(root, "src/styles.css"), resolve(output, "assets/styles.css"));
await cp(resolve(root, "src/index.html"), resolve(output, "index.html"));
