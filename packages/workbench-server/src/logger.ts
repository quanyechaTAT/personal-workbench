import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|secret|token|environment)/iu;

export function sanitizeDiagnostic(value: unknown, depth = 0): unknown {
	if (depth > 6) return "[truncated]";
	if (typeof value === "string") {
		const redacted = value
			.replace(/\bBearer\s+[^\s"',;]+/giu, "Bearer [redacted]")
			.replace(
				/((?:api[-_]?key|access_token|refresh_token|client_secret|password)\s*[=:]\s*)[^\s&"',;]+/giu,
				"$1[redacted]",
			);
		return redacted.length > 4_000 ? `${redacted.slice(0, 4_000)}…` : redacted;
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeDiagnostic(entry, depth + 1));
	if (typeof value !== "object") return String(value);
	return Object.fromEntries(
		Object.entries(value)
			.slice(0, 100)
			.map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeDiagnostic(entry, depth + 1)]),
	);
}

export interface LogRecord {
	timestamp: string;
	event: string;
	data?: unknown;
}

export class StructuredLogger {
	private readonly path: string;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
	}

	async initialize(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
	}

	log(event: string, data?: unknown): Promise<void> {
		const record: LogRecord = {
			timestamp: new Date().toISOString(),
			event,
			data: data === undefined ? undefined : sanitizeDiagnostic(data),
		};
		const line = `${JSON.stringify(record)}\n`;
		this.writeChain = this.writeChain.then(() => appendFile(this.path, line, "utf8"));
		return this.writeChain;
	}

	flush(): Promise<void> {
		return this.writeChain;
	}

	async readRecent(limit = 100): Promise<LogRecord[]> {
		await this.writeChain;
		const handle = await open(this.path, "r");
		try {
			const metadata = await handle.stat();
			const byteLength = Math.min(metadata.size, 256 * 1024);
			const buffer = Buffer.alloc(byteLength);
			await handle.read(buffer, 0, byteLength, metadata.size - byteLength);
			const records = buffer
				.toString("utf8")
				.split("\n")
				.slice(metadata.size > byteLength ? 1 : 0)
				.flatMap((line): LogRecord[] => {
					if (!line) return [];
					try {
						const value = JSON.parse(line) as Partial<LogRecord>;
						return typeof value.timestamp === "string" && typeof value.event === "string"
							? [{ timestamp: value.timestamp, event: value.event, data: value.data }]
							: [];
					} catch (error) {
						void error;
						return [];
					}
				});
			return records.slice(-Math.min(500, Math.max(1, Math.trunc(limit)))).reverse();
		} finally {
			await handle.close();
		}
	}
}
