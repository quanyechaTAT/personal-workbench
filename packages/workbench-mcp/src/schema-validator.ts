import { Ajv } from "ajv";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { McpWorkbenchError } from "./errors.ts";

export class McpSchemaValidator {
	private readonly ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
	private readonly draft7 = new Ajv({ allErrors: true, strict: false, validateFormats: false });
	private readonly cache = new Map<string, ValidateFunction>();

	assertSupported(schema: Record<string, unknown>, cacheKey?: string): void {
		this.compile(schema, cacheKey);
	}

	validateArguments(schema: Record<string, unknown>, value: unknown, cacheKey?: string): void {
		const validate = this.compile(schema, cacheKey);
		if (validate(value)) return;
		throw new McpWorkbenchError("invalid_arguments", formatErrors(validate.errors));
	}

	private compile(schema: Record<string, unknown>, cacheKey?: string): ValidateFunction {
		if (cacheKey) {
			const existing = this.cache.get(cacheKey);
			if (existing) return existing;
		}
		assertNoExternalReferences(schema);
		let validate: ValidateFunction;
		try {
			validate = (
				typeof schema.$schema === "string" && schema.$schema.includes("draft-07") ? this.draft7 : this.ajv
			).compile(schema);
		} catch (error) {
			throw new McpWorkbenchError("invalid_schema", `Unsupported MCP tool schema: ${String(error)}`, {
				cause: error,
			});
		}
		if (cacheKey) this.cache.set(cacheKey, validate);
		return validate;
	}
}

function assertNoExternalReferences(value: unknown): void {
	if (Array.isArray(value)) {
		for (const entry of value) assertNoExternalReferences(entry);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if ((key === "$ref" || key === "$dynamicRef") && typeof entry === "string" && !entry.startsWith("#")) {
			throw new McpWorkbenchError("invalid_schema", `External JSON Schema reference is not allowed: ${entry}`);
		}
		assertNoExternalReferences(entry);
	}
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
	if (!errors || errors.length === 0) return "MCP tool arguments do not match the advertised schema";
	return errors
		.slice(0, 8)
		.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
		.join("; ");
}
