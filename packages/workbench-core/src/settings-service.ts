import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	DEFAULT_SANDBOX_POLICY,
	isSandboxSettings,
	type RuntimeSandboxPolicy,
} from "@earendil-works/workbench-runtime";
import { WorkbenchError } from "./errors.ts";
import { memoryPolicy } from "./memory-policy.ts";
import type { JsonValue, SettingRecord } from "./models.ts";
import type { SettingsRepository } from "./repositories.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";

export class SettingsService {
	private readonly repository: SettingsRepository;
	private readonly system: SystemServices;

	constructor(repository: SettingsRepository, system: SystemServices = defaultSystemServices) {
		this.repository = repository;
		this.system = system;
	}

	get(key: string): Promise<SettingRecord | undefined> {
		return this.repository.get(key);
	}

	list(): Promise<SettingRecord[]> {
		return this.repository.list();
	}

	async sandboxPolicy(protectedPaths: string[]): Promise<RuntimeSandboxPolicy> {
		const value = (await this.get("sandbox.policy"))?.value;
		if (value !== undefined && !isSandboxSettings(value))
			throw new WorkbenchError("invalid_input", "已保存的沙箱设置无效，请在设置中重新保存");
		const policy = value ?? structuredClone(DEFAULT_SANDBOX_POLICY);
		for (const root of policy.writableRoots) {
			try {
				if (!isAbsolute(root) || !(await stat(root)).isDirectory() || (await realpath(root)) !== root)
					throw new Error("Writable root changed");
			} catch (error) {
				throw new WorkbenchError("invalid_input", "额外可写目录已变化，请重新选择并保存沙箱设置", { cause: error });
			}
		}
		return { ...policy, protectedPaths };
	}

	async set(key: string, value: JsonValue, expectedVersion?: number): Promise<SettingRecord> {
		if (key === "memory.policy") value = { ...memoryPolicy(value) };
		if (key.startsWith("session.workspaceDisposition.") && !["keep", "delete", "migrate"].includes(String(value)))
			throw new WorkbenchError("invalid_input", "会话工作区处理方式必须为 keep、delete 或 migrate");
		if (!key.trim()) throw new WorkbenchError("invalid_input", "Setting key is required");
		if (key === "memory.checkpointReviewEnabled" && typeof value !== "boolean")
			throw new WorkbenchError("invalid_input", "工作检查点整理开关必须为布尔值");
		if (key === "learning.defaultMode" || key.startsWith("learning.project."))
			throw new WorkbenchError("invalid_input", "项目仅使用后台自动学习，无需设置学习模式");
		if (
			key === "context.autoCompactThresholdPercent" &&
			(typeof value !== "number" || !Number.isInteger(value) || value < 10 || value > 95)
		)
			throw new WorkbenchError("invalid_input", "自动压缩阈值必须为 10% 到 95% 的整数");
		if (key === "context.autoCompactEnabled" && typeof value !== "boolean")
			throw new WorkbenchError("invalid_input", "自动压缩开关必须为布尔值");
		if (key === "sandbox.policy") {
			if (!isSandboxSettings(value)) throw new WorkbenchError("invalid_input", "沙箱设置格式无效");
			const roots: string[] = [];
			for (const root of value.writableRoots) {
				if (!isAbsolute(root)) throw new WorkbenchError("invalid_input", "额外可写目录必须为绝对路径");
				try {
					if (!(await stat(root)).isDirectory()) throw new Error("Not a directory");
					roots.push(await realpath(root));
				} catch (error) {
					throw new WorkbenchError("invalid_input", "额外可写目录不存在或无法访问", { cause: error });
				}
			}
			value = { ...value, writableRoots: [...new Set(roots)] };
		}
		const current = await this.repository.get(key);
		const record: SettingRecord = {
			key,
			value,
			version: (current?.version ?? 0) + 1,
			updatedAt: toTimestamp(this.system.now()),
		};
		const saved = await this.repository.set(record, expectedVersion);
		if (!saved) throw new WorkbenchError("conflict", "Setting changed since it was loaded");
		return saved;
	}
}
