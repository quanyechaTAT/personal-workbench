import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
	AgentSession,
	AgentSessionEvent,
	AgentToolResult,
	ExtensionFactory,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "@earendil-works/workbench-runtime";
import { Type } from "typebox";
import { Parse } from "typebox/value";

export interface PtcCallRecord {
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	result: AgentToolResult<unknown>;
	isError: boolean;
}
type ToolEvent = Extract<
	AgentSessionEvent,
	{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;

export interface PtcExtensionOptions {
	getSession(): AgentSession;
	toolNames: string[];
	onToolEvent(event: ToolEvent): void;
	setToolSignal(toolCallId: string, signal?: AbortSignal): void;
}

function schemaType(schema: unknown): string {
	if (typeof schema !== "object" || schema === null) return "unknown";
	const value = schema as Record<string, unknown>;
	if (Array.isArray(value.enum)) return value.enum.map((item) => JSON.stringify(item)).join(" | ") || "unknown";
	if ("const" in value) return JSON.stringify(value.const);
	if (Array.isArray(value.anyOf) || Array.isArray(value.oneOf))
		return ((value.anyOf as unknown[]) ?? (value.oneOf as unknown[])).map(schemaType).join(" | ");
	if (value.type === "string") return "string";
	if (value.type === "number" || value.type === "integer") return "number";
	if (value.type === "boolean") return "boolean";
	if (value.type === "null") return "null";
	if (value.type === "array") return `Array<${schemaType(value.items)}>`;
	if (value.type === "object" && typeof value.properties === "object" && value.properties !== null) {
		const required = Array.isArray(value.required) ? value.required : [];
		return `{ ${Object.entries(value.properties)
			.map(
				([key, property]) => `${JSON.stringify(key)}${required.includes(key) ? "" : "?"}: ${schemaType(property)}`,
			)
			.join("; ")} }`;
	}
	return "unknown";
}

function sdkPrompt(tools: ToolInfo[]): string {
	return `PTC tool SDK (only these tools are available). Write TypeScript in run_code; top-level await and return are supported. No imports, process, require, filesystem or network APIs. Call tools instead. Tool errors reject; use try/catch where useful. Use console.log or return to select what reaches the model. Each result has content (text or image) and details; text files are in result.content[].text, JSON tools encode JSON in text. Images are attached automatically. Nested calls obey session permissions and are recorded. At most 64 calls per program; output is capped at 16000 characters.\n\ninterface ToolResult { content: Array<{type: "text"; text: string} | {type: "image"; data: string; mimeType: string}>; details: unknown }\ndeclare const tools: {\n${tools.map((tool) => `/** ${tool.description.replaceAll("*/", "* /")} */\n${JSON.stringify(tool.name)}(args: ${schemaType(tool.parameters)}): Promise<ToolResult>;`).join("\n")}\n};`;
}

export function createPtcExtension(options: PtcExtensionOptions): ExtensionFactory {
	return (pi) => {
		pi.on("tool_result", (event) => {
			if (
				event.toolName === "run_code" &&
				typeof event.details === "object" &&
				event.details !== null &&
				"ptcError" in event.details &&
				event.details.ptcError === true
			)
				return { isError: true };
		});
		pi.on("before_agent_start", (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${sdkPrompt(pi.getAllTools().filter((tool) => options.toolNames.includes(tool.name) && tool.name !== "run_code"))}`,
		}));
		pi.registerTool({
			name: "run_code",
			label: "程序调用工具",
			description:
				"Run a TypeScript program using the generated tools SDK. Supports await, return, loops, conditions and Promise.all. Print or return only useful results. Nested tool calls retain permissions and cancellation. No direct host APIs.",
			parameters: Type.Object({
				code: Type.String({ minLength: 1, maxLength: 32_000 }),
				timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
			}),
			execute: async (parentId, input, outerSignal) => {
				outerSignal?.throwIfAborted();
				const session = options.getSession();
				const tools = new Map(
					session
						.getAllTools()
						.filter((tool) => options.toolNames.includes(tool.name) && tool.name !== "run_code")
						.map((tool) => [tool.name, tool]),
				);
				const source = import.meta.url.endsWith(".ts") ? "./ptc-worker.ts" : "./ptc-worker.js";
				const workerPath = fileURLToPath(new URL(source, import.meta.url));
				const child = spawn(
					process.execPath,
					[
						"--permission",
						`--allow-fs-read=${workerPath}`,
						"--max-old-space-size=96",
						...(source.endsWith(".ts") ? ["--experimental-strip-types"] : []),
						workerPath,
					],
					{ env: {}, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
				);
				const controller = new AbortController();
				const calls: PtcCallRecord[] = [];
				const pending = new Set<Promise<void>>();
				const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
				let output = "";
				let accepting = true;
				let callCount = 0;
				let failure: ((error: Error) => void) | undefined;
				const abort = (message = "程序调用已取消") => {
					accepting = false;
					controller.abort();
					child.kill();
					failure?.(new Error(message));
				};
				const onAbort = () => abort();
				outerSignal?.addEventListener("abort", onAbort, { once: true });
				const timer = setTimeout(
					() => abort("程序调用超时，未完成的工具调用已取消"),
					(input.timeout ?? 120) * 1_000,
				);
				const emit = async (event: ToolEvent) => {
					await session.extensionRunner.emit(event);
					options.onToolEvent(event);
				};
				const invoke = async (id: string, name: string, args: Record<string, unknown>) => {
					const toolCallId = `${parentId}:${id}`;
					let result: AgentToolResult<unknown> = { content: [], details: {} };
					let isError = false;
					let updates = Promise.resolve();
					options.setToolSignal(toolCallId, controller.signal);
					try {
						await emit({ type: "tool_execution_start", toolCallId, toolName: name, args });
						const info = tools.get(name);
						const definition = info ? session.getToolDefinition(name) : undefined;
						if (!info || !definition) throw new Error(`Tool is not selected for this assistant: ${name}`);
						const parameters = Parse(info.parameters, definition.prepareArguments?.(args) ?? args) as Record<
							string,
							unknown
						>;
						const blocked = await session.extensionRunner.emitToolCall({
							type: "tool_call",
							toolName: name,
							toolCallId,
							input: parameters,
						});
						controller.signal.throwIfAborted();
						if (blocked?.block) throw new Error(blocked.reason ?? "Tool operation denied");
						result = await definition.execute(
							toolCallId,
							parameters,
							controller.signal,
							(partialResult) => {
								updates = updates
									.then(() =>
										emit({ type: "tool_execution_update", toolCallId, toolName: name, args, partialResult }),
									)
									.catch((error: unknown) => abort(errorMessage(error)));
							},
							{ ...session.extensionRunner.createContext(), signal: controller.signal },
						);
					} catch (error) {
						isError = true;
						result = { content: [{ type: "text", text: errorMessage(error) }], details: {} };
					}
					try {
						await updates;
						const adjusted = await session.extensionRunner.emitToolResult({
							type: "tool_result",
							toolName: name,
							toolCallId,
							input: args,
							content: result.content,
							details: result.details,
							isError,
						});
						result = {
							content: adjusted?.content ?? result.content,
							details: adjusted?.details ?? result.details,
						};
						isError = adjusted?.isError ?? isError;
						calls.push({
							toolCallId,
							toolName: name,
							arguments: args,
							result: {
								...result,
								content: result.content.map((part) =>
									part.type === "text" ? part : { type: "text", text: `[image ${part.mimeType}]` },
								),
							},
							isError,
						});
						for (const part of result.content) if (part.type === "image" && images.length < 8) images.push(part);
						await emit({ type: "tool_execution_end", toolCallId, toolName: name, result, isError });
						if (child.connected && accepting)
							child.send({
								type: "result",
								id,
								...(isError
									? {
											error: result.content
												.filter((part) => part.type === "text")
												.map((part) => part.text)
												.join("\n"),
										}
									: { result }),
							});
					} finally {
						options.setToolSignal(toolCallId);
					}
				};
				let returned: string | undefined;
				let programError: string | undefined;
				try {
					returned = await new Promise<string | undefined>((resolve, reject) => {
						failure = reject;
						child.on("error", reject);
						child.on("exit", () => reject(new Error("程序进程已退出")));
						child.on("message", (value: unknown) => {
							if (!accepting || typeof value !== "object" || value === null || !("type" in value)) return;
							if (value.type === "output" && "text" in value && typeof value.text === "string") {
								output = `${output}${value.text}\n`.slice(0, 16_000);
								return;
							}
							if (value.type === "done") {
								accepting = false;
								if ("error" in value && typeof value.error === "string") reject(new Error(value.error));
								else
									resolve(
										"returned" in value && typeof value.returned === "string" ? value.returned : undefined,
									);
								return;
							}
							if (
								value.type !== "call" ||
								!("id" in value) ||
								typeof value.id !== "string" ||
								!("name" in value) ||
								typeof value.name !== "string" ||
								!("args" in value) ||
								typeof value.args !== "object" ||
								value.args === null ||
								Array.isArray(value.args)
							) {
								abort("Invalid program tool call");
								return;
							}
							if (++callCount > 64) {
								abort("程序调用超过 64 次工具调用上限");
								return;
							}
							const operation = invoke(value.id, value.name, value.args as Record<string, unknown>);
							pending.add(operation);
							void operation
								.catch((error: unknown) => abort(errorMessage(error)))
								.finally(() => pending.delete(operation));
						});
						child.send({ type: "start", code: input.code, tools: [...tools.keys()] });
					});
					await Promise.all([...pending]);
				} catch (error) {
					programError = errorMessage(error);
				} finally {
					clearTimeout(timer);
					outerSignal?.removeEventListener("abort", onAbort);
					accepting = false;
					controller.abort();
					child.kill();
					await Promise.allSettled([...pending]);
				}
				return {
					content: [
						{
							type: "text" as const,
							text:
								(programError
									? `${output.slice(0, 12_000)}\n${programError.slice(0, 4_000)}`
									: `${output}${returned ?? ""}`.slice(0, 16_000)) || "(program completed without output)",
						},
						...images,
					],
					details: { ptcCalls: calls, ...(programError ? { ptcError: true } : {}) },
				};
			},
		});
	};
}
