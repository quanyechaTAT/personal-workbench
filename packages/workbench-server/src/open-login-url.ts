import { spawn } from "node:child_process";

/** Match Pi's native opener without a shell or an asynchronous browser popup. */
export async function openLoginUrl(url: string): Promise<void> {
	const [command, args] =
		process.platform === "win32"
			? ["rundll32", ["url.dll,FileProtocolHandler", url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
