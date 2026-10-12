import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const preloadUrl = new URL("./fixtures/listen-failure.mjs", import.meta.url).href;

async function runCli(
	input: {
		code?: "EACCES" | "EADDRINUSE";
		port?: string;
		legacyOwner?: { pid: number; id: string; startedAt: string };
	},
	verify: (cli: {
		launch: Promise<string>;
		closed: Promise<number | null>;
		stderr: () => string;
		root: string;
	}) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "workbench-startup 中文 "));
	if (input.legacyOwner) {
		await mkdir(join(root, "state", "runtime"), { recursive: true });
		await writeFile(join(root, "state", "runtime", "workbench.lock"), JSON.stringify(input.legacyOwner));
	}
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PERSONAL_WORKBENCH_HOME: root,
		PI_CODING_AGENT_DIR: join(root, "pi-agent"),
	};
	delete env.PERSONAL_WORKBENCH_PORT;
	if (input.port !== undefined) env.PERSONAL_WORKBENCH_PORT = input.port;
	const child = spawn(process.execPath, [...(input.code ? ["--import", preloadUrl] : []), cliPath], {
		env: { ...env, WORKBENCH_TEST_LISTEN_ERROR: input.code },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
	let timer: ReturnType<typeof setTimeout> | undefined;
	const launch = new Promise<string>((resolve, reject) => {
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			const match = /Personal Workbench: (http:\/\/[^\s]+)/u.exec(stdout);
			if (match) resolve(match[1]);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("close", (code) => reject(new Error(`CLI exited with code ${code}: ${stderr}`)));
		timer = setTimeout(() => reject(new Error("Workbench startup timed out")), 15_000);
	});
	// Failure-path tests inspect process exit instead of awaiting the launch promise.
	void launch.catch(() => undefined);
	try {
		await verify({ launch, closed, stderr: () => stderr, root });
	} finally {
		if (timer) clearTimeout(timer);
		if (child.exitCode === null) child.kill();
		await closed;
		await rm(root, { recursive: true, force: true });
	}
}

test("compiled CLI recovers a reused PID and serves the Gateway", async () => {
	await runCli(
		{ port: "0", legacyOwner: { pid: process.pid, id: "reused-pid", startedAt: "2000-01-01T00:00:00.000Z" } },
		async ({ launch }) => {
			const url = new URL(await launch);
			const response = await fetch(new URL("/api/v1/health", url), {
				headers: { authorization: `Bearer ${url.searchParams.get("token")}` },
			});
			expect(response.status).toBe(200);
		},
	);
}, 20000);

test("compiled CLI preserves an active legacy owner and explains the conflict", async () => {
	await runCli(
		{ legacyOwner: { pid: process.pid, id: "live-pid", startedAt: new Date().toISOString() } },
		async ({ closed, stderr }) => {
			expect(await closed).toBe(1);
			expect(stderr()).toContain("already using this data directory");
			expect(stderr()).toContain("Ctrl+C");
		},
	);
}, 20000);

test.each(["EACCES", "EADDRINUSE"] as const)(
	"CLI selects an available loopback port when default 4242 fails with %s",
	async (code) => {
		await runCli({ code }, async ({ launch }) => {
			const url = new URL(await launch);
			expect(url.hostname).toBe("127.0.0.1");
			expect(url.port).not.toBe("4242");
			const response = await fetch(new URL("/api/v1/health", url), {
				headers: { authorization: `Bearer ${url.searchParams.get("token")}` },
			});
			expect(response.status).toBe(200);
		});
	},
	20_000,
);

test("CLI explains an unavailable explicit port and releases its data lock", async () => {
	await runCli({ code: "EACCES", port: "4242" }, async ({ closed, stderr, root }) => {
		expect(await closed).toBe(1);
		expect(stderr()).toContain("PERSONAL_WORKBENCH_PORT");
		await expect(access(join(root, "state", "runtime", "workbench.lock"))).rejects.toMatchObject({ code: "ENOENT" });
	});
}, 20_000);

test("CLI rejects an invalid port before creating application state", async () => {
	await runCli({ port: "not-a-port" }, async ({ closed, stderr, root }) => {
		expect(await closed).toBe(1);
		expect(stderr()).toContain("PERSONAL_WORKBENCH_PORT must be an integer");
		await expect(access(join(root, "state", "workbench.db"))).rejects.toMatchObject({ code: "ENOENT" });
	});
}, 20_000);
