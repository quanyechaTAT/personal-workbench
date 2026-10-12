import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeTextAtomically } from "@earendil-works/workbench-core";
import type { McpSecretResolver, McpSecretValue } from "@earendil-works/workbench-mcp";

interface SecretFile {
	version: 1;
	secrets: Record<string, McpSecretValue>;
}

export class SecretStore implements McpSecretResolver {
	private readonly path: string;
	private updateChain: Promise<void> = Promise.resolve();
	private permissionsReady = false;

	constructor(path: string) {
		this.path = path;
	}

	async create(value: McpSecretValue): Promise<string> {
		const reference = `mcp-${randomUUID()}`;
		await this.set(reference, value);
		return reference;
	}

	async set(reference: string, value: McpSecretValue): Promise<void> {
		const update = this.updateChain.then(async () => {
			const document = await this.read();
			document.secrets[reference] = cleanSecret(value);
			await this.write(document);
		});
		this.updateChain = update.then(
			() => undefined,
			() => undefined,
		);
		await update;
	}

	setSecret(reference: string, value: McpSecretValue): Promise<void> {
		return this.set(reference, value);
	}

	async getSecret(reference: string): Promise<McpSecretValue | undefined> {
		await this.updateChain;
		return (await this.read()).secrets[reference];
	}

	async delete(reference: string): Promise<void> {
		const update = this.updateChain.then(async () => {
			const document = await this.read();
			if (!(reference in document.secrets)) return;
			delete document.secrets[reference];
			await this.write(document);
		});
		this.updateChain = update.then(
			() => undefined,
			() => undefined,
		);
		await update;
	}

	async getStatus(reference?: string): Promise<{ configured: boolean; oauth: boolean }> {
		if (!reference) return { configured: false, oauth: false };
		const secret = await this.getSecret(reference);
		return {
			configured: Boolean(
				secret?.bearerToken ||
					secret?.clientSecret ||
					Object.keys(secret?.headers ?? {}).length ||
					Object.keys(secret?.environment ?? {}).length,
			),
			oauth: Object.keys(secret?.oauth?.tokens ?? {}).length > 0,
		};
	}

	private async read(): Promise<SecretFile> {
		const content = await readFile(this.path, "utf8").catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		});
		if (!content) return { version: 1, secrets: {} };
		const value: unknown = JSON.parse(content);
		if (
			typeof value !== "object" ||
			value === null ||
			!("version" in value) ||
			value.version !== 1 ||
			!("secrets" in value) ||
			typeof value.secrets !== "object" ||
			value.secrets === null
		) {
			throw new Error("MCP secret file has an unsupported format");
		}
		return value as SecretFile;
	}

	private async write(document: SecretFile): Promise<void> {
		if (!this.permissionsReady) {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			if (process.platform === "win32") {
				if (!process.env.SystemRoot) throw new Error("Windows system directory is unavailable");
				const systemDirectory = join(process.env.SystemRoot, "System32");
				const execute = promisify(execFile);
				const user = await execute(join(systemDirectory, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
					windowsHide: true,
				});
				// SID is ASCII and independent of the console code page or a localized account name.
				const sid = /\bS-1-\d+(?:-\d+)+\b/u.exec(user.stdout)?.[0];
				if (!sid) throw new Error("Could not determine the current Windows user SID");
				await execute(
					join(systemDirectory, "icacls.exe"),
					[dirname(this.path), "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
					{ windowsHide: true },
				);
			} else await chmod(dirname(this.path), 0o700);
			this.permissionsReady = true;
		}
		await writeTextAtomically(this.path, `${JSON.stringify(document, null, 2)}\n`);
		await chmod(this.path, 0o600);
	}
}

function cleanSecret(value: McpSecretValue): McpSecretValue {
	return {
		clientSecret: value.clientSecret || undefined,
		bearerToken: value.bearerToken?.trim() || undefined,
		headers: cleanMap(value.headers),
		environment: cleanMap(value.environment),
		oauth: value.oauth,
	};
}

function cleanMap(value?: Record<string, string>): Record<string, string> | undefined {
	if (!value) return undefined;
	const entries = Object.entries(value).filter(([key]) => key.trim().length > 0);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
