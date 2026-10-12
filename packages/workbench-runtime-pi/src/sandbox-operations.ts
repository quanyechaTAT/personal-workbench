import { resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { TerminalSessions } from "./terminal-sessions.ts";

/** The same sandbox and process-tree lifetime used by resumable terminals. */
export function createSandboxOperations(
	terminals: TerminalSessions,
	workspace: string,
	shell: "powershell" | "bash",
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			if (resolve(cwd) !== resolve(workspace)) throw new Error("Shell 工作目录与会话沙箱不一致");
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) controller.abort();
			let timedOut = false;
			const timer =
				timeout === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeout * 1000);
			let id: string | undefined;
			try {
				let result = await terminals.start(command, 0, 64_000, controller.signal, shell);
				id = result.session_id;
				while (true) {
					if (result.output) onData(Buffer.from(result.output));
					if (result.truncated) onData(Buffer.from("\n[terminal output truncated]\n"));
					if (result.status !== "running" && !result.more_output) return { exitCode: result.exit_code };
					result = await terminals.read(id, "", result.more_output ? 0 : 250, 64_000, controller.signal);
				}
			} catch (error) {
				if (timedOut) throw new Error(`timeout:${timeout}`);
				if (signal?.aborted) throw new Error("aborted");
				throw error;
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (id) await terminals.close(id);
			}
		},
	};
}
