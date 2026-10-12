import { createHash } from "node:crypto";
import type { McpToolRecord } from "@earendil-works/workbench-core";
import type { Tool } from "@modelcontextprotocol/client";
import { McpWorkbenchError } from "./errors.ts";
import type { McpSchemaValidator } from "./schema-validator.ts";

export function toolRecords(
	connectionId: string,
	tools: readonly Tool[],
	discoveredAt: string,
	validator: McpSchemaValidator,
): McpToolRecord[] {
	return tools.map((tool) => {
		const schema = asSchema(tool.inputSchema);
		const definitionHash = hashDefinition({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: schema,
			annotations: tool.annotations,
		});
		let diagnostic: string | undefined;
		try {
			validator.assertSupported(schema, definitionHash);
		} catch (error) {
			if (!(error instanceof McpWorkbenchError)) throw error;
			diagnostic = error.message;
		}
		return {
			diagnostic,
			connectionId,
			name: tool.name,
			title: tool.title,
			description: tool.description ?? "",
			inputSchema: schema,
			definitionHash,
			readOnlyHint: tool.annotations?.readOnlyHint,
			destructiveHint: tool.annotations?.destructiveHint,
			discoveredAt,
		};
	});
}

function asSchema(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { type: "object" };
	return value as Record<string, unknown>;
}

function hashDefinition(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(sortValue(value)))
		.digest("hex");
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, sortValue(entry)]),
	);
}
