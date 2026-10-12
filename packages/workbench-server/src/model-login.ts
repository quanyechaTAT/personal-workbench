import { randomUUID } from "node:crypto";
import { WorkbenchError } from "@earendil-works/workbench-core";
import type {
	ModelLoginState,
	RuntimeAuthPrompt,
	RuntimeAuthType,
	RuntimeModelCatalog,
} from "@earendil-works/workbench-runtime";
import { openLoginUrl } from "./open-login-url.ts";

interface LoginSession {
	state: ModelLoginState;
	controller: AbortController;
	timer: ReturnType<typeof setTimeout>;
	completion: Promise<void>;
	answer?: (value: string) => void;
}

/** Bridges Pi's interactive login to short HTTP requests; Pi owns OAuth and storage. */
export class ModelLoginService {
	private readonly catalog?: RuntimeModelCatalog;
	private readonly sessions = new Map<string, LoginSession>();
	private closed = false;
	private readonly openUrl: (url: string) => Promise<void>;

	constructor(catalog?: RuntimeModelCatalog, openUrl = openLoginUrl) {
		this.catalog = catalog;
		this.openUrl = openUrl;
	}

	async start(providerId: string, authType: RuntimeAuthType): Promise<ModelLoginState> {
		if (!this.catalog?.login) throw new WorkbenchError("conflict", "当前运行时不支持原生模型登录");
		const provider = (await this.catalog.providers()).find((entry) => entry.id === providerId);
		if (!provider?.authMethods?.some((method) => method.type === authType))
			throw new WorkbenchError("invalid_input", "该供应商不支持所选 Pi 登录方式");
		if (this.closed) throw new WorkbenchError("conflict", "模型登录服务已关闭");
		if (
			[...this.sessions.values()].some(
				(login) => login.state.providerId === providerId && ["running", "waiting"].includes(login.state.status),
			)
		)
			throw new WorkbenchError("conflict", "该供应商的登录已经打开");
		for (const [id, login] of this.sessions) {
			if (this.sessions.size < 20) break;
			if (!["running", "waiting"].includes(login.state.status)) this.sessions.delete(id);
		}
		if (this.sessions.size >= 20) throw new WorkbenchError("conflict", "请先结束现有的模型登录");
		const controller = new AbortController();
		const state: ModelLoginState = { id: randomUUID(), providerId, authType, status: "running", events: [] };
		const login: LoginSession = {
			state,
			controller,
			timer: setTimeout(() => this.cancel(state.id), 15 * 60_000),
			completion: Promise.resolve(),
		};
		login.timer.unref();
		this.sessions.set(state.id, login);
		const openedUrls = new Set<string>();
		login.completion = this.catalog
			.login(providerId, authType, {
				signal: controller.signal,
				prompt: (prompt) => this.prompt(login, prompt),
				notify: (event) => {
					if (controller.signal.aborted) return;
					state.events = [...state.events, structuredClone(event)].slice(-30);
					const url =
						event.type === "auth_url"
							? event.url
							: event.type === "device_code"
								? event.verificationUri
								: undefined;
					if (
						!url ||
						openedUrls.has(url) ||
						!URL.canParse(url) ||
						!["http:", "https:"].includes(new URL(url).protocol)
					)
						return;
					openedUrls.add(url);
					void this.openUrl(url).catch(() => {
						if (!controller.signal.aborted)
							state.events = [
								...state.events,
								{ type: "progress" as const, message: "浏览器未能自动打开，请点击上方授权链接。" },
							].slice(-30);
					});
				},
			})
			.then(
				() => {
					state.status = controller.signal.aborted ? "cancelled" : "succeeded";
				},
				() => {
					state.status = controller.signal.aborted ? "cancelled" : "failed";
					// Provider errors can contain submitted keys, callback codes or tokens.
					if (!controller.signal.aborted) state.error = "Pi 登录失败，请重试或选择其他登录方式。";
				},
			)
			.finally(() => {
				clearTimeout(login.timer);
				delete state.prompt;
				login.answer = undefined;
			});
		return this.get(state.id);
	}

	get(id: string): ModelLoginState {
		return structuredClone(this.require(id).state);
	}

	answer(id: string, promptId: string, value: string): ModelLoginState {
		const login = this.require(id);
		const prompt = login.state.prompt;
		if (login.state.status !== "waiting" || prompt?.id !== promptId || !login.answer)
			throw new WorkbenchError("conflict", "登录步骤已变化，请刷新后继续");
		if (!value.trim() || value.length > 16_384) throw new WorkbenchError("invalid_input", "请输入登录信息");
		if (prompt.type === "select" && !prompt.options.some((option) => option.id === value))
			throw new WorkbenchError("invalid_input", "登录选项无效");
		login.answer(value);
		return this.get(id);
	}

	cancel(id: string): ModelLoginState {
		const login = this.require(id);
		if (["running", "waiting"].includes(login.state.status)) {
			login.state.status = "cancelled";
			login.controller.abort();
		}
		return this.get(id);
	}

	async dispose(): Promise<void> {
		this.closed = true;
		for (const login of this.sessions.values()) this.cancel(login.state.id);
		await Promise.all([...this.sessions.values()].map((login) => login.completion));
		this.sessions.clear();
	}

	private prompt(login: LoginSession, input: RuntimeAuthPrompt & { signal?: AbortSignal }): Promise<string> {
		const signal = input.signal ? AbortSignal.any([login.controller.signal, input.signal]) : login.controller.signal;
		if (signal.aborted) return Promise.reject(signal.reason);
		if (login.answer) return Promise.reject(new Error("Concurrent login prompts are unsupported"));
		const { signal: _signal, ...prompt } = input;
		login.state.prompt = { ...structuredClone(prompt), id: randomUUID() };
		login.state.status = "waiting";
		return new Promise<string>((resolve, reject) => {
			const finish = () => {
				signal.removeEventListener("abort", abort);
				delete login.state.prompt;
				login.answer = undefined;
				if (!login.controller.signal.aborted) login.state.status = "running";
			};
			const abort = () => {
				finish();
				reject(signal.reason);
			};
			login.answer = (value) => {
				finish();
				resolve(value);
			};
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	private require(id: string): LoginSession {
		const login = this.sessions.get(id);
		if (!login) throw new WorkbenchError("not_found", "模型登录不存在或已过期，请重新登录");
		return login;
	}
}
