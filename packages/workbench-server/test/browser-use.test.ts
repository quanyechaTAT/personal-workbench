import { createServer } from "node:http";
import type { Browser } from "playwright";
import { expect, test, vi } from "vitest";
import { BrowserUseService } from "../src/browser-use.ts";

test("browser use operates real pages, returns semantic references and images, and isolates conversations", async () => {
	const server = createServer((_req, res) => {
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end(
			"<label>姓名<input aria-label=\"姓名\"></label><button onclick=\"document.querySelector('output').textContent=document.querySelector('input').value\">保存</button><output></output>",
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No address");
	const browser = new BrowserUseService({ headless: true });
	try {
		const opened = await browser.execute("a", { action: "open", url: `http://127.0.0.1:${address.port}` });
		const snapshot = JSON.stringify(opened.details);
		const inputRef = /textbox[^\n]*\[ref=([^\]]+)\]/u.exec(snapshot.replaceAll("\\n", "\n"))?.[1];
		const buttonRef = /button[^\n]*\[ref=([^\]]+)\]/u.exec(snapshot.replaceAll("\\n", "\n"))?.[1];
		expect(inputRef, snapshot).toBeDefined();
		expect(buttonRef, snapshot).toBeDefined();
		await browser.execute("a", { action: "fill", ref: inputRef!, text: "中文输入" });
		const clicked = await browser.execute("a", { action: "click", ref: buttonRef! });
		expect(JSON.stringify(clicked.details)).toContain("中文输入");
		const image = await browser.execute("a", { action: "screenshot" });
		expect(image.content.find((part) => part.type === "image")).toMatchObject({ mimeType: "image/png" });
		expect((await browser.execute("b", { action: "tabs" })).details.tabs).toEqual([]);
		await expect(browser.execute("a", { action: "open", url: "file:///C:/Windows/win.ini" })).rejects.toThrow(
			/HTTP/u,
		);
		const controller = new AbortController();
		const pending = browser.execute("a", { action: "fill", ref: "e999999", text: "停止后不输入" }, controller.signal);
		setTimeout(() => controller.abort(), 150);
		await expect(pending).rejects.toThrow();
		expect(JSON.stringify((await browser.execute("a", { action: "snapshot" })).details)).not.toContain(
			"停止后不输入",
		);
		// Closing the real browser simulates the user closing its native window.
		const sessions = Reflect.get(browser, "sessions") as Map<string, { browser: Browser }>;
		await sessions.get("a")!.browser.close();
		await vi.waitFor(async () => expect((await browser.execute("a", { action: "tabs" })).details.tabs).toEqual([]));
		expect(
			(await browser.execute("a", { action: "open", url: `http://127.0.0.1:${address.port}` })).details.snapshot,
		).toContain("姓名");
		await browser.execute("a", { action: "close" });
		expect((await browser.execute("a", { action: "tabs" })).details.tabs).toEqual([]);
	} finally {
		await browser.dispose();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}, 30_000);
