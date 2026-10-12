import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { WorkbenchError } from "@earendil-works/workbench-core";

interface LockOwner {
	pid: number;
	id: string;
	startedAt: string;
	processStartedAt?: string;
}

const execute = promisify(execFile);
let ownProcessStart: Promise<string | undefined> | undefined;

async function processStart(pid: number): Promise<string | undefined> {
	try {
		const { stdout } =
			process.platform === "win32"
				? await execute(
						"powershell.exe",
						[
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
						],
						{ windowsHide: true, timeout: 4000, maxBuffer: 1024 },
					)
				: await execute("ps", ["-o", "lstart=", "-p", String(pid)], {
						timeout: 4000,
						maxBuffer: 1024,
						env: { ...process.env, LC_ALL: "C" },
					});
		const timestamp = Date.parse(stdout.trim());
		return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
	} catch {
		// An unavailable process inspector is not proof that an owner has exited.
		return undefined;
	}
}

async function ownsLiveProcess(owner: LockOwner): Promise<boolean> {
	if (!isAlive(owner.pid)) return false;
	const startedAt = await processStart(owner.pid);
	if (!isAlive(owner.pid)) return false;
	if (!startedAt) return true;
	if (owner.processStartedAt) return startedAt === owner.processStartedAt;
	// Legacy locks record acquisition time. A process born afterwards cannot own them.
	// ps reports whole seconds, so retain locks when the comparison is inconclusive.
	return Date.parse(startedAt) <= Date.parse(owner.startedAt) + 1000;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "ESRCH" || error.code === "EINVAL")
		);
	}
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockOwner>;
		if (
			!Number.isInteger(value.pid) ||
			typeof value.pid !== "number" ||
			value.pid <= 0 ||
			value.pid > 2_147_483_647 ||
			typeof value.id !== "string" ||
			!value.id ||
			typeof value.startedAt !== "string" ||
			!Number.isFinite(Date.parse(value.startedAt)) ||
			(value.processStartedAt !== undefined &&
				(typeof value.processStartedAt !== "string" || !Number.isFinite(Date.parse(value.processStartedAt))))
		) {
			return undefined;
		}
		return { pid: value.pid, id: value.id, startedAt: value.startedAt, processStartedAt: value.processStartedAt };
	} catch (error) {
		void error;
		return undefined;
	}
}

export class WorkbenchInstanceLock {
	private readonly path: string;
	private readonly owner: LockOwner;
	private readonly handle: FileHandle;
	private readonly guard: DatabaseSync;
	private released = false;

	private constructor(path: string, owner: LockOwner, handle: FileHandle, guard: DatabaseSync) {
		this.path = path;
		this.owner = owner;
		this.handle = handle;
		this.guard = guard;
	}

	static async acquire(path: string): Promise<WorkbenchInstanceLock> {
		await mkdir(dirname(path), { recursive: true });
		// SQLite's OS lock serializes stale-lock recovery across processes and is
		// released by the OS after a crash. Never unlink this guard's database file.
		const guard = new DatabaseSync(`${path}.sqlite`);
		try {
			guard.exec("BEGIN EXCLUSIVE");
		} catch (error) {
			guard.close();
			if (
				typeof error === "object" &&
				error !== null &&
				"errcode" in error &&
				(error.errcode === 5 || error.errcode === 6)
			)
				throw new WorkbenchError(
					"conflict",
					"Personal Workbench is already using this data directory. 请使用已有工作台；如需重启，请在其启动窗口按 Ctrl+C。",
				);
			throw error;
		}
		let handle: FileHandle | undefined;
		try {
			ownProcessStart ??= processStart(process.pid);
			const owner: LockOwner = {
				pid: process.pid,
				id: randomUUID(),
				startedAt: new Date().toISOString(),
				processStartedAt: await ownProcessStart,
			};
			for (let attempt = 0; attempt < 2; attempt += 1) {
				try {
					handle = await open(path, "wx");
					await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
					await handle.sync();
					return new WorkbenchInstanceLock(path, owner, handle, guard);
				} catch (error) {
					if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
						throw error;
					}
					const current = await readOwner(path);
					if (!current)
						throw new WorkbenchError(
							"conflict",
							"工作台锁记录损坏或不完整，无法安全确认占用状态。请参阅 docs/workbench/OPERATIONS.md。",
						);
					if (await ownsLiveProcess(current)) {
						throw new WorkbenchError(
							"conflict",
							`Personal Workbench is already using this data directory (PID ${current.pid}). 请使用已有工作台；如需重启，请在其启动窗口按 Ctrl+C。`,
						);
					}
					await unlink(path);
				}
			}
			throw new WorkbenchError("conflict", "Personal Workbench instance lock could not be acquired");
		} catch (error) {
			try {
				await handle?.close();
			} finally {
				guard.close();
			}
			throw error;
		}
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		try {
			await this.handle.close();
			const current = await readOwner(this.path);
			if (current?.id === this.owner.id) await unlink(this.path).catch(() => undefined);
		} finally {
			this.guard.close();
		}
	}
}
