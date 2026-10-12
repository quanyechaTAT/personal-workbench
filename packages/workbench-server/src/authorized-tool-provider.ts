import type { McpConnectionRepository, PermissionService } from "@earendil-works/workbench-core";
import { WorkbenchError } from "@earendil-works/workbench-core";
import type {
	RuntimeToolBinding,
	RuntimeToolCall,
	RuntimeToolLease,
	RuntimeToolProgress,
	RuntimeToolProvider,
	RuntimeToolScope,
} from "@earendil-works/workbench-runtime";
import { sanitizeDiagnostic } from "./logger.ts";

export class AuthorizedToolProvider implements RuntimeToolProvider {
	private readonly provider: RuntimeToolProvider;
	private readonly connections: McpConnectionRepository;
	private readonly permissions: Pick<PermissionService, "request" | "resolve" | "requiresApproval">;

	constructor(
		provider: RuntimeToolProvider,
		connections: McpConnectionRepository,
		permissions: Pick<PermissionService, "request" | "resolve" | "requiresApproval">,
	) {
		this.provider = provider;
		this.connections = connections;
		this.permissions = permissions;
	}

	async open(scope: RuntimeToolScope, bindings: readonly RuntimeToolBinding[]): Promise<RuntimeToolLease> {
		const lease = await this.provider.open(scope, bindings);
		const byId = new Map(bindings.map((binding) => [binding.descriptor.id, binding]));
		return {
			tools: lease.tools,
			call: async (input, options) => {
				const binding = byId.get(input.toolId);
				if (!binding)
					throw new WorkbenchError("path_denied", `Tool is not bound to this assistant: ${input.toolId}`);
				await this.assertCurrent(binding);
				if (await this.permissions.requiresApproval(input.sessionId, "mcp", binding.approval === "allow"))
					await this.waitForApproval(binding, input, options);
				await this.assertCurrent(binding);
				return lease.call(input, options);
			},
			close: () => lease.close(),
		};
	}

	dispose(): Promise<void> {
		return this.provider.dispose();
	}

	private async assertCurrent(binding: RuntimeToolBinding): Promise<void> {
		const connection = await this.connections.get(binding.resourceId);
		if (!connection?.enabled) throw new WorkbenchError("path_denied", "MCP connection is disabled");
		const tool = (await this.connections.listTools(binding.resourceId)).find(
			(candidate) => candidate.name === binding.resourceToolName,
		);
		if (!tool || tool.definitionHash !== binding.descriptor.definitionHash) {
			throw new WorkbenchError("path_denied", "MCP tool definition changed and requires approval");
		}
	}

	private async waitForApproval(
		binding: RuntimeToolBinding,
		input: RuntimeToolCall,
		options: { signal: AbortSignal; onProgress(progress: RuntimeToolProgress): void },
	): Promise<void> {
		const pending = await this.permissions.request({
			sessionId: input.sessionId,
			runId: input.runId,
			toolCallId: input.toolCallId,
			toolName: binding.descriptor.name,
			policy: { kind: "mcp", explicitlyAllowed: binding.approval === "allow" },
			operation: {
				toolId: input.toolId,
				label: binding.descriptor.label,
				arguments: sanitizeDiagnostic(input.arguments),
			},
		});
		options.onProgress({
			message: `等待批准：${binding.descriptor.label}`,
			data: { approvalId: pending.approval.id, status: "pending" },
		});
		let cancel: () => void = () => undefined;
		const cancelled = new Promise<"cancelled">((resolve) => {
			cancel = () => resolve("cancelled");
			if (options.signal.aborted) cancel();
			else options.signal.addEventListener("abort", cancel, { once: true });
		});
		const decision = await Promise.race([pending.decision, cancelled]).finally(() =>
			options.signal.removeEventListener("abort", cancel),
		);
		if (decision === "cancelled") {
			await this.permissions.resolve(pending.approval.id, "cancelled").catch((error: unknown) => {
				if (!(error instanceof WorkbenchError) || error.code !== "permission_resolved") throw error;
			});
		}
		if (decision !== "approved") throw new WorkbenchError("path_denied", `MCP tool call ${decision}`);
	}
}
