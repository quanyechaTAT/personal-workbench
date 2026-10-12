import { stripTypeScriptTypes } from "node:module";
import { createContext, Script } from "node:vm";

const send = (value: unknown) => {
	if (process.connected) process.send?.(value);
};
let deliver: ((encoded: string) => void) | undefined;
process.on("message", (value: unknown) => {
	if (typeof value !== "object" || value === null || !("type" in value)) return;
	if (value.type === "result") {
		deliver?.(JSON.stringify(value));
		return;
	}
	if (
		value.type !== "start" ||
		!("code" in value) ||
		typeof value.code !== "string" ||
		!("tools" in value) ||
		!Array.isArray(value.tools) ||
		!value.tools.every((name) => typeof name === "string")
	)
		return;
	const { code, tools } = value;
	void (async () => {
		try {
			const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
			// All model-visible functions and promises belong to the VM realm. The host bridge
			// is captured in a closure and accepts/returns only serialized data.
			const install = new Script(`(function(bridge, encodedNames) {
				const pending = new Map(); const inFlight = new Set(); let nextId = 0;
				const tools = Object.create(null);
				for (const name of JSON.parse(encodedNames)) tools[name] = async (args) => {
					const id = String(++nextId);
					const promise = new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
					inFlight.add(promise);
					bridge(JSON.stringify({type: "call", id, name, args}));
					try { return await promise; } finally { inFlight.delete(promise); }
				};
				const print = (...args) => bridge(JSON.stringify({type: "output", text: args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ").slice(0, 16000)}));
				return {tools: Object.freeze(tools), console: Object.freeze({log: print, info: print, warn: print, error: print}),
					deliver: encoded => { const response = JSON.parse(encoded); const waiter = pending.get(response.id); if (!waiter) return; pending.delete(response.id); response.error ? waiter.reject(new Error(response.error)) : waiter.resolve(response.result); },
					drain: () => Promise.allSettled([...inFlight])};
			})`).runInContext(context) as (
				bridge: (encoded: string) => void,
				names: string,
			) => {
				tools: unknown;
				console: unknown;
				deliver(encoded: string): void;
				drain(): Promise<unknown>;
			};
			const runtime = install((encoded) => {
				try {
					send(JSON.parse(encoded));
				} catch {
					/* The parent is closing. */
				}
			}, JSON.stringify(tools));
			deliver = runtime.deliver;
			context.tools = runtime.tools;
			context.console = runtime.console;
			const program = stripTypeScriptTypes(
				`async function __workbench_program() {\n${code}\n}\n__workbench_program()`,
				{ mode: "strip" },
			);
			const result: unknown = await new Script(program, { filename: "workbench-program.ts" }).runInContext(context, {
				timeout: 1_000,
			});
			await runtime.drain();
			// Serialize inside the isolated process; getters and toJSON cannot run in the host.
			const returned = result === undefined ? undefined : JSON.stringify(result)?.slice(0, 16_000);
			send({ type: "done", returned });
		} catch (error) {
			send({ type: "done", error: error instanceof Error ? error.message : String(error) });
		}
	})();
});
