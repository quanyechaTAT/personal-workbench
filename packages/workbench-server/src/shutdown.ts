export interface CloseableResource {
	close(): Promise<void>;
}

export interface ShutdownTimeouts {
	serverMs?: number;
	applicationMs?: number;
}

const DEFAULT_SERVER_TIMEOUT_MS = 5_000;
const DEFAULT_APPLICATION_TIMEOUT_MS = 10_000;

async function closeWithin(resource: CloseableResource, label: string, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			resource.close(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} did not close within ${timeoutMs} ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function closeWorkbench(
	server: CloseableResource,
	application: CloseableResource,
	timeouts: ShutdownTimeouts = {},
): Promise<void> {
	const errors: unknown[] = [];
	try {
		await closeWithin(server, "Workbench HTTP server", timeouts.serverMs ?? DEFAULT_SERVER_TIMEOUT_MS);
	} catch (error) {
		errors.push(error);
	}
	try {
		await closeWithin(application, "Workbench application", timeouts.applicationMs ?? DEFAULT_APPLICATION_TIMEOUT_MS);
	} catch (error) {
		errors.push(error);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Personal Workbench shutdown failed");
}
