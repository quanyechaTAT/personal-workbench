import { randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getErrorMessage, type JsonValue, WorkbenchError } from "@earendil-works/workbench-core";
import {
	ChatSelectionSchema,
	CommitSkillImportSchema,
	CreateAssistantDraftSchema,
	CreateSkillImportSchema,
	CreateSkillSchema,
	DiscoverModelsSchema,
	MAX_CHAT_ATTACHMENT_BYTES,
	MAX_CHAT_ATTACHMENTS,
	SaveAgentProfileSchema,
	SaveMcpConnectionSchema,
	SaveModelProviderSchema,
	SaveSearchSettingsSchema,
	SaveSkillContentSchema,
	SemanticChangeSchema,
	SetPermissionModeSchema,
	ThinkingLevelSchema,
	UpdateAgentProfileSchema,
	UpdateAssistantDraftSchema,
	UpdateMcpConnectionSchema,
	WebSearchSchema,
} from "@earendil-works/workbench-core/contracts";
import { McpWorkbenchError } from "@earendil-works/workbench-mcp";
import { RuntimeError } from "@earendil-works/workbench-runtime";
import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";
import type { WorkbenchApplication } from "./application.ts";
import { ChatAttachmentService } from "./chat-attachment-service.ts";
import { handleKnowledgeRequest } from "./knowledge-routes.ts";
import { sanitizeDiagnostic } from "./logger.ts";
import { handleMemoryLayerRequest } from "./memory-routes.ts";
import { ModelLoginService } from "./model-login.ts";
import { pickNativeDirectory, pickNativeSkillFile } from "./native-directory-picker.ts";

const MAXIMUM_BODY_BYTES = 1024 * 1024;

