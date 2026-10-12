export type RuntimeSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface RuntimeSandboxPolicy {
	mode: RuntimeSandboxMode;
	networkAccess: boolean;
	writableRoots: string[];
	windowsImplementation?: "elevated" | "unelevated";
	/** Host-owned credential and state paths; never supplied by the model. */
	protectedPaths?: string[];
}

export const DEFAULT_SANDBOX_POLICY: RuntimeSandboxPolicy = {
	mode: "workspace-write",
	networkAccess: false,
	writableRoots: [],
	windowsImplementation: "elevated",
};

export function isSandboxSettings(value: unknown): value is Omit<RuntimeSandboxPolicy, "protectedPaths"> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).every((key) =>
			["mode", "networkAccess", "writableRoots", "windowsImplementation"].includes(key),
		) &&
		typeof record.mode === "string" &&
		["read-only", "workspace-write", "danger-full-access"].includes(record.mode) &&
		typeof record.networkAccess === "boolean" &&
		Array.isArray(record.writableRoots) &&
		record.writableRoots.length <= 16 &&
		record.writableRoots.every(
			(root) => typeof root === "string" && root.trim().length > 0 && !root.includes("\0"),
		) &&
		(record.windowsImplementation === undefined ||
			(typeof record.windowsImplementation === "string" &&
				["elevated", "unelevated"].includes(record.windowsImplementation)))
	);
}
