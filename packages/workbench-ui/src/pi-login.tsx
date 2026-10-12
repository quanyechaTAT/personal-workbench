import type {
	RuntimeAuthEvent,
	RuntimeAuthPrompt,
	RuntimeAuthType,
	RuntimeProviderCatalog,
} from "@earendil-works/workbench-runtime";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api.ts";
import { ErrorNotice } from "./ui.tsx";

function AuthLink({ url, children }: { url: string; children: string }) {
	return URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol) ? (
		<a href={url} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	) : (
		<span>{children}</span>
	);
}

function AuthNotice({ event }: { event: RuntimeAuthEvent }) {
	if (event.type === "auth_url")
		return (
			<p>
				<AuthLink url={event.url}>打开授权页面</AuthLink>
				<small>{event.instructions}</small>
			</p>
		);
	if (event.type === "device_code")
		return (
			<p>
				<AuthLink url={event.verificationUri}>打开设备登录页面</AuthLink>
				<small>
					输入验证码：<strong>{event.userCode}</strong>
				</small>
			</p>
		);
	return (
		<p>
			{event.message}
			{event.type === "info" &&
				event.links?.map((link) => (
					<small key={link.url}>
						<AuthLink url={link.url}>{link.label ?? link.url}</AuthLink>
					</small>
				))}
		</p>
	);
}

function LoginPrompt({
	prompt,
	pending,
	onSubmit,
}: {
	prompt: RuntimeAuthPrompt & { id: string };
	pending: boolean;
	onSubmit(promptId: string, value: string): void;
}) {
	const [value, setValue] = useState("");
	const fieldId = useId();
	const field = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		field.current?.focus();
	}, []);
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (value.trim() && !pending) onSubmit(prompt.id, value);
			}}
		>
			<label htmlFor={fieldId}>{prompt.message}</label>
			{prompt.type === "select" ? (
				<select
					id={fieldId}
					aria-label="Pi 登录步骤"
					value={value}
					disabled={pending}
					onChange={(event) => setValue(event.target.value)}
				>
					<option value="">请选择</option>
					{prompt.options.map((option) => (
						<option key={option.id} value={option.id}>
							{option.label}
							{option.description ? ` · ${option.description}` : ""}
						</option>
					))}
				</select>
			) : (
				<input
					id={fieldId}
					ref={field}
					aria-label="Pi 登录信息"
					type={prompt.type === "secret" ? "password" : "text"}
					autoComplete="off"
					placeholder={prompt.placeholder}
					value={value}
					disabled={pending}
					maxLength={16384}
					onChange={(event) => setValue(event.target.value)}
				/>
			)}
			<button type="submit" className="button primary" disabled={!value.trim() || pending}>
				继续登录
			</button>
		</form>
	);
}

