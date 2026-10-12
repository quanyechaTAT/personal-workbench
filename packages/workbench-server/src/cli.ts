import { createWorkbenchApplication } from "./application.ts";
import { parseWorkbenchPort, startWorkbenchServer } from "./server-start.ts";
import { closeWorkbench } from "./shutdown.ts";

async function main(): Promise<void> {
	const port = parseWorkbenchPort(process.env.PERSONAL_WORKBENCH_PORT);
	const application = await createWorkbenchApplication({ dataRoot: process.env.PERSONAL_WORKBENCH_HOME });
	const started = await startWorkbenchServer(application, {
		port,
		onPortFallback: ({ port: preferredPort, code }) => {
			process.stdout.write(`Port ${preferredPort} is unavailable (${code}); selecting a free loopback port.\n`);
		},
	}).catch(async (error: unknown) => {
		try {
			await application.close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Workbench startup failed and cleanup also failed");
		}
		throw error;
	});
	const { server } = started;
	process.stdout.write(`Personal Workbench: ${started.launchUrl}\n`);
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		await closeWorkbench(server, application);
	};
	const stopAndExit = () => {
		void stop().then(
			() => process.exit(0),
			(error: unknown) => {
				process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
				process.exit(1);
			},
		);
	};
	process.once("SIGINT", stopAndExit);
	process.once("SIGTERM", stopAndExit);
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
