import { randomUUID } from "node:crypto";
import { WorkbenchError } from "@earendil-works/workbench-core";
import {
	type BrowserUseInput,
	BrowserUseSchema,
	type InteractionResult,
} from "@earendil-works/workbench-core/contracts";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { Parse } from "typebox/value";

interface BrowserSession {
	browser: Browser;
	context: BrowserContext;
	pages: Map<string, Page>;
	activeId?: string;
}

/** Owns isolated browser profiles. Never attaches to the user's existing browser or cookies. */
export class BrowserUseService {
	private readonly sessions = new Map<string, BrowserSession>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly headless: boolean;
	private disposed = false;
	constructor(options: { headless?: boolean } = {}) {
		this.headless = options.headless ?? false;
	}

	async execute(sessionId: string, input: BrowserUseInput, signal?: AbortSignal): Promise<InteractionResult> {
		let parsed: BrowserUseInput;
		try {
			parsed = Parse(BrowserUseSchema, input);
		} catch {
			throw new WorkbenchError("invalid_input", "浏览器工具参数无效");
		}
		const operation = (this.queues.get(sessionId) ?? Promise.resolve()).then(() =>
			this.perform(sessionId, parsed, signal),
		);
		const settled = operation.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(sessionId, settled);
		try {
			return await operation;
		} finally {
			if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId);
		}
	}

	private async perform(sessionId: string, input: BrowserUseInput, signal?: AbortSignal): Promise<InteractionResult> {
		signal?.throwIfAborted();
		if (this.disposed) throw new WorkbenchError("conflict", "浏览器工具已关闭");
		let session = this.sessions.get(sessionId);
		if (input.action === "tabs") return this.result({ tabs: session ? this.tabs(session) : [] });
		if (input.action === "close" && !input.tabId) {
			await this.closeSession(sessionId);
			return this.result({ closed: true, tabs: [] });
		}
		if (input.action === "open") {
			let url: URL;
			try {
				url = new URL(input.url);
			} catch {
				throw new WorkbenchError("invalid_input", "请输入完整 HTTP 或 HTTPS 地址");
			}
			if (!["http:", "https:"].includes(url.protocol))
				throw new WorkbenchError("invalid_input", "浏览器工具仅支持 HTTP 和 HTTPS 页面");
			if (!session) {
				if (input.tabId) throw new WorkbenchError("not_found", "浏览器标签页不存在");
				if (this.sessions.size >= 8) throw new WorkbenchError("conflict", "请关闭不再使用的浏览器会话");
				const browser = await chromium.launch({
					channel: process.platform === "win32" ? "msedge" : "chromium",
					headless: this.headless,
					timeout: 15_000,
					chromiumSandbox: true,
				});
				try {
					signal?.throwIfAborted();
					const context = await browser.newContext({
						acceptDownloads: false,
						viewport: { width: 1280, height: 900 },
					});
					signal?.throwIfAborted();
					session = { browser, context, pages: new Map() };
					const active = session;
					browser.on("disconnected", () => {
						if (this.sessions.get(sessionId) === active) this.sessions.delete(sessionId);
					});
					context.on("page", (page) => {
						const id = randomUUID();
						active.pages.set(id, page);
						active.activeId = id;
						page.on("close", () => {
							active.pages.delete(id);
							if (active.activeId === id) active.activeId = active.pages.keys().next().value;
						});
					});
					this.sessions.set(sessionId, session);
				} catch (error) {
					await browser.close();
					throw error;
				}
			}
			const page = input.tabId ? this.page(session, input.tabId) : await session.context.newPage();
			await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 20_000, signal });
			return this.snapshot(session, page, signal);
		}
		if (!session) throw new WorkbenchError("not_found", "请先使用 browser_use open 打开页面");
		const page = this.page(session, input.tabId);
		const settings = { timeout: 10_000, signal };
		if (input.action === "click")
			await page.locator(`aria-ref=${input.ref}`).click({ ...settings, button: input.button });
		else if (input.action === "fill") await page.locator(`aria-ref=${input.ref}`).fill(input.text, settings);
		else if (input.action === "press") await page.locator(`aria-ref=${input.ref}`).press(input.key, settings);
		else if (input.action === "scroll") await page.mouse.wheel(0, input.deltaY);
		else if (input.action === "back") await page.goBack({ ...settings, waitUntil: "domcontentloaded" });
		else if (input.action === "close") {
			await page.close();
			return this.result({ closed: true, tabs: this.tabs(session) });
		}
		signal?.throwIfAborted();
		if (input.action === "screenshot") {
			const png = await page.screenshot({ type: "png", ...settings });
			const result = this.result({ tabId: this.idFor(session, page), url: page.url(), width: 1280, height: 900 });
			result.content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
			return result;
		}
		return this.snapshot(session, page, signal);
	}

	private page(session: BrowserSession, requested?: string): Page {
		const id = requested ?? session.activeId;
		const page = id ? session.pages.get(id) : undefined;
		if (!page || page.isClosed()) throw new WorkbenchError("not_found", "浏览器标签页不存在，请重新读取 tabs");
		session.activeId = id;
		return page;
	}
	private idFor(session: BrowserSession, page: Page): string | undefined {
		return [...session.pages].find(([, value]) => value === page)?.[0];
	}
	private tabs(session: BrowserSession) {
		return [...session.pages].map(([id, page]) => ({ id, url: page.url(), active: id === session.activeId }));
	}
	private async snapshot(session: BrowserSession, page: Page, signal?: AbortSignal): Promise<InteractionResult> {
		const snapshot = await page.ariaSnapshot({ mode: "ai", signal, timeout: 10_000 });
		return this.result({
			tabId: this.idFor(session, page),
			url: page.url(),
			title: await page.title(),
			tabs: this.tabs(session),
			snapshot: snapshot.slice(0, 32_000),
			truncated: snapshot.length > 32_000,
		});
	}
	private result(details: Record<string, unknown>): InteractionResult {
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}
	async closeSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.sessions.delete(sessionId);
		await session.browser.close();
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await Promise.all(this.queues.values());
		await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
	}
}
