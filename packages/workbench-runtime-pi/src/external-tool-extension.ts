import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
	RuntimeToolLease,
	RuntimeToolProgress,
	RuntimeToolResult,
	RuntimeToolScope,
} from "@earendil-works/workbench-runtime";
import { type TSchema, Unsafe } from "typebox";

interface ExternalToolDetails {
	workbenchExternalTool: true;
	toolId: string;
	toolLabel?: string;
	isError: boolean;
	structuredContent?: unknown;
	truncated?: boolean;
	progress?: RuntimeToolProgress;
}

export interface ExternalToolExtensionOptions {
	lease: RuntimeToolLease;
	scope: RuntimeToolScope;
	runtimeSessionId: string;
	getRunId(): string | undefined;
}

export function createExternalToolExtension(options: ExternalToolExtensionOptions): ExtensionFactory {
	return (pi) => {
		for (const tool of options.lease.tools) {
			pi.registerTool({
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: Unsafe<Record<string, unknown>>(tool.inputSchema as TSchema),
				executionMode: "sequential",
				execute: async (toolCallId, params, signal, onUpdate) => {
					const runId = options.getRunId();
					if (!runId) throw new Error("External tool was called without an active Workbench run");
					const abortSignal = signal ?? new AbortController().signal;
					const result = await options.lease.call(
						{
							toolId: tool.id,
							arguments: params,
							sessionId: options.scope.workbenchSessionId,
							runtimeSessionId: options.runtimeSessionId,
							runId,
							toolCallId,
						},
						{
							signal: abortSignal,
							onProgress: (progress) => {
								onUpdate?.({
									content: progress.message ? [{ type: "text", text: progress.message }] : [],
									details: { ...details(tool.id, false, undefined, progress), toolLabel: tool.label },
								});
							},
						},
					);
					return {
						content: piContent(result),
						details: { ...details(tool.id, result.isError, result), toolLabel: tool.label },
					};
				},
			});
		}
		pi.on("tool_result", (event) => {
			if (!isExternalDetails(event.details)) return undefined;
			return { isError: event.details.isError };
		});
	};
}

function piContent(
	result: RuntimeToolResult,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	return result.content.map((content) => {
		if (content.type === "text") return content;
		if (content.type === "image") return content;
		return { type: "text", text: `${content.name}: ${content.uri}` };
	});
}

function details(
	toolId: string,
	isError: boolean,
	result?: RuntimeToolResult,
	progress?: RuntimeToolProgress,
): ExternalToolDetails {
	return {
		workbenchExternalTool: true,
		toolId,
		isError,
		structuredContent: result?.structuredContent,
		truncated: result?.truncated,
		progress,
	};
}

function isExternalDetails(value: unknown): value is ExternalToolDetails {
	return (
		typeof value === "object" &&
		value !== null &&
		"workbenchExternalTool" in value &&
		value.workbenchExternalTool === true &&
		"isError" in value &&
		typeof value.isError === "boolean"
	);
}