export function PiLogin({
	candidates,
	fixedProviderId,
	pending,
	onAuthenticated,
}: {
	candidates: RuntimeProviderCatalog[];
	fixedProviderId?: string;
	pending: boolean;
	onAuthenticated(providerId: string): Promise<void>;
}) {
	const client = useQueryClient();
	const [providerId, setProviderId] = useState(fixedProviderId ?? "");
	const [method, setMethod] = useState<RuntimeAuthType>("oauth");
	const [loginId, setLoginId] = useState<string>();
	const activeId = useRef<string | undefined>(undefined);
	const mounted = useRef(true);
	const importedId = useRef<string | undefined>(undefined);
	const provider = candidates.find((entry) => entry.id === providerId);
	const authType =
		provider?.authMethods?.find((entry) => entry.type === method)?.type ?? provider?.authMethods?.[0]?.type;
	const login = useQuery({
		queryKey: ["model-login", loginId],
		queryFn: () => api.modelLogin(loginId!),
		enabled: Boolean(loginId),
		retry: false,
		refetchInterval: (query) =>
			query.state.data && ["succeeded", "failed", "cancelled"].includes(query.state.data.status) ? false : 500,
	});
	const start = useMutation({
		mutationFn: () => api.startModelLogin(providerId, authType!),
		onSuccess: (state) => {
			if (!mounted.current) {
				void api.cancelModelLogin(state.id).catch(() => undefined);
				return;
			}
			activeId.current = state.id;
			client.setQueryData(["model-login", state.id], state);
			setLoginId(state.id);
		},
	});
	const answer = useMutation({
		gcTime: 0,
		mutationFn: (input: { promptId: string; value: string }) =>
			api.answerModelLogin(loginId!, input.promptId, input.value),
		onSuccess: (state) => {
			client.setQueryData(["model-login", state.id], state);
			answer.reset();
		},
	});
	const cancel = useMutation({
		mutationFn: () => api.cancelModelLogin(loginId!),
		onSuccess: (state) => {
			client.setQueryData(["model-login", state.id], state);
		},
	});
	const add = useMutation({ mutationFn: onAuthenticated });
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (activeId.current) void api.cancelModelLogin(activeId.current).catch(() => undefined);
		};
	}, []);
	useEffect(() => {
		if (login.data?.status === "succeeded" && importedId.current !== login.data.id) {
			importedId.current = login.data.id;
			add.mutate(login.data.providerId);
		}
	}, [login.data, add.mutate]);
	const running = start.isPending || Boolean(login.data && ["running", "waiting"].includes(login.data.status));
	const prompt = login.data?.prompt;
	const busy = pending || running || add.isPending;
	return (
		<section className="pi-native-login" aria-label="Pi 自带模型登录">
			<h3>Pi 自带模型登录</h3>
			<p className="quiet-copy">直接登录 Pi 支持的模型账户，或配置供应商 API Key。登录后选择要添加的模型。</p>
			<label>
				Pi 供应商
				<select
					aria-label="Pi 登录供应商"
					value={providerId}
					disabled={busy || Boolean(fixedProviderId)}
					onChange={(event) => {
						setProviderId(event.target.value);
						setLoginId(undefined);
						start.reset();
					}}
				>
					<option value="">选择 Pi 供应商</option>
					{candidates
						.filter((entry) => entry.configured || entry.authMethods?.length)
						.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.name}
								{entry.configured ? " · 已登录" : ""}
							</option>
						))}
				</select>
			</label>
			{authType && (
				<label>
					登录方式
					<select
						aria-label="Pi 登录方式"
						value={authType ?? ""}
						disabled={busy || !providerId}
						onChange={(event) => setMethod(event.target.value as RuntimeAuthType)}
					>
						{!authType && <option value="">先选择供应商</option>}
						{provider?.authMethods?.map((entry) => (
							<option key={entry.type} value={entry.type}>
								{entry.type === "oauth" ? "账户登录" : "API Key"} · {entry.label}
							</option>
						))}
					</select>
				</label>
			)}
			{(start.error || answer.error || cancel.error || login.error || add.error) && (
				<ErrorNotice error={start.error ?? answer.error ?? cancel.error ?? login.error ?? add.error} />
			)}
			{login.data && (
				<div className="pi-login-progress" aria-live="polite">
					{login.data.events.map((event, index) => (
						<AuthNotice key={`${login.data!.id}:${index}`} event={event} />
					))}
					{login.data.error && <ErrorNotice error={login.data.error} />}
					{login.data.status === "cancelled" && <p>登录已取消</p>}
					{login.data.status === "succeeded" && <p>Pi 登录成功{add.isPending ? "，正在添加供应商…" : ""}</p>}
					{login.data.status === "running" && <p>等待 Pi 完成登录…</p>}
					{prompt && (
						<LoginPrompt
							key={prompt.id}
							prompt={prompt}
							pending={answer.isPending}
							onSubmit={(promptId, value) => answer.mutate({ promptId, value })}
						/>
					)}
					{add.error && (
						<button type="button" className="button secondary" onClick={() => add.mutate(login.data!.providerId)}>
							重试添加供应商
						</button>
					)}
				</div>
			)}
			<div className="model-actions">
				{provider?.configured && !running && (
					<button
						type="button"
						className="button secondary"
						disabled={busy}
						onClick={() => add.mutate(provider.id)}
					>
						使用已登录账户
					</button>
				)}
				{running && loginId ? (
					<button
						type="button"
						className="button secondary"
						disabled={cancel.isPending}
						onClick={() => cancel.mutate()}
					>
						取消登录
					</button>
				) : (
					<button
						type="button"
						className="button primary"
						disabled={!authType || busy}
						onClick={() => {
							answer.reset();
							cancel.reset();
							add.reset();
							start.mutate();
						}}
					>
						登录 Pi
					</button>
				)}
			</div>
		</section>
	);
}