const ProjectCreate = Type.Object(
	{
		sourcePath: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
const TaskCreate = Type.Object(
	{
		projectId: Type.Optional(Type.String()),
		parentId: Type.Optional(Type.String()),
		title: Type.String({ minLength: 1 }),
		description: Type.Optional(Type.String()),
		type: Type.Optional(Type.Union([Type.Literal("human"), Type.Literal("agent")])),
		status: Type.Optional(taskStatusSchema()),
		priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
		assignedTo: Type.Optional(Type.String()),
		dueAt: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const TaskUpdate = Type.Object(
	{
		expectedVersion: Type.Integer({ minimum: 1 }),
		title: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		status: Type.Optional(taskStatusSchema()),
		priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
		assignedTo: Type.Optional(Type.String()),
		dueAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	},
	{ additionalProperties: false },
);
const AgentTaskStart = Type.Object(
	{
		profileId: Type.Optional(Type.String({ minLength: 1 })),
		profileSlug: Type.Optional(Type.String({ minLength: 1 })),
		expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
const TaskCleanupPreview = Type.Object(
	{ projectId: Type.Optional(Type.String()), completedBefore: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const TaskCleanup = Type.Object(
	{
		tasks: Type.Array(
			Type.Object(
				{ id: Type.String({ minLength: 1 }), expectedVersion: Type.Integer({ minimum: 1 }) },
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 500 },
		),
		deleteHistory: Type.Boolean(),
	},
	{ additionalProperties: false },
);
const SessionCreate = Type.Object(
	{
		model: Type.Optional(
			Type.Object({ provider: Type.String(), modelId: Type.String() }, { additionalProperties: false }),
		),
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
		projectId: Type.Optional(Type.String()),
		profileId: Type.Optional(Type.String()),
		profileSlug: Type.Optional(Type.String()),
		title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	},
	{ additionalProperties: false },
);
const MessageCreate = Type.Object(
	{
		text: Type.String({ maxLength: 64000 }),
		attachmentIds: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
				maxItems: MAX_CHAT_ATTACHMENTS,
				uniqueItems: true,
			}),
		),
		inputMessageId: Type.Optional(Type.String()),
		taskRunId: Type.Optional(Type.String()),
		selection: Type.Optional(ChatSelectionSchema),
	},
	{ additionalProperties: false },
);
const MessageSteer = Type.Object(
	{ text: Type.String({ minLength: 1 }), runId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const MessageQueueUpdate = Type.Object(
	{
		runId: Type.String({ minLength: 1 }),
		action: Type.Union([
			Type.Object(
				{ kind: Type.Literal("edit"), text: Type.String({ minLength: 1, maxLength: 64000 }) },
				{ additionalProperties: false },
			),
			Type.Object({ kind: Type.Literal("remove") }, { additionalProperties: false }),
			Type.Object({ kind: Type.Literal("steer") }, { additionalProperties: false }),
		]),
	},
	{ additionalProperties: false },
);
const SessionTitle = Type.Object(
	{ title: Type.String({ minLength: 1, maxLength: 200 }), expectedTitle: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const SessionAssistant = Type.Object(
	{ profileId: Type.String({ minLength: 1 }), expectedProfileId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const ModelSelect = Type.Object(
	{ provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const SessionCommand = Type.Union([
	Type.Object({ name: Type.Literal("session") }, { additionalProperties: false }),
	Type.Object(
		{ name: Type.Literal("compact"), instructions: Type.Optional(Type.String({ maxLength: 4000 })) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ name: Type.Literal("export"), format: Type.Union([Type.Literal("html"), Type.Literal("jsonl")]) },
		{ additionalProperties: false },
	),
]);
const MemoryCandidateCreate = Type.Object(
	{
		kind: memoryKindSchema(),
		projectId: Type.Optional(Type.String()),
		proposedText: Type.String({ minLength: 1 }),
		reason: Type.String({ minLength: 1 }),
		heading: Type.Optional(Type.String()),
		date: Type.Optional(Type.String()),
		sessionId: Type.Optional(Type.String()),
		semanticChange: Type.Optional(SemanticChangeSchema),
	},
	{ additionalProperties: false },
);
const MemoryEdit = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		content: Type.String(),
		expectedHash: Type.String({ minLength: 1 }),
		kind: memoryKindSchema(),
		projectId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const MemoryReindex = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		kind: memoryKindSchema(),
		projectId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const SettingSet = Type.Object(
	{ value: Type.Unknown(), expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })) },
	{ additionalProperties: false },
);
const SkillToggle = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
const ApprovalResolve = Type.Object(
	{ decision: Type.Union([Type.Literal("approved"), Type.Literal("denied"), Type.Literal("cancelled")]) },
	{ additionalProperties: false },
);
const FileWrite = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		content: Type.String(),
		expectedHash: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const ExpectedVersion = Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const ProfileClone = Type.Object(
	{ name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })) },
	{ additionalProperties: false },
);
const ConnectionEnabled = Type.Object(
	{ enabled: Type.Boolean(), expectedVersion: Type.Integer({ minimum: 1 }) },
	{ additionalProperties: false },
);

function taskStatusSchema() {
	return Type.Union([
		Type.Literal("backlog"),
		Type.Literal("todo"),
		Type.Literal("running"),
		Type.Literal("blocked"),
		Type.Literal("review"),
		Type.Literal("done"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
	]);
}

function memoryKindSchema() {
	return Type.Union([Type.Literal("user"), Type.Literal("global"), Type.Literal("daily"), Type.Literal("project")]);
}

function memoryCandidateStatusSchema() {
	return Type.Union([
		Type.Literal("pending"),
		Type.Literal("accepted"),
		Type.Literal("rejected"),
		Type.Literal("conflicted"),
		Type.Literal("failed"),
	]);
}

function queryLimit(value: string | null, fallback = 100): number {
	if (value === null) return fallback;
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new WorkbenchError("invalid_input", "limit must be an integer from 1 to 500");
	}
	return limit;
}

function managedMemoryTarget(
	path: string,
):
	| { kind: "user" | "global" | "daily"; projectSlug?: undefined }
	| { kind: "project"; projectSlug: string }
	| undefined {
	const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
	if (normalized === "USER.md") return { kind: "user" };
	if (normalized === "MEMORY.md") return { kind: "global" };
	if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(normalized)) return { kind: "daily" };
	const project = /^projects\/([^/]+)\/AGENTS\.md$/u.exec(normalized);
	return project?.[1] ? { kind: "project", projectSlug: project[1] } : undefined;
}

function parseValue<T extends TSchema>(schema: T, value: unknown): Static<T> {
	try {
		return Parse(schema, value);
	} catch {
		throw new WorkbenchError("invalid_input", "请求参数无效，请检查字段类型和范围");
	}
}

async function readJson<T extends TSchema>(request: IncomingMessage, schema: T): Promise<Static<T>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAXIMUM_BODY_BYTES) throw new WorkbenchError("invalid_input", "Request body exceeds 1 MiB");
		chunks.push(buffer);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new WorkbenchError("invalid_input", "请求正文不是有效 JSON");
	}
	return parseValue(schema, value);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"content-security-policy": "default-src 'none'; frame-ancestors 'none'",
	});
	response.end(body);
}

function statusForError(error: unknown): number {
	if (error instanceof RuntimeError) {
		if (error.code === "session_busy" || error.code === "runtime_disposed") return 409;
		if (error.code === "session_not_found" || error.code === "model_not_found") return 404;
		if (error.code === "invalid_reference") return 400;
		return 502;
	}
	if (error instanceof McpWorkbenchError) {
		return error.code === "authentication_required" ||
			error.code === "connection_disabled" ||
			error.code === "tool_missing"
			? 409
			: error.code === "invalid_arguments" || error.code === "invalid_schema"
				? 400
				: 502;
	}
	if (!(error instanceof WorkbenchError)) return 500;
	switch (error.code) {
		case "invalid_input":
			return 400;
		case "not_found":
			return 404;
		case "conflict":
		case "permission_resolved":
			return 409;
		case "path_denied":
		case "path_external":
			return 403;
		case "permission_expired":
			return 410;
		case "storage_failure":
			return 500;
		case "external_failure":
			return 502;
	}
}

function safeError(error: unknown): { error: { code: string; message: string } } {
	return {
		error: {
			code:
				error instanceof WorkbenchError || error instanceof McpWorkbenchError || error instanceof RuntimeError
					? error.code
					: "internal_error",
			message:
				error instanceof WorkbenchError || error instanceof McpWorkbenchError || error instanceof RuntimeError
					? String(sanitizeDiagnostic(error.message))
					: "Internal server error",
		},
	};
}

export interface WorkbenchServerOptions {
	host?: "127.0.0.1" | "::1";
	port?: number;
	token?: string;
	staticRoot?: string;
	pickDirectory?: (signal: AbortSignal) => Promise<string | undefined>;
	pickSkillFile?: (signal: AbortSignal) => Promise<string | undefined>;
	openLoginUrl?: (url: string) => Promise<void>;
}

export class WorkbenchHttpServer {
	readonly token: string;
	private readonly application: WorkbenchApplication;
	private readonly host: "127.0.0.1" | "::1";
	private readonly port: number;
	private readonly staticRoot: string;
	private readonly server: Server;
	private readonly modelLogins: ModelLoginService;
	private readonly chatAttachments: ChatAttachmentService;
	private readonly pickDirectory: (signal: AbortSignal) => Promise<string | undefined>;
	private readonly pickSkillFile: (signal: AbortSignal) => Promise<string | undefined>;
	private readonly pickerAbort = new AbortController();
	private pickerOpen = false;
	private listeningPort: number | undefined;
	private closing = false;
	private readonly pendingRequests = new Set<Promise<void>>();
	private readonly activeApiRequests = new Set<IncomingMessage>();
	private deletingProject = false;

	constructor(application: WorkbenchApplication, options: WorkbenchServerOptions = {}) {
		this.application = application;
		this.chatAttachments = new ChatAttachmentService(application.paths, application.services.sessions);
		this.modelLogins = new ModelLoginService(application.runtime.modelCatalog, options.openLoginUrl);
		this.host = options.host ?? "127.0.0.1";
		this.port = options.port ?? 0;
		this.token = options.token ?? randomBytes(32).toString("base64url");
		this.staticRoot = resolve(
			options.staticRoot ?? fileURLToPath(new URL("../../workbench-ui/dist", import.meta.url)),
		);
		this.pickDirectory = options.pickDirectory ?? pickNativeDirectory;
		this.pickSkillFile = options.pickSkillFile ?? pickNativeSkillFile;
		this.server = createServer((request, response) => {
			const completion = this.handle(request, response).catch((error: unknown) => {
				if (response.destroyed) return;
				if (!response.headersSent) sendJson(response, statusForError(error), safeError(error));
				else response.end();
			});
			const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
			// Event streams settle when application shutdown aborts the runtime. JSON requests must
			// finish before SQLite/logs close, even after their client connection has been destroyed.
			const streaming =
				request.method === "GET" && /^\/api\/v1\/(?:runs|assistant-drafts)\/[^/]+\/events$/u.test(pathname);
			if (!streaming) this.pendingRequests.add(completion);
			void completion.finally(() => this.pendingRequests.delete(completion));
		});
	}

	async start(): Promise<{ origin: string; launchUrl: string; token: string }> {
		const retainedIssues = await this.chatAttachments.initialize();
		if (retainedIssues) await this.application.logger.log("chat.attachments.recovery", { retainedIssues });
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.port, this.host, () => {
				this.server.off("error", reject);
				resolve();
			});
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("HTTP server did not expose a TCP address");
		this.listeningPort = address.port;
		const displayHost = this.host === "::1" ? "[::1]" : this.host;
		const origin = `http://${displayHost}:${address.port}`;
		this.application.oauth.setCallbackOrigin(origin);
		return { origin, launchUrl: `${origin}/?token=${encodeURIComponent(this.token)}`, token: this.token };
	}

	async close(): Promise<void> {
		this.closing = true;
		this.pickerAbort.abort();
		await this.modelLogins.dispose();
		if (!this.server.listening) return;
		const closed = new Promise<void>((resolve, reject) => {
			this.server.close((error) => (error ? reject(error) : resolve()));
		});
		this.server.closeAllConnections();
		await closed;
		await Promise.all(this.pendingRequests);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const requestUrl = new URL(request.url ?? "/", "http://localhost");
		try {
			const url = requestUrl;
			const oauthCallback = request.method === "GET" && url.pathname === "/api/v1/mcp/oauth/callback";
			this.validateConnection(request, oauthCallback);
			if (oauthCallback) {
				await this.oauthCallback(response, url);
				return;
			}
			if (request.method === "GET" && url.pathname === "/" && url.searchParams.get("token") === this.token) {
				response.writeHead(303, {
					location: "/",
					"set-cookie": `personal_workbench_session=${this.token}; HttpOnly; SameSite=Strict; Path=/`,
					"cache-control": "no-store",
				});
				response.end();
				return;
			}
			this.authorize(request, url);
			if (url.pathname.startsWith("/api/")) {
				if (this.deletingProject) throw new WorkbenchError("conflict", "正在清理项目数据，请稍后重试");
				if (!/^\/api\/v1\/(?:runs|assistant-drafts)\/[^/]+\/events$/u.test(url.pathname))
					this.activeApiRequests.add(request);
				await this.route(request, response, url);
			} else await this.serveStatic(response, url.pathname);
		} catch (error) {
			if (this.closing && response.destroyed) return;
			await this.application.logger.log("error", { path: requestUrl.pathname, message: getErrorMessage(error) });
			if (!response.headersSent) sendJson(response, statusForError(error), safeError(error));
			else response.end();
		} finally {
			this.activeApiRequests.delete(request);
		}
	}

	private authorize(request: IncomingMessage, url: URL): void {
		const authorization = request.headers.authorization;
		const cookie = request.headers.cookie
			?.split(";")
			.map((part) => part.trim().split("=", 2))
			.find(([name]) => name === "personal_workbench_session")?.[1];
		const supplied = authorization?.startsWith("Bearer ")
			? authorization.slice(7)
			: (url.searchParams.get("token") ?? cookie);
		if (supplied !== this.token) throw new WorkbenchError("path_denied", "Invalid Workbench launch token");
	}

	private validateConnection(request: IncomingMessage, allowExternalOrigin = false): void {
		const expectedHost = this.host === "::1" ? `[::1]:${this.listeningPort}` : `${this.host}:${this.listeningPort}`;
		if (request.headers.host !== expectedHost && request.headers.host !== `localhost:${this.listeningPort}`) {
			throw new WorkbenchError("path_denied", "Invalid Host header");
		}
		const origin = request.headers.origin;
		if (!allowExternalOrigin && origin && origin !== `http://${request.headers.host}`)
			throw new WorkbenchError("path_denied", "Cross-origin request denied");
	}

	private async serveStatic(response: ServerResponse, pathname: string): Promise<void> {
		const requested = decodeURIComponent(pathname);
		const relativePath = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
		let target = resolve(this.staticRoot, relativePath);
		const fromRoot = relative(this.staticRoot, target);
		if (fromRoot.startsWith("..") || isAbsolute(fromRoot))
			throw new WorkbenchError("path_denied", "Static path escapes UI root");
		let metadata = await stat(target).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		});
		if ((!metadata || !metadata.isFile()) && !extname(relativePath)) {
			target = resolve(this.staticRoot, "index.html");
			metadata = await stat(target).catch(() => undefined);
		}
		if (!metadata?.isFile()) throw new WorkbenchError("not_found", "UI asset not found");
		const body = await readFile(target);
		const mime =
			extname(target) === ".html"
				? "text/html; charset=utf-8"
				: extname(target) === ".js"
					? "text/javascript; charset=utf-8"
					: extname(target) === ".css"
						? "text/css; charset=utf-8"
						: "application/octet-stream";
		response.writeHead(200, {
			"content-type": mime,
			"content-length": body.length,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy":
				"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'",
			"referrer-policy": "no-referrer",
		});
		response.end(body);
	}

	private async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
		const method = request.method ?? "GET";
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		if (parts[0] !== "api" || parts[1] !== "v1") throw new WorkbenchError("not_found", "Route not found");
		const route = parts.slice(2);
		if (await handleMemoryLayerRequest(this.application, request, response, url, route, sendJson)) return;
		if (method === "GET" && route[0] === "health" && route.length === 1) {
			return sendJson(response, 200, { status: "ok", runtime: this.application.runtime.id });
		}
		if (method === "GET" && route[0] === "runtime" && route[1] === "models") {
			return sendJson(response, 200, {
				capabilities: this.application.runtime.getCapabilities(),
				models: await this.application.services.sessions.listModels(this.application.runtime.id),
			});
		}
		if (method === "GET" && route[0] === "runtime" && route[1] === "commands" && route.length === 2)
			return sendJson(response, 200, this.application.runtime.listCommands?.() ?? []);
		if (method === "GET" && route[0] === "runtime" && route[1] === "info") {
			return sendJson(response, 200, {
				runtime: this.application.runtime.id,
				version: "0.1.0",
				nodeVersion: process.version,
				platform: process.platform,
				architecture: process.arch,
				dataRoot: this.application.paths.root,
				workspacePath: this.application.paths.workspace,
				statePath: this.application.paths.state,
				piSessionsPath: this.application.paths.piSessions,
				capabilities: this.application.runtime.getCapabilities(),
			});
		}
		if (method === "GET" && route[0] === "developer" && route[1] === "events") {
			const stageValue = url.searchParams.get("stage");
			if (stageValue && stageValue !== "raw.pi" && stageValue !== "normalized") {
				throw new WorkbenchError("invalid_input", "Unknown diagnostic event stage");
			}
			const stage = stageValue === "raw.pi" || stageValue === "normalized" ? stageValue : undefined;
			return sendJson(
				response,
				200,
				this.application.diagnostics.list(stage, queryLimit(url.searchParams.get("limit"))),
			);
		}
		if (method === "GET" && route[0] === "developer" && route[1] === "logs") {
			return sendJson(
				response,
				200,
				await this.application.logger.readRecent(queryLimit(url.searchParams.get("limit"))),
			);
		}
		if (
			route[0] === "system" &&
			["pick-project-directory", "pick-skill-file"].includes(route[1]) &&
			route.length === 2 &&
			method === "POST"
		) {
			if (this.pickerOpen) throw new WorkbenchError("conflict", "文件选择弹窗已经打开");
			this.pickerOpen = true;
			const controller = new AbortController();
			const onClose = () => controller.abort();
			response.once("close", onClose);
			try {
				const skillPicker = route[1] === "pick-skill-file";
				const selected = await (skillPicker ? this.pickSkillFile : this.pickDirectory)(
					AbortSignal.any([this.pickerAbort.signal, controller.signal]),
				);
				if (controller.signal.aborted || response.destroyed) return;
				if (skillPicker) {
					if (!selected) return sendJson(response, 200, { path: null, directory: null });
					const path = await realpath(selected).catch(() => {
						throw new WorkbenchError("invalid_input", "所选技能文件不存在");
					});
					if (basename(path).toLowerCase() !== "skill.md" || !(await stat(path)).isFile())
						throw new WorkbenchError("invalid_input", "请选择技能目录中的 SKILL.md 文件");
					return sendJson(response, 200, { path, directory: dirname(path) });
				}
				return sendJson(response, 200, {
					path: selected ? await this.application.services.projects.validateSource(selected) : null,
				});
			} finally {
				response.off("close", onClose);
				this.pickerOpen = false;
			}
		}
		if (route[0] === "profiles") return this.profiles(request, response, url, method, route);
		if (route[0] === "models") return this.modelSettings(request, response, method, route);
		if (route[0] === "search") {
			if (route[1] === "settings" && method === "GET")
				return sendJson(response, 200, await this.application.services.webSearch.getSettings());
			if (route[1] === "settings" && method === "PUT") {
				const input = await readJson(request, SaveSearchSettingsSchema);
				return sendJson(
					response,
					200,
					await this.application.configure(() => this.application.services.webSearch.saveSettings(input)),
				);
			}
			if (route[1] === "test" && method === "POST") {
				const input = await readJson(request, WebSearchSchema);
				return sendJson(
					response,
					200,
					await this.application.configure((signal) => this.application.services.webSearch.search(input, signal)),
				);
			}
			throw new WorkbenchError("not_found", "搜索接口不存在");
		}
		if (method === "GET" && route[0] === "chat-capabilities" && route.length === 1) {
			return sendJson(
				response,
				200,
				await this.application.chatCapabilities({
					sessionId: url.searchParams.get("sessionId") ?? undefined,
					profileId: url.searchParams.get("profileId") ?? undefined,
					projectId: url.searchParams.get("projectId") ?? undefined,
				}),
			);
		}
		if (method === "GET" && route[0] === "capabilities" && route.length === 1) {
			const catalog = await this.application.services.capabilities.getCatalog(
				url.searchParams.get("projectId") ?? undefined,
			);
			return sendJson(response, 200, {
				...catalog,
				connections: catalog.connections.map(({ connection, tools }) => {
					const { secretRef: _secretRef, ...publicConnection } = connection;
					return { connection: publicConnection, tools };
				}),
			});
		}
		if (route[0] === "mcp") return this.mcp(request, response, method, route);
		if (route[0] === "assistant-drafts") return this.assistantDrafts(request, response, url, method, route);
		if (route[0] === "projects") return this.projects(request, response, url, method, route);
		if (route[0] === "tasks") return this.tasks(request, response, url, method, route);
		if (route[0] === "memory") return this.memory(request, response, url, method, route);
		if (route[0] === "artifacts" && method === "GET") {
			return sendJson(
				response,
				200,
				await this.application.services.artifacts.list(url.searchParams.get("projectId") ?? undefined),
			);
		}
		if (route[0] === "skills") return this.skills(request, response, url, method, route);
		if (route[0] === "settings") return this.settings(request, response, method, route);
		if (route[0] === "sessions") return this.sessions(request, response, url, method, route);
		if (route[0] === "runs") return this.runs(request, response, url, method, route);
		if (route[0] === "approvals") return this.approvals(request, response, method, route);
		if (route[0] === "files") return this.files(request, response, url, method, route);
		if (route[0] === "home" && method === "GET") return this.home(response);
		throw new WorkbenchError("not_found", "Route not found");
	}

	private async modelSettings(
		request: IncomingMessage,
		response: ServerResponse,
		method: string,
		route: string[],
	): Promise<void> {
		const service = this.application.services.modelSettings;
		if (route[1] === "logins") {
			if (method === "POST" && route.length === 2) {
				const input = await readJson(
					request,
					Type.Object(
						{
							providerId: Type.String({ minLength: 1, maxLength: 200 }),
							authType: Type.Union([Type.Literal("oauth"), Type.Literal("api_key")]),
						},
						{ additionalProperties: false },
					),
				);
				return sendJson(response, 202, await this.modelLogins.start(input.providerId, input.authType));
			}
			if (method === "GET" && route.length === 3) return sendJson(response, 200, this.modelLogins.get(route[2]));
			if (method === "DELETE" && route.length === 3)
				return sendJson(response, 200, this.modelLogins.cancel(route[2]));
			if (method === "POST" && route.length === 4 && route[3] === "answer") {
				const input = await readJson(
					request,
					Type.Object(
						{
							promptId: Type.String({ minLength: 1, maxLength: 100 }),
							value: Type.String({ minLength: 1, maxLength: 16_384 }),
						},
						{ additionalProperties: false },
					),
				);
				return sendJson(response, 200, this.modelLogins.answer(route[2], input.promptId, input.value));
			}
			throw new WorkbenchError("not_found", "模型登录接口不存在");
		}
		if (method === "POST" && route[1] === "discover" && route.length === 2) {
			const input = await readJson(request, DiscoverModelsSchema);
			const controller = new AbortController();
			const onClose = () => controller.abort();
			response.once("close", onClose);
			try {
				return sendJson(response, 200, await service.discover(input, controller.signal));
			} finally {
				response.off("close", onClose);
			}
		}
		if (method === "GET" && route[1] === "providers" && route.length === 2)
			return sendJson(response, 200, await service.get());
		if (method === "GET" && route[1] === "candidates" && route.length === 2)
			return sendJson(response, 200, await service.candidates());
		if (method === "POST" && route[1] === "import" && route.length === 2) {
			const input = await readJson(
				request,
				Type.Object(
					{ providerId: Type.String(), expectedVersion: Type.Integer({ minimum: 0 }) },
					{ additionalProperties: false },
				),
			);
			return sendJson(
				response,
				201,
				await this.application.configure(() => service.importProvider(input.providerId, input.expectedVersion)),
			);
		}
		if (
			((method === "POST" && route.length === 2) || (method === "PUT" && route.length === 3)) &&
			route[1] === "providers"
		) {
			const input = await readJson(request, SaveModelProviderSchema);
			return sendJson(
				response,
				method === "POST" ? 201 : 200,
				await this.application.configure(() => service.save(route[2], input)),
			);
		}
		if (method === "DELETE" && route[1] === "providers" && route.length === 3) {
			const input = await readJson(
				request,
				Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
			);
			return sendJson(
				response,
				200,
				await this.application.configure(() => service.remove(route[2], input.expectedVersion)),
			);
		}
		throw new WorkbenchError("not_found", "模型设置接口不存在");
	}

	private async profiles(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "GET" && route.length === 1) {
			return sendJson(
				response,
				200,
				await this.application.services.profiles.list(url.searchParams.get("includeArchived") === "true"),
			);
		}
		if (method === "POST" && route.length === 1) {
			const profile = await this.application.services.profiles.create(
				await readJson(request, SaveAgentProfileSchema),
			);
			await this.application.logger.log("assistant.create", { profileId: profile.id, version: profile.version });
			return sendJson(response, 201, profile);
		}
		if (method === "GET" && route.length === 2) {
			return sendJson(response, 200, await this.application.services.profiles.get(route[1]));
		}
		if (method === "DELETE" && route.length === 2) {
			const input = await readJson(request, ExpectedVersion);
			await this.application.services.profiles.delete(route[1], input.expectedVersion);
			await this.application.logger.log("assistant.delete", { profileId: route[1] });
			return sendJson(response, 200, { deleted: true });
		}
		if (method === "PUT" && route.length === 2) {
			const input = await readJson(request, UpdateAgentProfileSchema);
			const { expectedVersion, ...profileInput } = input;
			const profile = await this.application.services.profiles.update(route[1], profileInput, expectedVersion);
			await this.application.logger.log("assistant.update", { profileId: profile.id, version: profile.version });
			return sendJson(response, 200, profile);
		}
		if (method === "POST" && route.length === 3 && route[2] === "clone") {
			const input = await readJson(request, ProfileClone);
			return sendJson(response, 201, await this.application.services.profiles.clone(route[1], input.name));
		}
		if (method === "POST" && route.length === 3 && (route[2] === "archive" || route[2] === "restore")) {
			const input = await readJson(request, ExpectedVersion);
			const profile =
				route[2] === "archive"
					? await this.application.services.profiles.archive(route[1], input.expectedVersion)
					: await this.application.services.profiles.restore(route[1], input.expectedVersion);
			return sendJson(response, 200, profile);
		}
		throw new WorkbenchError("not_found", "Assistant route not found");
	}

	private async mcp(
		request: IncomingMessage,
		response: ServerResponse,
		method: string,
		route: string[],
	): Promise<void> {
		if (route[1] !== "connections") throw new WorkbenchError("not_found", "MCP route not found");
		if (method === "GET" && route.length === 2) {
			const values = await this.application.services.connections.list();
			return sendJson(
				response,
				200,
				await Promise.all(
					values.map(async (connection) => ({
						...connection,
						secretRef: undefined,
						authentication: await this.application.secrets.getStatus(connection.secretRef),
					})),
				),
			);
		}
		if (method === "POST" && route.length === 2) {
			const input = await readJson(request, SaveMcpConnectionSchema);
			const secretRef =
				input.secret || input.authKind === "oauth"
					? await this.application.secrets.create(input.secret ?? {})
					: undefined;
			let saved = false;
			try {
				const { secret: _secret, ...configuration } = input;
				const connection = await this.application.services.connections.create({ ...configuration, secretRef });
				saved = true;
				await this.application.logger.log("mcp.connection.create", {
					connectionId: connection.id,
					transport: connection.transport,
				});
				return sendJson(response, 201, {
					...connection,
					secretRef: undefined,
					authentication: await this.application.secrets.getStatus(secretRef),
				});
			} catch (error) {
				if (!saved && secretRef) await this.application.secrets.delete(secretRef);
				throw error;
			}
		}
		if (route.length < 3) throw new WorkbenchError("not_found", "MCP connection route not found");
		const id = route[2];
		if (method === "GET" && route.length === 3) {
			const connection = await this.application.services.connections.get(id);
			return sendJson(response, 200, {
				...connection,
				secretRef: undefined,
				authentication: await this.application.secrets.getStatus(connection.secretRef),
			});
		}
		if (method === "PUT" && route.length === 3) {
			const input = await readJson(request, UpdateMcpConnectionSchema);
			const current = await this.application.services.connections.get(id);
			if (current.version !== input.expectedVersion)
				throw new WorkbenchError("conflict", "MCP connection changed since it was loaded");
			let secretRef = current.secretRef;
			const credentialScopeChanged =
				current.transport !== input.transport ||
				current.authKind !== input.authKind ||
				current.remote?.url !== input.remote?.url ||
				current.remote?.clientId !== input.remote?.clientId ||
				JSON.stringify(current.stdio) !== JSON.stringify(input.stdio);
			if (credentialScopeChanged) secretRef = undefined;
			if (input.secret) secretRef = await this.application.secrets.create(input.secret);
			else if (input.authKind === "oauth" && !secretRef) secretRef = await this.application.secrets.create({});
			const { secret: _secret, expectedVersion, ...configuration } = input;
			let saved = false;
			try {
				const connection = await this.application.services.connections.update(
					id,
					{ ...configuration, secretRef },
					expectedVersion,
				);
				saved = true;
				if (current.secretRef && current.secretRef !== secretRef)
					await this.application.secrets.delete(current.secretRef);
				return sendJson(response, 200, {
					...connection,
					secretRef: undefined,
					authentication: await this.application.secrets.getStatus(secretRef),
				});
			} catch (error) {
				if (!saved && secretRef && secretRef !== current.secretRef)
					await this.application.secrets.delete(secretRef);
				throw error;
			}
		}
		if (method === "POST" && route[3] === "test") {
			return sendJson(response, 200, await this.application.services.connections.test(id));
		}
		if (method === "GET" && route[3] === "tools") {
			return sendJson(response, 200, await this.application.services.connections.listTools(id));
		}
		if (method === "POST" && route[3] === "authorize") {
			return sendJson(response, 200, await this.application.oauth.beginAuthorization(id));
		}
		if (method === "DELETE" && route[3] === "authorization") {
			await this.application.disconnectAuthorization(id);
			return sendJson(response, 200, { disconnected: true });
		}
		if (method === "PATCH" && route[3] === "enabled") {
			const input = await readJson(request, ConnectionEnabled);
			return sendJson(
				response,
				200,
				await this.application.services.connections.setEnabled(id, input.enabled, input.expectedVersion),
			);
		}
		throw new WorkbenchError("not_found", "MCP connection route not found");
	}

	private async oauthCallback(response: ServerResponse, url: URL): Promise<void> {
		try {
			const result = await this.application.oauth.completeAuthorization(url.searchParams);
			response.writeHead(303, {
				location: `/connections?oauth=success&connectionId=${encodeURIComponent(result.connectionId)}`,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			});
		} catch (error) {
			await this.application.logger.log("mcp.oauth.error", { message: getErrorMessage(error) });
			response.writeHead(303, {
				location: "/connections?oauth=failed",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			});
		}
		response.end();
	}

	private async assistantDrafts(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "POST" && route.length === 1) {
			const input = await readJson(request, CreateAssistantDraftSchema);
			return sendJson(
				response,
				202,
				await this.application.services.assistantDrafts.start(input.requirement, input.model),
			);
		}
		if (method === "GET" && route.length === 2) {
			return sendJson(response, 200, await this.application.services.assistantDrafts.get(route[1]));
		}
		if (method === "GET" && route.length === 3 && route[2] === "events") {
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-store",
				connection: "keep-alive",
				"x-accel-buffering": "no",
				"x-content-type-options": "nosniff",
			});
			response.write(": connected\n\n");
			const after = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0);
			for await (const event of this.application.services.assistantDrafts.subscribe(
				route[1],
				Number.isFinite(after) ? after : 0,
			)) {
				if (response.destroyed) break;
				response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
			return;
		}
		if (method === "PUT" && route.length === 2) {
			const input = await readJson(request, UpdateAssistantDraftSchema);
			return sendJson(
				response,
				200,
				await this.application.services.assistantDrafts.saveEdits(
					route[1],
					{
						...input.config,
						description: input.config.description ?? "",
						tools: input.config.tools ?? [],
						skillIds: input.config.skillIds ?? [],
						mcpBindings: input.config.mcpBindings ?? [],
					},
					input.expectedVersion,
				),
			);
		}
		if (method === "POST" && route.length === 3 && route[2] === "create-profile") {
			return sendJson(response, 201, await this.application.services.assistantDrafts.createProfile(route[1]));
		}
		if (method === "POST" && route.length === 3 && route[2] === "cancel") {
			return sendJson(response, 200, await this.application.services.assistantDrafts.cancel(route[1]));
		}
		throw new WorkbenchError("not_found", "Assistant draft route not found");
	}

	private async projects(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "GET" && route.length === 3 && route[2] === "deletion-preview")
			return sendJson(response, 200, await this.application.services.projectDeletion.preview(route[1]));
		if (method === "DELETE" && route.length === 2) {
			const { expectedFingerprint } = await readJson(
				request,
				Type.Object(
					{ expectedFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
					{ additionalProperties: false },
				),
			);
			if (this.activeApiRequests.size !== 1)
				throw new WorkbenchError("conflict", "工作台还有正在处理的请求，请稍后重试删除");
			this.deletingProject = true;
			try {
				return sendJson(response, 200, await this.application.deleteProject(route[1], expectedFingerprint));
			} finally {
				this.deletingProject = false;
			}
		}
		if (route.length >= 3 && route[2] === "knowledge") {
			const project = await this.application.services.projects.get(route[1]);
			if (route[3] === "index") await this.application.services.projects.assertSourceAvailable(project);
			return handleKnowledgeRequest(
				this.application.services.knowledge,
				project,
				request,
				response,
				url,
				route.slice(3),
				sendJson,
			);
		}
		if (route.length >= 3 && route[2] === "learning") return this.projectLearning(request, response, method, route);
		if (route.length === 4 && route[2] === "files") {
			const project = await this.application.services.projects.get(route[1]);
			if (!project.sourcePath) throw new WorkbenchError("invalid_input", "该项目没有关联本机目录");
			await this.application.services.projects.assertSourceAvailable(project);
			if (method === "GET" && route[3] === "list")
				return sendJson(
					response,
					200,
					await this.application.services.files.list(url.searchParams.get("path") ?? "", project.sourcePath),
				);
			if (method === "GET" && route[3] === "read")
				return sendJson(
					response,
					200,
					await this.application.services.files.read(url.searchParams.get("path") ?? "", project.sourcePath),
				);
			if (method === "PUT" && route[3] === "write") {
				const input = await readJson(request, FileWrite);
				return sendJson(
					response,
					200,
					await this.application.services.files.write(
						input.path,
						input.content,
						input.expectedHash,
						project.sourcePath,
					),
				);
			}
		}
		if (method === "GET" && route.length === 1) {
			const pending = new Set(
				(await this.application.repositories.projects.pendingDeletions()).map((intent) => intent.project.id),
			);
			return sendJson(
				response,
				200,
				(await this.application.repositories.projects.list()).map((project) => ({
					...project,
					deletionPending: pending.has(project.id),
				})),
			);
		}
		if (method === "POST" && route.length === 1) {
			const project = await this.application.createProject(await readJson(request, ProjectCreate));
			await this.application.logger.log("project.create", { projectId: project.id });
			return sendJson(response, 201, project);
		}
		if (method === "GET" && route.length === 2)
			return sendJson(response, 200, await this.application.services.projects.get(route[1]));
		throw new WorkbenchError("not_found", "Project route not found");
	}

	private async projectLearning(
		request: IncomingMessage,
		response: ServerResponse,
		method: string,
		route: string[],
	): Promise<void> {
		const projectId = route[1];
		const service = this.application.services.learning;
		await this.application.services.projects.get(projectId);
		if (route.length === 3 && method === "GET")
			return sendJson(response, 200, {
				settings: await service.settings(projectId),
				cadences: await service.schedule(projectId),
				...(await service.page(
					projectId,
					Number(new URL(request.url!, "http://localhost").searchParams.get("offset")) || 0,
					20,
					new URL(request.url!, "http://localhost").searchParams.get("pending") === "true",
				)),
			});
		if (route.length === 4 && route[3] === "experiences" && method === "GET")
			return sendJson(response, 200, await service.experiences(projectId));
		if (route[3] !== "reviews") throw new WorkbenchError("not_found", "项目复盘接口不存在");
		if (route.length === 4 && method === "POST") {
			const { sessionId } = await readJson(
				request,
				Type.Object({ sessionId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
			);
			const session = await this.application.services.sessions.get(sessionId);
			if (session.projectId !== projectId) throw new WorkbenchError("path_denied", "只能复盘当前项目的会话");
			return sendJson(response, 202, await service.reviewSession(sessionId));
		}
		const review = await service.get(route[4]);
		if (review.projectId !== projectId) throw new WorkbenchError("path_denied", "复盘记录不属于当前项目");
		if (route.length === 5 && method === "GET") return sendJson(response, 200, await service.detail(review.id));
		if (route.length === 6 && route[5] === "retry" && method === "POST")
			return sendJson(response, 202, await service.retry(review.id));
		if (route.length === 6 && method === "POST" && route[5] === "cancel")
			return sendJson(response, 200, await service.cancel(review.id));
		if (route.length === 8 && method === "POST" && route[5] === "changes") {
			const action = route[7];
			if (action !== "apply" && action !== "reject" && action !== "rollback")
				throw new WorkbenchError("invalid_input", "无效的经验更新操作");
			const input = await readJson(request, ExpectedVersion);
			return sendJson(response, 200, await service.resolve(review.id, route[6], action, input.expectedVersion));
		}
		throw new WorkbenchError("not_found", "项目复盘接口不存在");
	}

	private async tasks(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "POST" && route[1] === "cleanup" && route.length === 3 && route[2] === "preview")
			return sendJson(
				response,
				200,
				await this.application.services.taskCleanup.preview(await readJson(request, TaskCleanupPreview)),
			);
		if (method === "POST" && route[1] === "cleanup" && route.length === 2) {
			const input = await readJson(request, TaskCleanup);
			return sendJson(
				response,
				200,
				await this.application.services.taskCleanup.cleanup(input.tasks, input.deleteHistory),
			);
		}
		if (method === "GET" && route.length === 1) {
			const statusValue = url.searchParams.get("status");
			return sendJson(
				response,
				200,
				await this.application.services.tasks.list({
					projectId: url.searchParams.get("projectId") ?? undefined,
					status: statusValue ? parseValue(taskStatusSchema(), statusValue) : undefined,
				}),
			);
		}
		if (method === "POST" && route.length === 1) {
			const task = await this.application.services.tasks.create(await readJson(request, TaskCreate));
			await this.application.logger.log("task.create", { taskId: task.id, projectId: task.projectId });
			await this.application.services.activity.record({
				projectId: task.projectId,
				type: "task.created",
				summary: `Created task ${task.title}`,
				metadata: { taskId: task.id, taskType: task.type },
			});
			return sendJson(response, 201, task);
		}
		if (method === "POST" && route.length === 3 && route[2] === "run") {
			const input = await readJson(request, AgentTaskStart);
			return sendJson(response, 202, await this.application.startTask(route[1], input));
		}
		if (method === "GET" && route.length === 3 && route[2] === "runs") {
			return sendJson(response, 200, await this.application.services.tasks.listRuns(route[1]));
		}
		if (method === "GET" && route.length === 2)
			return sendJson(response, 200, await this.application.services.tasks.get(route[1]));
		if (method === "PATCH" && route.length === 2) {
			const task = await this.application.services.tasks.update(route[1], await readJson(request, TaskUpdate));
			await this.application.services.activity.record({
				projectId: task.projectId,
				type: "task.updated",
				summary: `${task.title} moved to ${task.status}`,
				metadata: { taskId: task.id, status: task.status },
			});
			return sendJson(response, 200, task);
		}
		throw new WorkbenchError("not_found", "Task route not found");
	}

	private async memory(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "GET" && route[1] === "search") {
			const query = url.searchParams.get("q") ?? "";
			const projectId = url.searchParams.get("projectId") ?? undefined;
			const project = projectId ? await this.application.services.projects.get(projectId) : undefined;
			return sendJson(
				response,
				200,
				await this.application.services.memory.search(
					{ project },
					query,
					Number(url.searchParams.get("limit") ?? 10),
				),
			);
		}
		if (method === "GET" && route[1] === "files") {
			return sendJson(response, 200, await this.application.services.memory.listFiles());
		}
		if (method === "GET" && route.length === 2 && route[1] === "file") {
			return sendJson(
				response,
				200,
				await this.application.services.memory.read(url.searchParams.get("path") ?? ""),
			);
		}
		if (method === "GET" && route[1] === "candidates" && route.length === 2) {
			const statusValue = url.searchParams.get("status");
			return sendJson(
				response,
				200,
				await this.application.services.memory.listCandidates(
					statusValue ? parseValue(memoryCandidateStatusSchema(), statusValue) : undefined,
				),
			);
		}
		if (method === "POST" && route[1] === "candidates" && route.length === 2) {
			const input = await readJson(request, MemoryCandidateCreate);
			const project = input.projectId ? await this.application.services.projects.get(input.projectId) : undefined;
			const candidate = await this.application.services.memory.propose({ project }, input);
			await this.application.logger.log("memory.candidate", { candidateId: candidate.id, kind: candidate.kind });
			await this.application.services.activity.record({
				projectId: candidate.projectId,
				type: "memory.candidate.created",
				summary: `Proposed ${candidate.kind} memory`,
				metadata: { candidateId: candidate.id },
			});
			return sendJson(response, 201, candidate);
		}
		if (method === "POST" && route[1] === "candidates" && route[3] === "accept") {
			const candidate = await this.application.services.memory.accept(route[2]);
			await this.application.services.activity.record({
				projectId: candidate.projectId,
				type: "memory.candidate.accepted",
				summary: `Accepted ${candidate.kind} memory`,
				metadata: { candidateId: candidate.id },
			});
			return sendJson(response, 200, candidate);
		}
		if (method === "POST" && route[1] === "candidates" && route[3] === "reject") {
			const candidate = await this.application.services.memory.reject(route[2]);
			await this.application.services.activity.record({
				projectId: candidate.projectId,
				type: "memory.candidate.rejected",
				summary: `Rejected ${candidate.kind} memory`,
				metadata: { candidateId: candidate.id },
			});
			return sendJson(response, 200, candidate);
		}
		if (method === "PUT" && route[1] === "file") {
			const input = await readJson(request, MemoryEdit);
			return sendJson(
				response,
				200,
				await this.application.services.memory.edit(
					input.path,
					input.content,
					input.expectedHash,
					input.kind,
					input.projectId,
				),
			);
		}
		if (method === "DELETE" && route[1] === "file") {
			const input = await readJson(request, MemoryReindex);
			await this.application.services.memory.delete(input.kind, input.path, input.projectId);
			return sendJson(response, 200, { deleted: true });
		}
		if (method === "POST" && route[1] === "reindex") {
			const input = await readJson(request, MemoryReindex);
			return sendJson(
				response,
				200,
				await this.application.services.memory.reindex(input.kind, input.path, input.projectId),
			);
		}
		throw new WorkbenchError("not_found", "Memory route not found");
	}

	private async skills(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "POST" && route.length === 3 && route[2] === "preview-update") {
			return sendJson(response, 201, await this.application.services.skillImports.previewUpdate(route[1]));
		}
		if (method === "GET" && route[1] === "imports" && route.length === 4 && route[3] === "file") {
			return sendJson(
				response,
				200,
				await this.application.services.skillImports.readPreviewFile(
					route[2],
					url.searchParams.get("slug") ?? "",
					url.searchParams.get("path") ?? "",
				),
			);
		}
		if (method === "POST" && route.length === 1) {
			const input = await readJson(request, CreateSkillSchema);
			const project = input.projectId ? await this.application.services.projects.get(input.projectId) : undefined;
			const skill = await this.application.services.skills.create({ ...input, project });
			return sendJson(response, 201, skill);
		}
		if (method === "POST" && route[1] === "imports" && route.length === 2) {
			const value = await this.application.services.skillImports.preview(
				await readJson(request, CreateSkillImportSchema),
			);
			return sendJson(response, 201, value);
		}
		if (method === "GET" && route[1] === "imports" && route.length === 3) {
			return sendJson(response, 200, await this.application.services.skillImports.get(route[2]));
		}
		if (method === "POST" && route[1] === "imports" && route[3] === "commit") {
			const input = await readJson(request, CommitSkillImportSchema);
			return sendJson(
				response,
				200,
				await this.application.services.skillImports.commitImport(route[2], input.slugs),
			);
		}
		if (method === "DELETE" && route[1] === "imports" && route.length === 3) {
			return sendJson(response, 200, await this.application.services.skillImports.discardPreview(route[2]));
		}
		if (method === "GET" && route.length === 1) {
			await this.application.services.skills.discover("global");
			for (const project of await this.application.services.projects.list()) {
				await this.application.services.skills.discover("project", project);
			}
			const skills = await this.application.services.skills.list({
				scope:
					url.searchParams.get("scope") === "project"
						? "project"
						: url.searchParams.has("scope")
							? "global"
							: undefined,
				projectId: url.searchParams.get("projectId") ?? undefined,
			});
			return sendJson(
				response,
				200,
				skills.map((skill) => ({
					...skill,
					path: relative(this.application.paths.workspace, skill.path).replaceAll("\\", "/"),
				})),
			);
		}
		if (method === "PATCH" && route.length === 2) {
			const input = await readJson(request, SkillToggle);
			return sendJson(response, 200, await this.application.services.skills.setEnabled(route[1], input.enabled));
		}
		if (method === "GET" && route.length === 3 && route[2] === "content") {
			return sendJson(response, 200, await this.application.services.skills.readContent(route[1]));
		}
		if (method === "PUT" && route.length === 3 && route[2] === "content") {
			const input = await readJson(request, SaveSkillContentSchema);
			return sendJson(
				response,
				200,
				await this.application.services.skills.saveContent(route[1], input.content, input.expectedHash),
			);
		}
		throw new WorkbenchError("not_found", "Skill route not found");
	}

	private async settings(
		request: IncomingMessage,
		response: ServerResponse,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "GET" && route.length === 1)
			return sendJson(
				response,
				200,
				(await this.application.services.settings.list()).filter(
					(setting) =>
						!["models.catalog", "search.builtinUpgrade", "memory.userDocumentLocation"].includes(setting.key) &&
						!setting.key.startsWith("learning."),
				),
			);
		if (method === "PUT" && route.length === 2) {
			if (route[1] === "memory.userDocumentLocation")
				throw new WorkbenchError("invalid_input", "记忆存储迁移由工作台内部管理，不能手动修改");
			if (route[1].startsWith("learning."))
				throw new WorkbenchError("invalid_input", "项目自动学习由后台管理，无需设置策略或间隔");
			if (["models.catalog", "search.enabled", "search.builtinUpgrade"].includes(route[1]))
				throw new WorkbenchError("invalid_input", "请使用对应的模型或搜索设置接口");
			const input = await readJson(request, SettingSet);
			if (route[1] === "models.default" && input.value !== null) {
				const model = parseValue(ModelSelect, input.value);
				if (
					!(await this.application.runtime.listModels()).some(
						(candidate) =>
							candidate.available &&
							candidate.provider === model.provider &&
							candidate.modelId === model.modelId,
					)
				)
					throw new WorkbenchError("invalid_input", "默认模型必须已添加、启用且凭证可用");
			}
			if (route[1] === "agent.defaultProfileId") {
				if (typeof input.value !== "string") throw new WorkbenchError("invalid_input", "Assistant ID is required");
				await this.application.services.profiles.setDefault(input.value);
				return sendJson(response, 200, await this.application.services.settings.get(route[1]));
			}
			return sendJson(
				response,
				200,
				await this.application.services.settings.set(route[1], input.value as JsonValue, input.expectedVersion),
			);
		}
		throw new WorkbenchError("not_found", "Settings route not found");
	}

	private async sessions(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "GET" && route.length === 1)
			return sendJson(
				response,
				200,
				await this.application.services.sessions.list(
					url.searchParams.get("projectId") ?? undefined,
					url.searchParams.get("includeArchived") === "true",
				),
			);
		if (method === "POST" && route.length === 1) {
			const input = await readJson(request, SessionCreate);
			if (!input.profileId && !input.profileSlug) throw new WorkbenchError("invalid_input", "开始对话前请选择助手");
			const session = await this.application.configure(
				() => this.application.createSession(input),
				`session-create:${randomBytes(12).toString("hex")}`,
			);
			await this.application.logger.log("session.create", { sessionId: session.id, projectId: session.projectId });
			return sendJson(response, 201, session);
		}
		if (method === "GET" && route.length === 2)
			return sendJson(response, 200, await this.application.services.sessions.get(route[1]));
		if (route[2] === "attachments") {
			await this.application.services.sessions.get(route[1]);
			if (method === "POST" && route.length === 3) {
				const declared = Number(request.headers["content-length"] ?? 0);
				if (declared > MAX_CHAT_ATTACHMENT_BYTES) {
					request.resume();
					throw new WorkbenchError("invalid_input", "附件超过 20 MiB");
				}
				const controller = new AbortController();
				const abort = () => controller.abort();
				response.once("close", abort);
				try {
					const buffers: Buffer[] = [];
					let size = 0;
					for await (const chunk of request) {
						const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						size += buffer.length;
						if (size > MAX_CHAT_ATTACHMENT_BYTES) throw new WorkbenchError("invalid_input", "附件超过 20 MiB");
						buffers.push(buffer);
					}
					return sendJson(
						response,
						201,
						await this.chatAttachments.upload(
							route[1],
							url.searchParams.get("name") ?? "",
							Buffer.concat(buffers),
							controller.signal,
						),
					);
				} finally {
					response.off("close", abort);
				}
			}
			if (method === "GET" && route.length === 5 && route[4] === "file") {
				const { attachment, bytes } = await this.chatAttachments.original(route[1], route[3]);
				response.writeHead(200, {
					"content-type": attachment.mimeType,
					"content-length": bytes.length,
					"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"content-security-policy": "default-src 'none'; frame-ancestors 'none'",
				});
				response.end(bytes);
				return;
			}
			if (method === "DELETE" && route.length === 4) {
				if (this.application.events.getActiveRunId(route[1]))
					throw new WorkbenchError("conflict", "请等待当前运行结束再清理附件");
				await this.chatAttachments.removePending(route[1], route[3]);
				return sendJson(response, 200, { deleted: true });
			}
			throw new WorkbenchError("not_found", "会话附件接口不存在");
		}
		if (method === "GET" && route.length === 3 && route[2] === "file-preview") {
			const session = await this.application.services.sessions.get(route[1]);
			const project = session.projectId
				? await this.application.services.projects.get(session.projectId)
				: undefined;
			if (project?.sourcePath) await this.application.services.projects.assertSourceAvailable(project);
			const projectRoot = project?.sourcePath ?? project?.workspacePath;
			const root = projectRoot ?? this.application.paths.workspace;
			const requestedPath = url.searchParams.get("path") ?? "";
			if (!requestedPath.trim()) throw new WorkbenchError("invalid_input", "请选择要预览的文件");
			const scopedPath = isAbsolute(requestedPath) ? relative(root, requestedPath) : requestedPath;
			return sendJson(response, 200, await this.application.services.files.read(scopedPath, projectRoot));
		}
		if (method === "POST" && route.length === 3 && route[2] === "commands") {
			const input = await readJson(request, SessionCommand);
			const context = await this.application.contextForSession(route[1]);
			const controller = new AbortController();
			const onClose = () => controller.abort();
			response.once("close", onClose);
			try {
				const result = await this.application.configure(
					(signal) =>
						this.application.services.sessions.executeCommand(
							route[1],
							input,
							context.runtime,
							AbortSignal.any([signal, controller.signal]),
						),
					`session:${route[1]}`,
				);
				await this.application.logger.log("session.command", { sessionId: route[1], command: input.name });
				return sendJson(response, 200, result);
			} finally {
				response.off("close", onClose);
			}
		}
		if (method === "PUT" && route.length === 3 && route[2] === "title") {
			const input = await readJson(request, SessionTitle);
			const session = await this.application.services.sessions.rename(route[1], input.title, input.expectedTitle);
			await this.application.logger.log("session.rename", { sessionId: session.id });
			return sendJson(response, 200, session);
		}
		if (method === "PUT" && route.length === 3 && route[2] === "assistant") {
			if (this.application.events.getActiveRunId(route[1]))
				throw new WorkbenchError("conflict", "请先停止运行，再切换助手");
			const input = await readJson(request, SessionAssistant);
			const session = await this.application.configure(
				() => this.application.services.sessions.selectProfile(route[1], input.profileId, input.expectedProfileId),
				`session:${route[1]}`,
			);
			await this.application.logger.log("session.assistant", {
				sessionId: session.id,
				profileId: session.agentProfileId,
			});
			return sendJson(response, 200, session);
		}
		if (
			(method === "DELETE" && route.length === 2) ||
			(method === "POST" && route.length === 3 && (route[2] === "archive" || route[2] === "restore"))
		) {
			if (this.application.events.getActiveRunId(route[1]))
				throw new WorkbenchError("conflict", "请先停止会话，再归档或删除");
			if (method === "DELETE") {
				const session = await this.application.repositories.sessions.get(route[1]);
				await this.application.services.sessions.delete(route[1]);
				await this.chatAttachments.deleteSession(route[1]);
				await this.application.services.browserUse.closeSession(route[1]);
				this.application.events.forgetSession(route[1]);
				this.application.diagnostics.forgetSession(route[1]);
				if (session) this.application.diagnostics.forgetSession(session.runtimeSessionId);
				await this.application.logger.log("session.delete", { sessionId: route[1] });
				return sendJson(response, 200, { deleted: true });
			}
			const session = await this.application.services.sessions.archive(route[1], route[2] === "archive");
			await this.application.logger.log(`session.${route[2]}`, { sessionId: route[1] });
			return sendJson(response, 200, session);
		}
		if (method === "GET" && route.length === 3 && route[2] === "runtime-state") {
			const development = await this.application.services.sessions.readDevelopmentState(route[1]);
			const usage = await this.application.services.sessions.readUsage(route[1]);
			const inputQueue = await this.application.services.sessions.readInputQueue(route[1]);
			return sendJson(response, 200, {
				activeRunId: this.application.events.getActiveRunId(route[1]) ?? null,
				development,
				usage,
				inputQueue,
			});
		}
		if (route.length === 3 && route[2] === "permission-mode") {
			const session = await this.application.services.sessions.get(route[1]);
			if (method === "GET")
				return sendJson(response, 200, { mode: await this.application.services.permissions.getMode(session.id) });
			if (method === "PUT") {
				const { mode } = await readJson(request, SetPermissionModeSchema);
				await this.application.services.permissions.setMode(session.id, mode);
				await this.application.logger.log("permission.mode", { sessionId: session.id, mode });
				return sendJson(response, 200, { mode });
			}
		}
		if (method === "POST" && route[2] === "resume") {
			if (this.application.events.getActiveRunId(route[1]))
				throw new WorkbenchError("conflict", "请先停止会话，再恢复");
			const context = await this.application.contextForSession(route[1]);
			const session = await this.application.configure(
				() => this.application.services.sessions.resume(route[1], context.runtime),
				`session:${route[1]}`,
			);
			await this.application.logger.log("session.resume", { sessionId: session.id });
			await this.application.services.activity.record({
				projectId: session.projectId,
				sessionId: session.id,
				type: "session.resumed",
				summary: `Resumed ${session.title}`,
			});
			return sendJson(response, 200, session);
		}
		if (method === "GET" && route[2] === "transcript") {
			return sendJson(response, 200, await this.application.services.sessions.readTranscript(route[1]));
		}
		if (method === "GET" && route[2] === "context")
			return sendJson(response, 200, await this.application.contextForSession(route[1]));
		if (method === "POST" && route[2] === "messages") {
			const input = await readJson(request, MessageCreate);
			if (!input.text.trim() && !input.attachmentIds?.length)
				throw new WorkbenchError("invalid_input", "消息或附件不能为空");
			const name = /^\/([a-z-]+)(?:\s|$)/u.exec(input.text.trim())?.[1];
			if (name && this.application.runtime.listCommands?.().some((command) => command.name === name))
				throw new WorkbenchError("invalid_input", "Pi 命令应通过聊天命令菜单执行，不会作为提示词发送给模型");
			const controller = new AbortController();
			const onClose = () => controller.abort();
			response.once("close", onClose);
			try {
				const attachments = await this.chatAttachments.prepare(
					route[1],
					input.attachmentIds ?? [],
					controller.signal,
				);
				const session = await this.application.services.sessions.get(route[1]);
				if (attachments.images?.length) {
					const model = (await this.application.runtime.listModels()).find(
						(item) => item.provider === session.model?.provider && item.modelId === session.model?.modelId,
					);
					if (!model?.vision)
						throw new WorkbenchError(
							"invalid_input",
							"当前模型未启用图片输入，请在顶部选择支持视觉的模型，或在模型设置中核实视觉能力",
						);
				}
				const text = input.text.trim() || "请查看本轮上传的附件。";
				const context = await this.application.contextForSession(route[1], text, controller.signal);
				controller.signal.throwIfAborted();
				await this.application.services.sessions.prepareInvocation(route[1], text, input.selection);
				controller.signal.throwIfAborted();
				return sendJson(
					response,
					202,
					this.application.events.start(route[1], {
						...input,
						...attachments,
						text,
						context: context.runtime,
						turnContext: context.turn,
					}),
				);
			} finally {
				response.off("close", onClose);
			}
		}
		if (method === "POST" && route.length === 3 && route[2] === "steer") {
			const input = await readJson(request, MessageSteer);
			const name = /^\/([a-z-]+)(?:\s|$)/u.exec(input.text.trim())?.[1];
			if (name && this.application.runtime.listCommands?.().some((command) => command.name === name))
				throw new WorkbenchError("invalid_input", "Pi 命令应通过聊天命令菜单执行，不能作为追加指令发送");
			await this.application.services.sessions.steer(route[1], input);
			await this.application.logger.log("message.steer", { sessionId: route[1], runId: input.runId });
			return sendJson(response, 202, { runId: input.runId });
		}
		if (
			(method === "POST" && route.length === 3 && route[2] === "queue") ||
			(method === "PATCH" && route.length === 4 && route[2] === "queue")
		) {
			const input =
				method === "POST" ? await readJson(request, MessageSteer) : await readJson(request, MessageQueueUpdate);
			const text = "text" in input ? input.text : input.action.kind === "edit" ? input.action.text : "";
			const name = /^\/([a-z-]+)(?:\s|$)/u.exec(text.trim())?.[1];
			if (name && this.application.runtime.listCommands?.().some((command) => command.name === name))
				throw new WorkbenchError("invalid_input", "Pi 命令不能排队，请在会话空闲时执行");
			const queue = await this.application.services.sessions.updateInputQueue(
				route[1],
				"text" in input ? input : { ...input, itemId: route[3] },
			);
			await this.application.logger.log("message.queue", {
				sessionId: route[1],
				runId: input.runId,
				action: "text" in input ? "add" : input.action.kind,
			});
			return sendJson(response, method === "POST" ? 202 : 200, queue);
		}
		if (method === "POST" && route[2] === "abort") {
			this.application.stopContextPreparation(route[1]);
			const activeRunId = this.application.services.sessions.getActiveRunId(route[1]);
			if (activeRunId) await this.application.services.permissions.cancelRun(activeRunId);
			await this.application.events.abort(route[1]);
			return sendJson(response, 202, { status: "aborting" });
		}
		if (method === "PUT" && route[2] === "model") {
			if (this.application.events.getActiveRunId(route[1]))
				throw new WorkbenchError("conflict", "请先停止会话，再更改模型");
			const input = await readJson(request, ModelSelect);
			const context = await this.application.contextForSession(route[1]);
			return sendJson(
				response,
				200,
				await this.application.configure(
					() => this.application.services.sessions.selectModel(route[1], input, context.runtime),
					`session:${route[1]}`,
				),
			);
		}
		if (method === "PUT" && route.length === 3 && route[2] === "thinking") {
			const input = await readJson(
				request,
				Type.Object({ level: ThinkingLevelSchema }, { additionalProperties: false }),
			);
			const context = await this.application.contextForSession(route[1]);
			return sendJson(
				response,
				200,
				await this.application.configure(
					() => this.application.services.sessions.selectThinkingLevel(route[1], input.level, context.runtime),
					`session:${route[1]}`,
				),
			);
		}
		throw new WorkbenchError("not_found", "Session route not found");
	}

	private async runs(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "GET" && route.length === 2) return sendJson(response, 200, this.application.events.get(route[1]));
		if (method !== "GET" || route[2] !== "events") throw new WorkbenchError("not_found", "Run route not found");
		this.application.events.get(route[1]);
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
			"x-content-type-options": "nosniff",
		});
		response.write(": connected\n\n");
		const after = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0);
		for await (const entry of this.application.events.subscribe(route[1], Number.isFinite(after) ? after : 0)) {
			if (response.destroyed) break;
			response.write(`id: ${entry.sequence}\nevent: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`);
		}
		response.end();
	}

	private async approvals(
		request: IncomingMessage,
		response: ServerResponse,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "GET" && route.length === 1)
			return sendJson(response, 200, await this.application.repositories.approvals.listPending());
		if (method === "POST" && route[2] === "resolve") {
			const input = await readJson(request, ApprovalResolve);
			return sendJson(response, 200, await this.application.services.permissions.resolve(route[1], input.decision));
		}
		throw new WorkbenchError("not_found", "Approval route not found");
	}

	private async files(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		method: string,
		route: string[],
	): Promise<void> {
		if (method === "GET" && route[1] === "list")
			return sendJson(response, 200, await this.application.services.files.list(url.searchParams.get("path") ?? ""));
		if (method === "GET" && route[1] === "read")
			return sendJson(response, 200, await this.application.services.files.read(url.searchParams.get("path") ?? ""));
		if (method === "PUT" && route[1] === "write") {
			const input = await readJson(request, FileWrite);
			if (this.application.services.files.isManagedMemory(input.path)) {
				if (!input.expectedHash) {
					throw new WorkbenchError("invalid_input", "Managed memory edits require the loaded content hash");
				}
				const target = managedMemoryTarget(input.path);
				if (!target) throw new WorkbenchError("invalid_input", "Managed memory path is not recognized");
				if (target.kind === "user")
					throw new WorkbenchError("path_denied", "用户偏好已迁至工作台根目录，请通过记忆入口修改 USER.md");
				const project =
					target.kind === "project"
						? (await this.application.services.projects.list()).find((entry) => entry.slug === target.projectSlug)
						: undefined;
				if (target.kind === "project" && !project) {
					throw new WorkbenchError("not_found", `Project memory workspace not found: ${target.projectSlug}`);
				}
				await this.application.services.memory.edit(
					input.path,
					input.content,
					input.expectedHash,
					target.kind,
					project?.id,
				);
				await this.application.services.activity.record({
					projectId: project?.id,
					type: "memory.file.edited",
					summary: `Edited ${input.path}`,
				});
				return sendJson(response, 200, await this.application.services.files.read(input.path));
			}
			return sendJson(
				response,
				200,
				await this.application.services.files.write(input.path, input.content, input.expectedHash),
			);
		}
		throw new WorkbenchError("not_found", "File route not found");
	}

	private async home(response: ServerResponse): Promise<void> {
		const [projects, tasks, sessions, artifacts, activity] = await Promise.all([
			this.application.services.projects.list(),
			this.application.services.tasks.list(),
			this.application.services.sessions.list(),
			this.application.services.artifacts.list(),
			this.application.services.activity.list({ limit: 12 }),
		]);
		const now = new Date();
		const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
		const openTasks = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
		const dueTasks = openTasks.filter((task) => task.dueAt && new Date(task.dueAt).getTime() < endOfToday);
		return sendJson(response, 200, {
			projects: projects.filter((project) => project.status === "active").slice(0, 6),
			tasks: (dueTasks.length > 0 ? dueTasks : openTasks).slice(0, 8),
			sessions: sessions.slice(0, 8),
			artifacts: artifacts.slice(0, 8),
			activity,
		});
	}
}
