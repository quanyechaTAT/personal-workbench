import type { WorkbenchApplication } from "./application.ts";
import { WorkbenchHttpServer, type WorkbenchServerOptions } from "./http-server.ts";

export interface PortFallbackNotice {
	port: number;
	code: "EACCES" | "EADDRINUSE";
}

export interface StartWorkbenchServerOptions extends WorkbenchServerOptions {
	onPortFallback?: (notice: PortFallbackNotice) => void;
}

export function parseWorkbenchPort(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const port = Number(value);
	if (!/^\d+$/u.test(value.trim()) || !Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error("PERSONAL_WORKBENCH_PORT must be an integer from 0 to 65535; use 0 to select a free port");
	}
	return port;
}

export async function startWorkbenchServer(
	application: WorkbenchApplication,
	options: StartWorkbenchServerOptions = {},
): Promise<{ server: WorkbenchHttpServer; origin: string; launchUrl: string; token: string }> {
	const { onPortFallback, ...serverOptions } = options;
	const ports = serverOptions.port === undefined ? [4242, 0] : [serverOptions.port];
	for (const port of ports) {
		const server = new WorkbenchHttpServer(application, { ...serverOptions, port });
		try {
			return { server, ...(await server.start()) };
		} catch (error) {
			await server.close();
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code !== "EACCES" && code !== "EADDRINUSE") throw error;
			if (serverOptions.port !== undefined || port === 0) {
				throw new Error(
					`Cannot open Workbench loopback port ${port} (${code}). The port may be reserved or in use. Set PERSONAL_WORKBENCH_PORT to another port, or 0 to select a free port.`,
					{ cause: error },
				);
			}
			await application.logger.log("server.listen.fallback", { preferredPort: port, code });
			onPortFallback?.({ port, code });
		}
	}
	throw new Error("Workbench could not select a listening port");
}
