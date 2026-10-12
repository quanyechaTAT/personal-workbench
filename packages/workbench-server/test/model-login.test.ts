import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ModelLoginState } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test.each(["browser", "device"] as const)(
	"Pi OAuth %s challenges are handled by the native provider and its saved credential is reused",
	async (method) => {
		const opened: string[] = [];
		const fixture = await createAssistantFixture(undefined, {
			openLoginUrl: async (url) => {
				opened.push(url);
			},
		});
		try {
			const original = fixture.modelRuntime.getProvider("openai-codex")!;
			const credential = {
				type: "oauth" as const,
				access: "fixture-private-access",
				refresh: "fixture-private-refresh",
				expires: Date.now() + 3_600_000,
			};
			fixture.modelRuntime.registerNativeProvider({
				...original,
				id: "pi-login-fixture",
				name: "Pi OAuth fixture",
				refreshModels: undefined,
				getModels: () => original.getModels().map((model) => ({ ...model, provider: "pi-login-fixture" })),
				auth: {
					oauth: {
						name: "Fixture OAuth",
						login: async (interaction: ProviderAuthInteraction) => {
							const selected = await interaction.prompt({
								type: "select",
								message: "登录方式",
								options: [
									{ id: "browser", label: "浏览器" },
									{ id: "device", label: "设备验证码" },
								],
							});
							if (selected === "browser")
								interaction.notify({
									type: "auth_url",
									url: "https://example.com/authorize",
									instructions: "打开链接后授权",
								});
							else
								interaction.notify({
									type: "device_code",
									userCode: "ABCD-EFGH",
									verificationUri: "https://example.com/device",
								});
							const code = await interaction.prompt({
								type: "manual_code",
								message: "粘贴回调地址",
								placeholder: "http://localhost/callback",
							});
							expect(code).toBe("fixture-code");
							return credential;
						},
						refresh: async () => credential,
						toAuth: async (saved) => ({ apiKey: saved.access }),
					},
				},
			});
			const started = await fixture.request("/models/logins", {
				method: "POST",
				body: JSON.stringify({ providerId: "pi-login-fixture", authType: "oauth" }),
			});
			expect(started.status).toBe(202);
			let login = (await started.json()) as ModelLoginState;
			await expect
				.poll(async () => {
					login = (await (await fixture.request(`/models/logins/${login.id}`)).json()) as ModelLoginState;
					return login.prompt?.type;
				})
				.toBe("select");
			const firstId = login.prompt!.id;
			expect(
				(
					await fixture.request(`/models/logins/${login.id}/answer`, {
						method: "POST",
						body: JSON.stringify({ promptId: firstId, value: method }),
					})
				).status,
			).toBe(200);
			await expect
				.poll(async () => {
					login = (await (await fixture.request(`/models/logins/${login.id}`)).json()) as ModelLoginState;
					return login.prompt?.type;
				})
				.toBe("manual_code");
			expect(login.events).toContainEqual(
				method === "browser"
					? expect.objectContaining({ type: "auth_url" })
					: expect.objectContaining({ type: "device_code", userCode: "ABCD-EFGH" }),
			);
			expect(opened).toEqual([
				method === "browser" ? "https://example.com/authorize" : "https://example.com/device",
			]);
			expect(
				(
					await fixture.request(`/models/logins/${login.id}/answer`, {
						method: "POST",
						body: JSON.stringify({ promptId: firstId, value: "stale-answer" }),
					})
				).status,
			).toBe(409);
			expect(
				(
					await fixture.request(`/models/logins/${login.id}/answer`, {
						method: "POST",
						body: JSON.stringify({ promptId: login.prompt!.id, value: "fixture-code" }),
					})
				).status,
			).toBe(200);
			await expect
				.poll(async () => {
					login = (await (await fixture.request(`/models/logins/${login.id}`)).json()) as ModelLoginState;
					return login.status;
				})
				.toBe("succeeded");
			expect(login.prompt).toBeUndefined();
			expect(JSON.stringify(login)).not.toMatch(/fixture-private|fixture-code/);
			expect((await fixture.modelRuntime.getAuth("pi-login-fixture"))?.auth.apiKey).toBe(credential.access);
		} finally {
			await fixture.close();
		}
	},
);

