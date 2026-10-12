import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PathPolicy, WorkbenchPaths, WorkspaceManager } from "../src/workspace.ts";

test("only the session-bound local project receives workspace permissions", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "wb-project-boundary 中文 "));
	try {
		const paths = new WorkbenchPaths(join(temporary, "data"));
		await new WorkspaceManager(paths).initialize();
		const credentials = join(temporary, "credentials");
		const source = join(temporary, "existing");
		await mkdir(source);
		await mkdir(credentials);
		const policy = new PathPolicy(paths, [credentials]);
		const root = await policy.validateProjectSource(source);
		expect((await policy.classify("result.txt", root, [root])).zone).toBe("workspace");
		expect((await policy.classify("result.txt", root)).zone).toBe("external");
		expect((await policy.classify(join(credentials, "key.json"), root, [root])).zone).toBe("credential");
		expect((await policy.classify(paths.database, root, [root])).zone).toBe("internal-state");
		await expect(policy.requireProjectFile(root, "../credentials/key.json")).rejects.toMatchObject({
			code: "path_denied",
		});
		if (process.platform === "win32")
			expect((await policy.classify("result.txt", root.toUpperCase(), [root.toUpperCase()])).zone).toBe("workspace");
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("replacing a selected directory with a junction cannot expand its permissions during a run", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "wb-source-change-"));
	try {
		const paths = new WorkbenchPaths(join(temporary, "data"));
		await new WorkspaceManager(paths).initialize();
		const source = join(temporary, "selected");
		const outside = join(temporary, "outside");
		await mkdir(source);
		await mkdir(outside);
		const policy = new PathPolicy(paths);
		const root = await realpath(source);
		await rename(source, `${source}-old`);
		await symlink(outside, source, process.platform === "win32" ? "junction" : "dir");
		await expect(policy.classify("secret.txt", source, [root])).rejects.toMatchObject({ code: "path_denied" });
		await expect(policy.requireProjectFile(root, "secret.txt")).rejects.toMatchObject({ code: "path_denied" });
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