test("an OAuth callback cancels only its manual prompt and still completes native login", async () => {
	const fixture = await createAssistantFixture();
	let finishCallback: (() => void) | undefined;
	try {
		const original = fixture.modelRuntime.getProvider("openai-codex")!;
		const credential = {
			type: "oauth" as const,
			access: "fixture-callback-access",
			refresh: "fixture-callback-refresh",
			expires: Date.now() + 3_600_000,
		};
		fixture.modelRuntime.registerNativeProvider({
			...original,
			id: "pi-callback-fixture",
			refreshModels: undefined,
			auth: {
				oauth: {
					name: "Callback OAuth",
					refresh: async () => credential,
					toAuth: async (saved) => ({ apiKey: saved.access }),
					login: async (interaction) => {
						const manual = new AbortController();
						const pending = interaction
							.prompt({ type: "manual_code", message: "可选回调地址", signal: manual.signal })
							.catch(() => undefined);
						await new Promise<void>((resolve) => {
							finishCallback = resolve;
							interaction.signal.addEventListener(
								"abort",
								() => {
									manual.abort();
									resolve();
								},
								{ once: true },
							);
						});
						manual.abort();
						await pending;
						interaction.signal.throwIfAborted();
						return credential;
					},
				},
			},
		});
		const start = await fixture.request("/models/logins", {
			method: "POST",
			body: JSON.stringify({ providerId: "pi-callback-fixture", authType: "oauth" }),
		});
		expect(start.status).toBe(202);
		let login = (await start.json()) as ModelLoginState;
		await expect.poll(() => Boolean(finishCallback)).toBe(true);
		finishCallback!();
		await expect
			.poll(async () => {
				login = (await (await fixture.request(`/models/logins/${login.id}`)).json()) as ModelLoginState;
				return login.status;
			})
			.toBe("succeeded");
		expect(login.prompt).toBeUndefined();
	} finally {
		finishCallback?.();
		await fixture.close();
	}
});

test("native Pi API key login works inside model settings and keeps credentials out of responses", async () => {
	const fixture = await createAssistantFixture();
	try {
		const response = await fixture.request("/models/logins", {
			method: "POST",
			body: JSON.stringify({ providerId: "deepseek", authType: "api_key" }),
		});
		expect(response.status).toBe(202);
		let login = (await response.json()) as ModelLoginState;
		await expect
			.poll(async () => {
				login = (await (await fixture.request(`/models/logins/${login.id}`)).json()) as ModelLoginState;
				return login.prompt?.type;
			})
			.toBe("secret");
		const answer = await fixture.request(`/models/logins/${login.id}/answer`, {
			method: "POST",
			body: JSON.stringify({ promptId: login.prompt!.id, value: "fixture-native-key" }),
		});
		expect(answer.status).toBe(200);
		await expect
			.poll(async () => {
				login = (await (await fixture.request(`/models/logins/${login.id}`)).json()) as ModelLoginState;
				return login.status;
			})
			.toBe("succeeded");
		expect(JSON.stringify(login)).not.toContain("fixture-native-key");
		expect((await fixture.modelRuntime.getAuth("deepseek"))?.auth.apiKey).toBe("fixture-native-key");
		const catalog = await fixture.application.services.modelSettings.get();
		const imported = await fixture.request("/models/import", {
			method: "POST",
			body: JSON.stringify({ providerId: "deepseek", expectedVersion: catalog.version }),
		});
		expect(imported.status).toBe(201);
		expect(JSON.stringify(await imported.json())).not.toContain("fixture-native-key");
	} finally {
		await fixture.close();
	}
});

test("cancelling a native login removes its prompt and never stores an API key", async () => {
	const fixture = await createAssistantFixture();
	try {
		const start = await fixture.request("/models/logins", {
			method: "POST",
			body: JSON.stringify({ providerId: "deepseek", authType: "api_key" }),
		});
		expect(start.status).toBe(202);
		const login = (await start.json()) as ModelLoginState;
		const duplicate = await fixture.request("/models/logins", {
			method: "POST",
			body: JSON.stringify({ providerId: "deepseek", authType: "api_key" }),
		});
		expect(duplicate.status).toBe(409);
		expect((await fixture.request(`/models/logins/${login.id}`, { method: "DELETE" })).status).toBe(200);
		await expect
			.poll(
				async () =>
					((await (await fixture.request(`/models/logins/${login.id}`)).json()) as ModelLoginState).status,
			)
			.toBe("cancelled");
		expect((await fixture.request(`/models/logins/${login.id}`)).status).toBe(200);
		expect(await fixture.modelRuntime.getAuth("deepseek")).toBeUndefined();
	} finally {
		await fixture.close();
	}
});
