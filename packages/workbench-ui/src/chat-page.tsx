import type { RuntimeInputQueue, RuntimeQueueAction } from "@earendil-works/workbench-runtime";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
	type AgentEvent,
	type AgentStreamEvent,
	ApiError,
	type Approval,
	api,
	type ChatCapability,
	type RuntimeThinkingLevel,
	type RuntimeTranscriptMessage,
	streamRun,
	type WorkbenchSession,
} from "./api.ts";
import { ChatAttachmentDrafts, MessageAttachments, useChatAttachments } from "./chat-attachments.tsx";
import { parseChatCommand, useChatCommands } from "./chat-commands.tsx";
import { ChatFilePreview } from "./chat-file-preview.tsx";
import { ChatInput } from "./chat-input.tsx";
import { HydeTrace } from "./hyde-trace.tsx";
import "./chat-commands.css";
import { Icons } from "./icons.tsx";
import { label, profileName } from "./labels.ts";
import { LiveEvents } from "./live-events.tsx";
import { Markdown } from "./markdown.tsx";
import { MemoryManifest, SessionMemoryPanel } from "./memory-layers-panel.tsx";
import { MessageQueue } from "./message-queue.tsx";
import { MessageUsage } from "./message-usage.tsx";
import { ToolResult } from "./search-results.tsx";
import { SessionSidebar } from "./session-sidebar.tsx";
import { SessionTitleDialog } from "./session-title-dialog.tsx";
import { Screenshot } from "./tool-images.tsx";
import { UsageMeter } from "./usage-meter.tsx";

export { LiveEvents } from "./live-events.tsx";

import { isPermissionMode, type PermissionMode } from "@earendil-works/workbench-core/contracts";
import { EmptyState, ErrorNotice, formatRelative, LoadingBlock, StatusPill } from "./ui.tsx";

function TranscriptMessage({
	message,
	assistantName,
	onPreviewFile,
	sessionId,
}: {
	message: RuntimeTranscriptMessage;
	assistantName: string;
	onPreviewFile?: (path: string) => void;
	sessionId?: string;
}) {
	return (
		<article className={`message message-${message.role}`}>
			<div className="message-avatar">
				{message.role === "user" ? "我" : message.role === "assistant" ? <Icons.Spark /> : <Icons.Tool />}
			</div>
			<div className="message-body">
				<div className="message-meta">
					<strong>
						{message.role === "user"
							? "我"
							: message.role === "assistant"
								? assistantName
								: label(message.toolLabel ?? message.toolName ?? "工具")}
					</strong>
					<span>{formatRelative(message.timestamp)}</span>
					{message.role === "tool" && <StatusPill value={message.isError ? "failed" : "completed"} />}
				</div>
				{message.content.map((content, index) => {
					if (content.type === "image")
						return (
							<Screenshot
								key={`${message.id}-${index}`}
								part={content}
								alt={message.role === "user" ? "上传的图片" : "工具截图"}
							/>
						);
					if (content.type === "skill")
						return (
							<details className="skill-invocation" key={`${message.id}-${index}`}>
								<summary>已使用技能：{content.skillName}</summary>
								<pre>{content.text}</pre>
							</details>
						);
					if (content.type === "reasoning")
						return (
							<details className="reasoning" key={`${message.id}-${index}`}>
								<summary>思考过程</summary>
								<div>{content.text}</div>
							</details>
						);
					if (content.type === "tool-call")
						return (
							<div className="tool-card" key={`${message.id}-${index}`}>
								<div>
									<Icons.Tool />
									<strong>{label(content.toolLabel ?? content.toolName ?? "工具")}</strong>
								</div>
								<pre>{JSON.stringify(content.arguments, null, 2)}</pre>
							</div>
						);
					return (
						<div className="message-text" key={`${message.id}-${index}`}>
							{message.role === "assistant" ? (
								<Markdown text={content.text ?? ""} onPreviewFile={onPreviewFile} />
							) : message.role === "tool" ? (
								<ToolResult text={content.text ?? ""} />
							) : (
								content.text
							)}
						</div>
					);
				})}
				{sessionId && <MessageAttachments sessionId={sessionId} items={message.attachments} />}
				{message.errorMessage && <ErrorNotice error={message.errorMessage} />}
				{message.role === "assistant" && <MessageUsage usage={message.usage} />}
			</div>
		</article>
	);
}

export function latestOpenSessionId(sessions: WorkbenchSession[]): string | undefined {
	return sessions
		.filter((session) => session.status !== "closed" && !session.archivedAt)
		.sort((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt))[0]?.id;
}

export function visibleStreamHistory(
	history: RuntimeTranscriptMessage[],
	events: AgentEvent[],
): RuntimeTranscriptMessage[] {
	const started = events.find((event) => event.type === "run.started");
	if (!started) return history;
	const inputIndex = history.findIndex(
		(message, index) =>
			message.role === "user" &&
			(started.data.historyMessageCount !== undefined
				? index >= started.data.historyMessageCount
				: Date.parse(message.timestamp) >= Date.parse(started.occurredAt)),
	);
	return history.filter(
		(message, index) =>
			index === inputIndex ||
			(started.data.historyMessageCount !== undefined
				? index < started.data.historyMessageCount
				: Date.parse(message.timestamp) < Date.parse(started.occurredAt)),
	);
}

function ApprovalPanel({
	approval,
	onResolve,
	pending,
}: {
	approval: Approval;
	onResolve: (id: string, decision: "approved" | "denied") => void;
	pending: boolean;
}) {
	return (
		<div className="inspector-approval">
			<div>
				<Icons.Tool />
				<strong>
					{typeof approval.operation.label === "string" ? approval.operation.label : approval.toolName}
				</strong>
			</div>
			<pre>{JSON.stringify(approval.operation, null, 2)}</pre>
			<div className="approval-actions">
				<button
					type="button"
					className="button secondary"
					disabled={pending}
					onClick={() => onResolve(approval.id, "denied")}
				>
					拒绝
				</button>
				<button
					type="button"
					className="button primary"
					disabled={pending}
					onClick={() => onResolve(approval.id, "approved")}
				>
					批准本次
				</button>
			</div>
		</div>
	);
}

export function ChatPage({ lockedProjectId }: { lockedProjectId?: string } = {}) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const commands = useQuery({ queryKey: ["runtime-commands"], queryFn: api.commands });
	const [searchParams, setSearchParams] = useSearchParams();
	const selectedSessionId = searchParams.get("session") ?? undefined;
	const externalRunId = searchParams.get("run") ?? undefined;
	const activeChat = useRef({ sessionId: selectedSessionId, runId: externalRunId });
	activeChat.current = { sessionId: selectedSessionId, runId: externalRunId };
	const requestedAssistantId = searchParams.get("assistant") ?? undefined;
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
	const sessions = useQuery({
		queryKey: ["sessions", lockedProjectId],
		queryFn: () => api.sessions(lockedProjectId, true),
		refetchInterval: 2_000,
	});
	const sidebarSessions = useQuery({
		queryKey: ["sessions", undefined],
		queryFn: () => api.sessions(undefined, true),
		enabled: Boolean(lockedProjectId),
		refetchInterval: lockedProjectId ? 2_000 : false,
	});
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
	const transcript = useQuery({
		queryKey: ["transcript", selectedSessionId],
		queryFn: () => api.transcript(selectedSessionId!),
		enabled: Boolean(selectedSessionId),
	});
	const context = useQuery({
		queryKey: ["context", selectedSessionId],
		queryFn: () => api.context(selectedSessionId!),
		enabled: Boolean(selectedSessionId),
	});
	const approvals = useQuery({ queryKey: ["approvals"], queryFn: api.approvals, refetchInterval: 2_000 });
	const [draft, setDraft] = useState("");
	const [selectedCapabilities, setSelectedCapabilities] = useState<ChatCapability[]>([]);
	const [sessionView, setSessionView] = useState<"active" | "archived">("active");
	const [sessionMenu, setSessionMenu] = useState<string>();
	const [namingSession, setNamingSession] = useState<WorkbenchSession | "new">();
	const [namingTitle, setNamingTitle] = useState("");
	const [namingProjectId, setNamingProjectId] = useState<string>();
	const [showSessionPicker, setShowSessionPicker] = useState(false);
	const [projectId, setProjectId] = useState(lockedProjectId ?? "");
	const [profileId, setProfileId] = useState("");
	const [modelValue, setModelValue] = useState("");
	const [thinkingLevel, setThinkingLevel] = useState<RuntimeThinkingLevel>();
	const [events, setEvents] = useState<AgentEvent[]>([]);
	const [running, setRunning] = useState(false);
	const [streamError, setStreamError] = useState<string>();
	const [preview, setPreview] = useState<{ sessionId: string; path: string }>();
	const [inspectorOpen, setInspectorOpen] = useState(false);
	const inspectorToggle = useRef<HTMLButtonElement>(null);
	const streamClose = useRef<(() => void) | undefined>(undefined);
	const autoSelectedProjectId = useRef<string | undefined>(undefined);
	const conversationScroll = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const attachmentInputRef = useRef<HTMLInputElement>(null);
	const submission = useRef<AbortController | undefined>(undefined);
	const [submitting, setSubmitting] = useState(false);
	const [uploadStatus, setUploadStatus] = useState<string>();
	const followOutput = useRef(true);
	const scrollSession = useRef<string | undefined>(undefined);
	const lastOutput = useRef<string | undefined>(undefined);
	const [showLatest, setShowLatest] = useState(false);
	const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
	const [historySnapshot, setHistorySnapshot] = useState<RuntimeTranscriptMessage[]>();
	const [optimisticMessage, setOptimisticMessage] = useState<RuntimeTranscriptMessage>();
	const permission = useQuery({
		queryKey: ["permission-mode", selectedSessionId],
		queryFn: () => api.permissionMode(selectedSessionId!),
		enabled: Boolean(selectedSessionId),
	});
	useEffect(() => {
		if (permission.data) setPermissionMode(permission.data.mode);
	}, [permission.data]);
	const selectedSession = sessions.data?.find((session) => session.id === selectedSessionId);
	const sessionState = useQuery({
		queryKey: ["session-state", selectedSessionId],
		queryFn: () => api.sessionState(selectedSessionId!),
		enabled: Boolean(selectedSessionId),
		staleTime: 0,
		refetchInterval: running ? 2_000 : false,
	});
	useEffect(() => {
		const activeRunId = sessionState.data?.activeRunId;
		if (!selectedSessionId || sessionState.isFetching || !sessionState.data) return;
		if (externalRunId && activeRunId && activeRunId !== externalRunId) {
			setSearchParams({ session: selectedSessionId }, { replace: true });
			return;
		}
		if (selectedSessionId && activeRunId && !externalRunId && !sessionState.isFetching)
			setSearchParams({ session: selectedSessionId, run: activeRunId }, { replace: true });
	}, [sessionState.data, sessionState.isFetching, selectedSessionId, externalRunId, setSearchParams]);
	const activeProjectId = lockedProjectId ?? (selectedSession ? selectedSession.projectId : projectId);
	const selectedProject = projects.data?.find((project) => project.id === activeProjectId);
	const newProjectId = lockedProjectId ?? (selectedSession ? undefined : projectId);
	const attachmentDraft = useChatAttachments(selectedSessionId ?? `draft:${activeProjectId ?? ""}`);
	const namingProject = projects.data?.find((project) => project.id === namingProjectId);
	const selectedProfile = selectedSessionId
		? profiles.data?.find((profile) => profile.id === selectedSession?.agentProfileId)
		: profileId
			? profiles.data?.find((profile) => profile.id === profileId)
			: profiles.data?.find((profile) => profile.id === requestedAssistantId);
	const defaultModel = settings.data?.find((entry) => entry.key === "models.default")?.value;
	const configuredDefault =
		typeof defaultModel === "object" &&
		defaultModel !== null &&
		"provider" in defaultModel &&
		"modelId" in defaultModel
			? `${defaultModel.provider}/${defaultModel.modelId}`
			: undefined;
	const defaultReference = selectedProfile?.defaultModel
		? `${selectedProfile.defaultModel.provider}/${selectedProfile.defaultModel.modelId}`
		: configuredDefault;
	const firstAvailableModel = models.data?.models.find((model) => model.available);
	const defaultSelection =
		defaultReference ?? (firstAvailableModel ? `${firstAvailableModel.provider}/${firstAvailableModel.modelId}` : "");
	const reference = selectedSession?.model
		? `${selectedSession.model.provider}/${selectedSession.model.modelId}`
		: modelValue || defaultReference;
	const selectedModel = reference
		? models.data?.models.find((model) => `${model.provider}/${model.modelId}` === reference && model.available)
		: firstAvailableModel;
	const thinkingLevels = selectedModel?.thinkingLevels ?? [];
	const chosenThinking = selectedSession?.thinkingLevel ?? thinkingLevel;
	const actualThinking =
		chosenThinking && thinkingLevels.includes(chosenThinking)
			? chosenThinking
			: thinkingLevels.includes("high")
				? "high"
				: thinkingLevels[0];
	const requestedModel = selectedModel
		? { provider: selectedModel.provider, modelId: selectedModel.modelId }
		: undefined;
	const hasImageAttachments = attachmentDraft.items.some(
		(item) => item.file.type.startsWith("image/") || /\.(?:png|jpe?g|bmp|webp|gif)$/iu.test(item.file.name),
	);
	useEffect(() => () => submission.current?.abort(), []);
	const chatCapabilities = useQuery({
		queryKey: ["chat-capabilities", selectedSessionId, selectedProfile?.id, activeProjectId],
		queryFn: () =>
			api.chatCapabilities({
				sessionId: selectedSessionId,
				profileId: selectedProfile?.id,
				projectId: activeProjectId || undefined,
			}),
		enabled: Boolean(selectedSessionId || selectedProfile),
	});

	useEffect(() => {
		if (scrollSession.current === selectedSessionId) return;
		scrollSession.current = selectedSessionId;
		followOutput.current = true;
		setShowLatest(false);
	}, [selectedSessionId]);
	const visibleEvents = events.filter(
		(event) => event.sessionId === selectedSessionId && event.runId === externalRunId,
	);
	const streamedQueue = visibleEvents.filter((event) => event.type === "input.queue").at(-1)?.data;
	const savedQueue =
		externalRunId && sessionState.data?.activeRunId === externalRunId ? sessionState.data.inputQueue : undefined;
	const inputQueue =
		(savedQueue?.revision ?? -1) > (streamedQueue?.revision ?? -1) ? savedQueue : (streamedQueue ?? savedQueue);
	const queuedSteering = inputQueue?.steering ?? [];
	const cacheQueue = (sessionId: string, runId: string, queue: RuntimeInputQueue) => {
		queryClient.setQueryData<Awaited<ReturnType<typeof api.sessionState>>>(["session-state", sessionId], (current) =>
			current?.activeRunId !== runId || (current.inputQueue?.revision ?? -1) > queue.revision
				? current
				: { ...current, inputQueue: queue },
		);
	};
	const visiblePreview = preview?.sessionId === selectedSessionId ? preview : undefined;
	const previewFile = (path: string) => {
		if (selectedSessionId) setPreview({ sessionId: selectedSessionId, path });
	};
	const outputRevision = `${selectedSessionId ?? "new"}:${visibleEvents.at(-1)?.id ?? ""}:${transcript.data?.at(-1)?.id ?? ""}:${optimisticMessage?.id ?? ""}`;
	useEffect(() => {
		if (lastOutput.current === outputRevision) return;
		lastOutput.current = outputRevision;
		if (followOutput.current)
			conversationScroll.current?.scrollTo({ top: conversationScroll.current.scrollHeight, behavior: "instant" });
		else setShowLatest(true);
	}, [outputRevision]);
	useEffect(() => {
		const input = inputRef.current;
		if (!input || input.value !== draft) return;
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
	}, [draft]);
	useEffect(() => {
		if (
			!lockedProjectId ||
			searchParams.get("draft") === "1" ||
			selectedSessionId ||
			sessions.isLoading ||
			autoSelectedProjectId.current === lockedProjectId
		)
			return;
		autoSelectedProjectId.current = lockedProjectId;
		const sessionId = latestOpenSessionId(sessions.data ?? []);
		if (sessionId) setSearchParams({ session: sessionId }, { replace: true });
	}, [lockedProjectId, selectedSessionId, sessions.data, sessions.isLoading, setSearchParams, searchParams]);

	const resolveApproval = useMutation({
		mutationFn: ({ id, decision }: { id: string; decision: "approved" | "denied" }) =>
			api.resolveApproval(id, decision),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["approvals"] }),
	});
	const modelMutation = useMutation({
		mutationFn: ({ sessionId, model }: { sessionId: string; model: { provider: string; modelId: string } }) =>
			api.selectModel(sessionId, model),
		onSuccess: async (session) => {
			queryClient.setQueryData<WorkbenchSession[]>(["sessions", lockedProjectId], (current) =>
				current?.map((entry) => (entry.id === session.id ? session : entry)),
			);
			setModelValue(session.model ? `${session.model.provider}/${session.model.modelId}` : "");
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["sessions"] }),
				queryClient.invalidateQueries({ queryKey: ["context", session.id] }),
			]);
		},
	});
	const thinkingMutation = useMutation({
		mutationFn: ({ id, level }: { id: string; level: RuntimeThinkingLevel }) => api.selectThinking(id, level),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
	});
	const assistantMutation = useMutation({
		mutationFn: ({
			id,
			profileId,
			expectedProfileId,
		}: {
			id: string;
			profileId: string;
			expectedProfileId: string;
		}) => api.selectAssistant(id, profileId, expectedProfileId),
		onSuccess: async (session) => {
			queryClient.setQueryData<WorkbenchSession[]>(["sessions", lockedProjectId], (current) =>
				current?.map((entry) => (entry.id === session.id ? session : entry)),
			);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["context", session.id] }),
				queryClient.invalidateQueries({ queryKey: ["chat-capabilities", session.id] }),
			]);
		},
	});
	const assistantPending = assistantMutation.isPending && assistantMutation.variables.id === selectedSessionId;
	const assistantError = assistantMutation.variables?.id === selectedSessionId ? assistantMutation.error : null;
	const steeringMutation = useMutation({
		mutationFn: ({ sessionId, runId, text }: { sessionId: string; runId: string; text: string }) =>
			api.steerMessage(sessionId, runId, text),
	});
	const queueMutation = useMutation({
		mutationFn: ({ sessionId, runId, text }: { sessionId: string; runId: string; text: string }) =>
			api.queueMessage(sessionId, runId, text),
		onSuccess: (queue, { sessionId, runId }) => cacheQueue(sessionId, runId, queue),
	});
	const queueAction = useMutation({
		mutationFn: ({
			sessionId,
			runId,
			itemId,
			action,
		}: {
			sessionId: string;
			runId: string;
			itemId: string;
			action: RuntimeQueueAction;
		}) => api.updateQueuedMessage(sessionId, runId, itemId, action),
		onSuccess: (queue, { sessionId, runId }) => cacheQueue(sessionId, runId, queue),
	});

	const permissionMutation = useMutation({
		mutationFn: ({ id, mode }: { id: string; mode: PermissionMode }) => api.setPermissionMode(id, mode),
		onSuccess: (result, { id }) => {
			queryClient.setQueryData(["permission-mode", id], result);
			if (activeChat.current.sessionId === id) setPermissionMode(result.mode);
			void queryClient.invalidateQueries({ queryKey: ["approvals"] });
		},
	});
	const permissionPending = permissionMutation.isPending && permissionMutation.variables.id === selectedSessionId;
	const permissionSaveError = permissionMutation.variables?.id === selectedSessionId ? permissionMutation.error : null;
	const changePermissionMode = (value: string) => {
		if (!isPermissionMode(value)) return;
		if (
			value === "full-access" &&
			!window.confirm(
				"完全访问权限会继续当前待批准的操作，并跳过后续 Shell、工作区外文件、浏览器、桌面和已绑定 MCP 工具的批准。本地命令仍受设置中的沙箱边界限制。凭证、内部状态和长期记忆仍受文件工具保护。是否为本会话启用？",
			)
		)
			return;
		if (selectedSessionId) permissionMutation.mutate({ id: selectedSessionId, mode: value });
		else setPermissionMode(value);
	};
	const resetDraft = () => {
		submission.current?.abort();
		setSubmitting(false);
		setUploadStatus(undefined);
		attachmentDraft.clear();
		autoSelectedProjectId.current = lockedProjectId;
		streamClose.current?.();
		setSearchParams({});
		setHistorySnapshot(undefined);
		setOptimisticMessage(undefined);
		setEvents([]);
		setStreamError(undefined);
		setRunning(false);
		setPermissionMode("ask");
		setThinkingLevel(undefined);
		setModelValue("");
		setProfileId("");
		setProjectId(lockedProjectId ?? "");
		setDraft("");
		setSelectedCapabilities([]);
		setSessionMenu(undefined);
	};
	const chooseSession = (session: WorkbenchSession) => {
		submission.current?.abort();
		setSubmitting(false);
		setUploadStatus(undefined);
		attachmentDraft.clear();
		autoSelectedProjectId.current = lockedProjectId;
		streamClose.current?.();
		setHistorySnapshot(undefined);
		setOptimisticMessage(undefined);
		setRunning(session.status === "running");
		setProjectId(session.projectId ?? "");
		setProfileId("");
		setModelValue(session.model ? `${session.model.provider}/${session.model.modelId}` : "");
		setThinkingLevel(session.thinkingLevel);
		setEvents([]);
		setStreamError(undefined);
		setDraft("");
		setSelectedCapabilities([]);
		setSessionMenu(undefined);
		if (lockedProjectId && session.projectId !== lockedProjectId)
			navigate(
				session.projectId
					? `/projects/${session.projectId}/chat?session=${session.id}`
					: `/chat?session=${session.id}`,
			);
		else setSearchParams({ session: session.id });
	};
	const newSession = useMutation({
		mutationFn: ({ title, profileId, projectId }: { title: string; profileId: string; projectId?: string }) =>
			api.createSession({
				title,
				projectId,
				profileId,
				model: requestedModel,
				thinkingLevel: actualThinking,
			}),
		onSuccess: async (session) => {
			setNamingSession(undefined);
			queryClient.setQueryData<WorkbenchSession[]>(["sessions", undefined], (current) => [
				session,
				...(current ?? []),
			]);
			if (session.projectId)
				queryClient.setQueryData<WorkbenchSession[]>(["sessions", session.projectId], (current) => [
					session,
					...(current ?? []),
				]);
			chooseSession(session);
			setSessionView("active");
			setPermissionMode("ask");
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["sessions"] }),
				queryClient.invalidateQueries({ queryKey: ["home"] }),
			]);
			inputRef.current?.focus();
		},
	});
	const renameSession = useMutation({
		// An explicit user name takes precedence even if the automatic title changed while the dialog was open.
		mutationFn: ({ session, title }: { session: WorkbenchSession; title: string }) =>
			api.renameSession(session.id, title),
		onSuccess: async () => {
			setNamingSession(undefined);
			setSessionMenu(undefined);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["sessions"] }),
				queryClient.invalidateQueries({ queryKey: ["home"] }),
			]);
		},
	});
	const openNaming = (session: WorkbenchSession | "new", title = "", targetProjectId = newProjectId) => {
		newSession.reset();
		renameSession.reset();
		setNamingSession(session);
		setNamingTitle(title);
		setNamingProjectId(targetProjectId || undefined);
	};
	const prepareNewChat = (assistantId: string, targetProjectId?: string) => {
		resetDraft();
		setNamingSession(undefined);
		setProfileId(assistantId);
		setProjectId(targetProjectId ?? "");
		setSessionView("active");
		const params = new URLSearchParams({ assistant: assistantId, draft: "1" });
		if (targetProjectId !== lockedProjectId)
			navigate(`${targetProjectId ? `/projects/${targetProjectId}/chat` : "/chat"}?${params}`);
		else setSearchParams(params);
		inputRef.current?.focus();
	};
	const sessionAction = useMutation({
		mutationFn: ({ id, action }: { id: string; action: "archive" | "restore" | "delete" }) =>
			api.sessionAction(id, action),
		onSuccess: async (_result, { id, action }) => {
			setSessionMenu(undefined);
			if (selectedSessionId === id && action !== "restore") resetDraft();
			if (action === "delete") {
				for (const key of ["transcript", "context", "permission-mode", "session-state"])
					queryClient.removeQueries({ queryKey: [key, id] });
			}
			if (action === "restore") setSessionView("active");
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["sessions"] }),
				queryClient.invalidateQueries({ queryKey: ["home"] }),
			]);
		},
	});
	const actOnSession = (session: WorkbenchSession, action: "archive" | "restore" | "delete") => {
		if (
			action === "delete" &&
			!window.confirm(
				`删除会话“${label(session.title)}”及其对话历史？此操作无法撤销。项目、任务、记忆和成果文件会保留。`,
			)
		)
			return;
		sessionAction.mutate({ id: session.id, action });
	};
	const chatCommands = useChatCommands({
		commands: commands.data ?? [],
		session: selectedSession,
		running,
		models: models.data?.models ?? [],
		thinkingLevels,
		onNew: async (title) => {
			if (title && selectedProfile && !selectedSessionId)
				await newSession.mutateAsync({
					title,
					profileId: selectedProfile.id,
					projectId: newProjectId || undefined,
				});
			else openNaming("new", title);
		},
		onName: async (title) => {
			if (!selectedSession) return;
			if (title) await renameSession.mutateAsync({ session: selectedSession, title });
			else openNaming(selectedSession);
		},
		onResume: async (argument) => {
			if (!argument) {
				setShowSessionPicker(true);
				return;
			}
			const matches =
				sessions.data?.filter(
					(session) => session.status !== "closed" && (session.id === argument || session.title === argument),
				) ?? [];
			if (matches.length !== 1) throw new Error("会话不存在或名称重复，请输入 /resume 从列表选择。");
			if (matches[0].archivedAt) await sessionAction.mutateAsync({ id: matches[0].id, action: "restore" });
			chooseSession(matches[0]);
		},
		onModel: async (model) => {
			if (selectedSessionId)
				await modelMutation.mutateAsync({
					sessionId: selectedSessionId,
					model: { provider: model.provider, modelId: model.modelId },
				});
			else setModelValue(`${model.provider}/${model.modelId}`);
		},
		onThinking: async (level) => {
			if (selectedSessionId) await thinkingMutation.mutateAsync({ id: selectedSessionId, level });
			else setThinkingLevel(level);
		},
		onSettings: () => navigate("/settings?section=models"),
		onFocus: (control) =>
			document
				.querySelector<HTMLSelectElement>(
					`.chat-toolbar [aria-label="${control}"], .composer-wrap [aria-label="${control}"]`,
				)
				?.focus(),
		onRefresh: async () => {
			setEvents([]);
			setHistorySnapshot(undefined);
			await Promise.all(
				["transcript", "context", "sessions", "chat-capabilities", "session-state"].map((key) =>
					queryClient.invalidateQueries({ queryKey: [key] }),
				),
			);
		},
	});
	const draftCommand = parseChatCommand(draft, commands.data ?? []);
	const recoverStreamSnapshot = useCallback(
		async (sessionId: string) => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["transcript", sessionId] }),
				queryClient.invalidateQueries({ queryKey: ["session-state", sessionId] }),
				queryClient.invalidateQueries({ queryKey: ["sessions"] }),
			]);
		},
		[queryClient],
	);
	useEffect(() => {
		if (!externalRunId || !selectedSessionId) return;
		let active = true;
		let frame: number | undefined;
		let queued: AgentEvent[] = [];
		const seen = new Set<string>();
		const flush = () => {
			if (frame !== undefined) cancelAnimationFrame(frame);
			frame = undefined;
			const batch = queued;
			queued = [];
			if (active && batch.length) setEvents((current) => [...current, ...batch]);
		};
		setRunning(true);
		setStreamError(undefined);
		const close = streamRun(
			externalRunId,
			(agentEvent: AgentStreamEvent) => {
				if (!active) return;
				if (
					agentEvent.type !== "stream.reset" &&
					(agentEvent.sessionId !== selectedSessionId || agentEvent.runId !== externalRunId)
				)
					return;
				if (agentEvent.type === "stream.reset") {
					queued = [];
					setEvents([]);
					setHistorySnapshot(undefined);
					setOptimisticMessage(undefined);
					void recoverStreamSnapshot(selectedSessionId);
					return;
				}
				if (seen.has(agentEvent.id)) return;
				seen.add(agentEvent.id);
				queued.push(agentEvent);
				if (frame === undefined) frame = requestAnimationFrame(flush);
				if (agentEvent.type === "run.failed") setStreamError(agentEvent.data.message);
				if (agentEvent.type === "permission.requested" || agentEvent.type === "permission.resolved")
					void queryClient.invalidateQueries({ queryKey: ["approvals"] });
				if (
					agentEvent.type === "run.completed" ||
					agentEvent.type === "run.aborted" ||
					agentEvent.type === "run.failed"
				) {
					flush();
					void Promise.all(
						[
							"transcript",
							"context",
							"session-state",
							"sessions",
							"tasks",
							"approvals",
							"candidates",
							"artifacts",
							"home",
							"profiles",
						].map((key) =>
							queryClient.invalidateQueries({
								queryKey:
									key === "transcript" || key === "context" || key === "session-state"
										? [key, selectedSessionId]
										: [key],
							}),
						),
					)
						.then(() => {
							if (!active) return;
							setEvents([]);
							setOptimisticMessage(undefined);
							setHistorySnapshot(undefined);
							setRunning(false);
						})
						.catch((error: unknown) => {
							if (active) {
								setStreamError(String(error));
								setRunning(false);
							}
						});
				}
			},
			(message) => {
				if (active) {
					flush();
					setStreamError(message);
					setRunning(false);
				}
			},
		);
		const stop = () => {
			active = false;
			close();
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
		streamClose.current = stop;
		return () => {
			stop();
			if (streamClose.current === stop) streamClose.current = undefined;
		};
	}, [externalRunId, selectedSessionId, queryClient, recoverStreamSnapshot]);
	const send = async (event: FormEvent, steer = false) => {
		event.preventDefault();
		if (submission.current || submitting) return;
		const text = draft.trim();
		if (text && !chatCommands.pending && draftCommand) {
			if (await chatCommands.dispatch(text)) setDraft("");
			return;
		}
		if (running) {
			if (
				attachmentDraft.items.length > 0 ||
				!text ||
				!selectedSessionId ||
				!externalRunId ||
				!models.data?.capabilities.steering ||
				steeringMutation.isPending ||
				queueMutation.isPending ||
				chatCommands.pending ||
				selectedSession?.archivedAt ||
				selectedCapabilities.length > 0
			)
				return;
			const sessionId = selectedSessionId;
			const runId = externalRunId;
			setStreamError(undefined);
			try {
				if (steer) await steeringMutation.mutateAsync({ sessionId, runId, text });
				else await queueMutation.mutateAsync({ sessionId, runId, text });
				if (activeChat.current.sessionId === sessionId && activeChat.current.runId === runId)
					setDraft((current) => (current.trim() === text ? "" : current));
			} catch (error) {
				if (activeChat.current.sessionId === sessionId && activeChat.current.runId === runId)
					setStreamError(
						error instanceof ApiError
							? error.message
							: "提交后连接中断。请核对待送达指令和对话记录，再决定是否重新发送。",
					);
			}
			return;
		}
		if (
			(!text && !attachmentDraft.items.length) ||
			selectedSession?.archivedAt ||
			newSession.isPending ||
			sessionAction.isPending ||
			modelMutation.isPending ||
			thinkingMutation.isPending ||
			chatCommands.pending ||
			!selectedModel ||
			!selectedProfile ||
			assistantPending
		)
			return;
		if (hasImageAttachments && !selectedModel.vision) {
			setStreamError("当前模型未启用图片输入，请选择支持视觉的模型后发送。");
			return;
		}
		const requestedAttachments = [...attachmentDraft.items];
		const controller = new AbortController();
		submission.current = controller;
		setSubmitting(true);
		let targetSessionId = selectedSessionId;
		const stillHere = () =>
			submission.current === controller &&
			(activeChat.current.sessionId === targetSessionId ||
				(!selectedSessionId && activeChat.current.sessionId === undefined));
		const requestedCapabilities = selectedCapabilities;
		const selection = {
			skillId: requestedCapabilities.find((item) => item.kind === "skill")?.id,
		};
		setDraft("");
		setSelectedCapabilities([]);
		followOutput.current = true;
		setHistorySnapshot(transcript.data ?? []);
		setOptimisticMessage({
			id: "pending-user",
			role: "user",
			timestamp: new Date().toISOString(),
			content: [{ type: "text", text: text || "请查看本轮上传的附件。" }],
		});
		setEvents([]);
		setStreamError(undefined);
		setRunning(true);
		let submissionAttempted = false;
		try {
			let sessionId = selectedSessionId;
			if (!sessionId) {
				const session = await api.createSession({
					projectId: (lockedProjectId ?? projectId) || undefined,
					profileId: selectedProfile?.id,
					model: requestedModel,
					thinkingLevel: actualThinking,
				});
				sessionId = session.id;
				targetSessionId = session.id;
				controller.signal.throwIfAborted();
				const mode = await api.setPermissionMode(session.id, permissionMode);
				controller.signal.throwIfAborted();
				queryClient.setQueryData(["permission-mode", session.id], mode);
				attachmentDraft.adopt(session.id);
				setSearchParams({ session: session.id });
				await queryClient.invalidateQueries({ queryKey: ["sessions"] });
			}
			const attachments = await attachmentDraft.upload(
				sessionId,
				requestedAttachments,
				controller.signal,
				(value) => {
					if (stillHere()) setUploadStatus(value);
				},
			);
			controller.signal.throwIfAborted();
			if (!stillHere()) return;
			setOptimisticMessage((current) => (current ? { ...current, attachments } : current));
			setUploadStatus(requestedAttachments.length ? "正在发送附件消息…" : undefined);
			submissionAttempted = true;
			const run = await api.startMessage(
				sessionId,
				text,
				selection,
				attachments.map((item) => item.id),
				controller.signal,
			);
			queryClient.setQueryData(["session-state", sessionId], { activeRunId: run.runId });
			if (!stillHere()) return;
			attachmentDraft.clear(false);
			setSearchParams({ session: sessionId, run: run.runId });
		} catch (error) {
			if (!stillHere()) return;
			const definitelyNotSubmitted = !submissionAttempted || error instanceof ApiError;
			if (definitelyNotSubmitted) {
				setDraft(text);
				setSelectedCapabilities(requestedCapabilities);
				setOptimisticMessage(undefined);
				setHistorySnapshot(undefined);
			}
			setStreamError(
				definitelyNotSubmitted
					? controller.signal.aborted
						? "附件发送已取消，草稿已保留。"
						: error instanceof Error
							? error.message
							: String(error)
					: "提交后连接中断。请刷新对话记录，确认消息状态后再发送，避免重复执行。",
			);
			setRunning(false);
		} finally {
			if (submission.current === controller) {
				submission.current = undefined;
				setSubmitting(false);
				setUploadStatus(undefined);
			}
		}
	};
	const stop = async () => {
		if (submission.current) {
			submission.current.abort();
			return;
		}
		if (!selectedSessionId) return;
		try {
			await api.abort(selectedSessionId);
		} catch (error) {
			setStreamError(error instanceof Error ? error.message : String(error));
		}
	};
	const displaySessions = useMemo(
		() =>
			(lockedProjectId ? sidebarSessions.data : sessions.data)?.filter(
				(session) => session.status !== "closed" && Boolean(session.archivedAt) === (sessionView === "archived"),
			) ?? [],
		[sessions.data, sidebarSessions.data, lockedProjectId, sessionView],
	);
	const pendingApprovals =
		approvals.data?.filter((approval) => !selectedSessionId || approval.sessionId === selectedSessionId) ?? [];
	const visibleHistory =
		historySnapshot ?? (transcript.data ? visibleStreamHistory(transcript.data, visibleEvents) : undefined);

	return (
		<div
			className={`chat-layout${lockedProjectId ? " embedded-chat" : ""}${inspectorOpen || visiblePreview ? " context-open" : ""}${visiblePreview ? " preview-open" : ""}`}
		>
			{namingSession && (
				<SessionTitleDialog
					initialTitle={namingSession === "new" ? namingTitle : namingSession.title}
					creating={namingSession === "new"}
					contextLabel={namingSession === "new" ? (namingProject?.name ?? "普通会话") : undefined}
					profiles={profiles.data ?? []}
					initialProfileId={selectedSessionId ? "" : selectedProfile?.id}
					pending={newSession.isPending || renameSession.isPending}
					error={newSession.error ?? renameSession.error}
					onClose={() => setNamingSession(undefined)}
					onSave={(title, profileId) =>
						namingSession === "new"
							? namingTitle
								? newSession.mutate({ title: namingTitle, profileId, projectId: namingProjectId })
								: prepareNewChat(profileId, namingProjectId)
							: renameSession.mutate({ session: namingSession, title })
					}
				/>
			)}
			<SessionSidebar
				projects={projects.data ?? []}
				sessions={displaySessions}
				loading={projects.isLoading || (lockedProjectId ? sidebarSessions.isLoading : sessions.isLoading)}
				error={projects.error ?? (lockedProjectId ? sidebarSessions.error : sessions.error)}
				view={sessionView}
				onView={setSessionView}
				newSessionPending={newSession.isPending}
				onNewSession={(projectId) => openNaming("new", "", projectId ?? "")}
				actions={{
					selectedSessionId,
					menuId: sessionMenu,
					actionPending: sessionAction.isPending,
					onSelect: chooseSession,
					onMenu: setSessionMenu,
					onRename: (session) => openNaming(session),
					onAction: actOnSession,
				}}
			/>
			<section className="conversation-panel">
				<header className="chat-toolbar">
					<div className="compact-session-controls">
						<button
							type="button"
							className="icon-button"
							onClick={() => openNaming("new")}
							disabled={newSession.isPending}
							aria-label="新建会话"
						>
							<Icons.Plus />
						</button>
						<select
							aria-label="切换会话"
							value={selectedSessionId ?? ""}
							onChange={(event) => {
								const session = sessions.data?.find((item) => item.id === event.target.value);
								if (session) chooseSession(session);
							}}
						>
							<option value="">选择会话</option>
							{sessions.data
								?.filter((session) => session.status !== "closed")
								.map((session) => (
									<option key={session.id} value={session.id}>
										{session.archivedAt ? "[已归档] " : ""}
										{label(session.title)}
									</option>
								))}
						</select>
						{selectedSession && (
							<details className="compact-session-actions">
								<summary>操作</summary>
								<button
									type="button"
									disabled={sessionAction.isPending}
									onClick={() => openNaming(selectedSession)}
								>
									重命名会话
								</button>
								<button
									type="button"
									disabled={running || sessionAction.isPending}
									onClick={() =>
										actOnSession(selectedSession, selectedSession.archivedAt ? "restore" : "archive")
									}
								>
									{selectedSession.archivedAt ? "恢复会话" : "归档会话"}
								</button>
								<button
									type="button"
									disabled={running || sessionAction.isPending}
									onClick={() => actOnSession(selectedSession, "delete")}
								>
									删除会话
								</button>
							</details>
						)}
					</div>
					{lockedProjectId ? (
						<div className="locked-context">
							<Icons.Project />
							{selectedProject?.name ?? "项目"}
						</div>
					) : (
						<select
							value={selectedSession ? (selectedSession.projectId ?? "") : projectId}
							onChange={(event) => {
								setProjectId(event.target.value);
								resetDraft();
								setProjectId(event.target.value);
							}}
							aria-label="项目"
							disabled={running}
						>
							<option value="">无项目</option>
							{projects.data?.map((project) => (
								<option key={project.id} value={project.id}>
									{project.name}
								</option>
							))}
						</select>
					)}
					<select
						value={selectedProfile?.id ?? ""}
						onChange={(event) => {
							const profile = profiles.data?.find((p) => p.id === event.target.value);
							if (selectedSession && profile)
								assistantMutation.mutate({
									id: selectedSession.id,
									profileId: profile.id,
									expectedProfileId: selectedSession.agentProfileId,
								});
							else setProfileId(event.target.value);
							setSelectedCapabilities([]);
						}}
						aria-label="助手"
						disabled={running || assistantPending || Boolean(selectedSession?.archivedAt)}
					>
						<option value="" disabled>
							请选择助手
						</option>
						{profiles.data?.map((profile) => (
							<option key={profile.id} value={profile.id}>
								{profileName(profile)}
							</option>
						))}
					</select>
					<select
						value={
							selectedSession?.model
								? `${selectedSession.model.provider}/${selectedSession.model.modelId}`
								: modelValue
						}
						onChange={(event) => {
							setModelValue(event.target.value);
							setThinkingLevel(undefined);
							if (selectedSessionId) {
								const value = event.target.value || defaultSelection;
								if (!value) return;
								const [provider, ...rest] = value.split("/");
								modelMutation.mutate({
									sessionId: selectedSessionId,
									model: { provider, modelId: rest.join("/") },
								});
							}
						}}
						aria-label="模型"
						disabled={running || modelMutation.isPending || thinkingMutation.isPending}
					>
						<option value="">
							默认模型{!selectedSession && selectedModel ? ` · ${selectedModel.name}` : ""}
						</option>
						{models.data?.models
							.filter((model) => model.available)
							.map((model) => (
								<option key={`${model.provider}/${model.modelId}`} value={`${model.provider}/${model.modelId}`}>
									{model.name} · {model.providerName ?? model.provider}
								</option>
							))}
					</select>
					<div className="toolbar-state">
						<span className={`status-dot ${running ? "working" : "online"}`} />
						{running ? "执行中" : "就绪"}
					</div>
					<button
						type="button"
						className="icon-button inspector-toggle"
						ref={inspectorToggle}
						aria-label="会话详情"
						title="会话详情"
						aria-expanded={inspectorOpen && !visiblePreview}
						aria-controls="chat-session-details"
						onClick={() => {
							setInspectorOpen(!inspectorOpen || Boolean(visiblePreview));
							setPreview(undefined);
						}}
					>
						<Icons.Panel />
					</button>
				</header>
				<div
					className="conversation-scroll"
					ref={conversationScroll}
					onScroll={(event) => {
						const element = event.currentTarget;
						followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
						if (followOutput.current) setShowLatest(false);
					}}
				>
					{transcript.isLoading && selectedSessionId && <LoadingBlock label="正在恢复对话" />}
					{transcript.error && <ErrorNotice error={transcript.error} />}
					{(newSession.error || sessionAction.error) && (
						<ErrorNotice error={newSession.error ?? sessionAction.error} />
					)}
					{!optimisticMessage &&
						(!selectedSessionId || transcript.data?.length === 0) &&
						visibleEvents.length === 0 && (
							<EmptyState
								title={selectedProject ? `继续 ${selectedProject.name}` : "开始新对话"}
								description={
									selectedProject
										? "助手会使用本项目的工作区、指令、任务、记忆和技能。"
										: "规划工作、研究问题、整理任务，或继续一个项目。"
								}
							/>
						)}
					{visibleHistory?.map((message) => (
						<TranscriptMessage
							key={message.id}
							message={message}
							sessionId={selectedSessionId}
							assistantName={profileName(selectedProfile)}
							onPreviewFile={previewFile}
						/>
					))}
					{optimisticMessage && (
						<TranscriptMessage message={optimisticMessage} assistantName="我" sessionId={selectedSessionId} />
					)}
					<LiveEvents
						events={visibleEvents}
						assistantName={profileName(selectedProfile)}
						onPreviewFile={previewFile}
					/>
					{streamError && <ErrorNotice error={streamError} />}
				</div>
				<form className="composer-wrap" onSubmit={send}>
					{!selectedProfile && !running && (
						<p className="quiet-copy">
							{selectedSessionId ? "原助手已归档或删除，请选择其他助手继续本会话。" : "请选择助手后开始对话。"}
						</p>
					)}
					{assistantError && <ErrorNotice error={assistantError} />}
					{running && queuedSteering.length > 0 && (
						<section className="chat-command-result" aria-label="等待送达的指令" aria-live="polite">
							<header>
								<strong>等待送达</strong>
								<small>当前步骤完成后处理</small>
							</header>
							{queuedSteering.map((text, index) => (
								<pre key={`${index}:${text}`}>{text}</pre>
							))}
						</section>
					)}
					{(chatCommands.notice || chatCommands.pending) && (
						<section className="chat-command-result" aria-label="命令结果" aria-live="polite">
							<header>
								<strong>{chatCommands.pending ? "正在执行命令…" : "命令结果"}</strong>
								<button
									type="button"
									className="button secondary"
									onClick={chatCommands.pending ? chatCommands.cancel : chatCommands.dismiss}
								>
									{chatCommands.pending ? "取消命令" : "关闭"}
								</button>
							</header>
							{chatCommands.notice && <pre>{chatCommands.notice}</pre>}
						</section>
					)}
					{showSessionPicker && (
						<section className="chat-command-result" aria-label="选择历史会话">
							<header>
								<strong>选择并继续会话</strong>
								<button type="button" className="button secondary" onClick={() => setShowSessionPicker(false)}>
									关闭
								</button>
							</header>
							<div className="chat-command-sessions">
								{sessions.data
									?.filter((session) => session.status !== "closed" && !session.archivedAt)
									.map((session) => (
										<button
											type="button"
											className="button secondary"
											key={session.id}
											onClick={() => {
												chooseSession(session);
												setShowSessionPicker(false);
											}}
										>
											{label(session.title)}
											{session.status === "running" ? " · 执行中" : ""}
										</button>
									))}
							</div>
						</section>
					)}
					{selectedSession?.archivedAt && (
						<div className="archived-notice">
							此会话已归档，可以查看历史。
							<button
								type="button"
								className="button secondary"
								disabled={sessionAction.isPending}
								onClick={() => actOnSession(selectedSession, "restore")}
							>
								恢复会话
							</button>
						</div>
					)}
					{showLatest && (
						<button
							type="button"
							className="button secondary jump-latest"
							onClick={() => {
								followOutput.current = true;
								setShowLatest(false);
								conversationScroll.current?.scrollTo({
									top: conversationScroll.current.scrollHeight,
									behavior: "smooth",
								});
							}}
						>
							回到最新消息
						</button>
					)}
					{pendingApprovals.length > 0 && (
						<section className="composer-approvals" aria-label="等待批准">
							{pendingApprovals.map((approval) => (
								<ApprovalPanel
									key={approval.id}
									approval={approval}
									pending={resolveApproval.isPending}
									onResolve={(id, decision) => resolveApproval.mutate({ id, decision })}
								/>
							))}
						</section>
					)}
					<div className="composer-permissions">
						{thinkingLevels.length > 1 && (
							<label>
								思考强度
								<select
									aria-label="思考强度"
									value={actualThinking}
									disabled={
										running ||
										modelMutation.isPending ||
										thinkingMutation.isPending ||
										Boolean(selectedSession?.archivedAt)
									}
									onChange={(event) => {
										const level = thinkingLevels.find((value) => value === event.target.value);
										if (!level) return;
										if (selectedSessionId) thinkingMutation.mutate({ id: selectedSessionId, level });
										else setThinkingLevel(level);
									}}
								>
									{thinkingLevels.map((level) => (
										<option value={level} key={level}>
											{level === "none"
												? "off · 不思考"
												: level === "low"
													? "low · 轻度"
													: level === "high"
														? "high · 深度"
														: level === "max"
															? "max · 最高"
															: level}
										</option>
									))}
								</select>
							</label>
						)}
						<label
							title={
								permissionMode === "ask"
									? "Shell、外部文件、浏览器、桌面和 MCP 工具逐次批准"
									: permissionMode === "auto"
										? "自动批准已允许的 MCP 工具；Shell、外部文件、浏览器和桌面仍需批准"
										: "跳过操作批准；仅使用助手已选择的工具"
							}
						>
							权限
							<select
								aria-label="权限模式"
								value={permissionMode}
								disabled={permissionPending || Boolean(selectedSessionId && !permission.data)}
								onChange={(event) => changePermissionMode(event.target.value)}
							>
								<option value="ask">请求批准</option>
								<option value="auto">帮我批准</option>
								<option value="full-access">完全访问权限</option>
							</select>
						</label>
						{permissionMutation.isSuccess && permissionMutation.variables.id === selectedSessionId && (
							<output>权限已切换</output>
						)}
					</div>
					{(permissionSaveError ||
						permission.error ||
						resolveApproval.error ||
						modelMutation.error ||
						thinkingMutation.error) && (
						<ErrorNotice
							error={
								permissionSaveError ??
								permission.error ??
								resolveApproval.error ??
								modelMutation.error ??
								thinkingMutation.error
							}
						/>
					)}
					{models.data && !selectedModel && (
						<p className="chat-model-notice">
							{models.data.models.some((model) => model.available)
								? "当前会话或默认模型已停用或不可用，请在顶部选择其他模型。"
								: "当前没有可用的已添加模型。请到设置 → 模型添加并启用模型。"}
						</p>
					)}
					{selectedCapabilities.length > 0 && (
						<section className="selected-capabilities" aria-label="本轮选择的技能">
							{selectedCapabilities.map((item) => (
								<button
									type="button"
									key={`${item.kind}:${item.id}`}
									onClick={() =>
										setSelectedCapabilities((current) =>
											current.filter((value) => value.id !== item.id || value.kind !== item.kind),
										)
									}
									aria-label={`移除 ${label(item.label)}`}
								>
									技能：{label(item.label)} ×
								</button>
							))}
							<small>本轮加载技能，工具由模型自动调用</small>
						</section>
					)}
					{running && selectedSessionId && externalRunId && (
						<MessageQueue
							key={`${selectedSessionId}:${externalRunId}`}
							items={inputQueue?.followUp ?? []}
							pending={queueAction.isPending && queueAction.variables.sessionId === selectedSessionId}
							onAction={async (itemId, action) => {
								await queueAction.mutateAsync({
									sessionId: selectedSessionId,
									runId: externalRunId,
									itemId,
									action,
								});
							}}
						/>
					)}
					<div className="composer">
						<button
							type="button"
							className="composer-attach"
							aria-label="添加附件"
							title="添加本轮附件（也可输入 @）"
							disabled={
								submitting ||
								Boolean(selectedSession?.archivedAt) ||
								newSession.isPending ||
								sessionAction.isPending
							}
							onClick={() => attachmentInputRef.current?.click()}
						>
							＋
						</button>
						<ChatInput
							value={draft}
							onChange={setDraft}
							inputRef={inputRef}
							items={running ? [] : (chatCapabilities.data?.items ?? [])}
							commands={commands.data}
							loading={chatCapabilities.isLoading || commands.isLoading}
							error={
								chatCapabilities.error || commands.error
									? String(chatCapabilities.error ?? commands.error)
									: undefined
							}
							disabled={
								submitting ||
								Boolean(selectedSession?.archivedAt) ||
								newSession.isPending ||
								sessionAction.isPending
							}
							placeholder={running ? "输入下一条消息，回车加入队列…" : "输入消息，@ 添加附件，/ 选择命令或技能…"}
							fileInputRef={attachmentInputRef}
							onFiles={attachmentDraft.add}
							onSelect={(item) => setSelectedCapabilities([item])}
						/>
						{running && (
							<button
								type="button"
								className="composer-steer"
								aria-label="立即纠偏"
								title="当前步骤结束后送达"
								disabled={
									submitting ||
									attachmentDraft.items.length > 0 ||
									!draft.trim() ||
									steeringMutation.isPending ||
									queueMutation.isPending ||
									!models.data?.capabilities.steering ||
									chatCommands.pending ||
									selectedCapabilities.length > 0
								}
								onClick={(event) => void send(event, true)}
							>
								立即纠偏
							</button>
						)}
						{running && (
							<button
								type="button"
								className="send-button stop"
								disabled={!selectedSessionId}
								onClick={stop}
								aria-label="停止执行"
							>
								<Icons.Stop />
							</button>
						)}
						<button
							type="submit"
							className="send-button"
							disabled={
								submitting ||
								chatCommands.pending ||
								(!draft.trim() && !attachmentDraft.items.length) ||
								(!draftCommand && hasImageAttachments && !selectedModel?.vision) ||
								Boolean(selectedSession?.archivedAt) ||
								newSession.isPending ||
								sessionAction.isPending ||
								(running
									? attachmentDraft.items.length > 0 ||
										steeringMutation.isPending ||
										queueMutation.isPending ||
										(!draftCommand &&
											(!selectedSessionId ||
												!externalRunId ||
												!models.data?.capabilities.steering ||
												selectedCapabilities.length > 0))
									: permissionPending ||
										assistantPending ||
										modelMutation.isPending ||
										thinkingMutation.isPending ||
										(!draftCommand && (!selectedModel || !selectedProfile)) ||
										(!draftCommand && Boolean(selectedSessionId && !permission.data)))
							}
							aria-label={running ? "加入消息队列" : "发送消息"}
						>
							<Icons.Send />
						</button>
					</div>
					<ChatAttachmentDrafts
						items={attachmentDraft.items}
						disabled={submitting}
						onRemove={attachmentDraft.remove}
					/>
					{attachmentDraft.error && <ErrorNotice error={attachmentDraft.error} />}
					{hasImageAttachments && selectedModel && !selectedModel.vision && (
						<p className="error-notice">
							当前模型未启用图片输入，请选择支持视觉的模型，或在设置中核实该模型的视觉能力。
						</p>
					)}
					{running && attachmentDraft.items.length > 0 && !submitting && (
						<p className="quiet-copy">
							附件草稿已保留。当前运行结束后可发送；附件暂不支持加入消息队列或立即纠偏。
						</p>
					)}
					{uploadStatus && (
						<div className="attachment-progress">
							<output>{uploadStatus}</output>
							<button type="button" className="button secondary" onClick={() => submission.current?.abort()}>
								取消发送
							</button>
						</div>
					)}
					<div className="composer-hint">
						<span>
							{running
								? "回车排队 · 立即纠偏可补充当前请求"
								: "@ 添加附件 · Ctrl+V 粘贴图片 · / 命令与技能 · 回车发送"}{" "}
							· Shift + 回车换行
						</span>
					</div>
					<UsageMeter
						autoCompactPercent={
							typeof settings.data?.find((entry) => entry.key === "context.autoCompactThresholdPercent")
								?.value === "number"
								? Number(
										settings.data?.find((entry) => entry.key === "context.autoCompactThresholdPercent")
											?.value,
									)
								: 80
						}
						autoCompactEnabled={
							settings.data?.find((entry) => entry.key === "context.autoCompactEnabled")?.value !== false
						}
						onCompact={
							selectedSession
								? () => {
										void chatCommands.dispatch("/compact");
									}
								: undefined
						}
						compactDisabled={
							running || chatCommands.pending || !commands.data?.some((command) => command.name === "compact")
						}
						usage={
							[...visibleEvents].reverse().find((event) => event.type === "usage.updated")?.data ??
							sessionState.data?.usage
						}
					/>
				</form>
			</section>
			{(inspectorOpen || visiblePreview) && (
				<aside
					className="context-inspector"
					id="chat-session-details"
					aria-label={visiblePreview ? "会话文件面板" : "会话详情"}
				>
					{visiblePreview ? (
						<ChatFilePreview
							sessionId={visiblePreview.sessionId}
							path={visiblePreview.path}
							onClose={() => setPreview(undefined)}
						/>
					) : (
						<>
							<div className="panel-heading">
								<div>
									<strong>会话详情</strong>
								</div>
								<button
									type="button"
									className="icon-button"
									aria-label="关闭会话详情"
									onClick={() => {
										setInspectorOpen(false);
										inspectorToggle.current?.focus();
									}}
								>
									<Icons.Close />
								</button>
							</div>
							<div className="inspector-scroll">
								<MemoryManifest result={context.data?.actualMemory} actual />
								<details>
									<summary>下一轮预览（尚未请求模型）</summary>
									<MemoryManifest result={context.data?.memory} />
								</details>
								{selectedSessionId && (
									<SessionMemoryPanel sessionId={selectedSessionId} key={selectedSessionId} />
								)}
								{context.error && <ErrorNotice error={context.error} />}
								{context.data?.diagnostics?.map((diagnostic) => (
									<ErrorNotice key={`${diagnostic.code}:${diagnostic.message}`} error={diagnostic.message} />
								))}
								<section className="inspector-section">
									<h3>会话</h3>
									<dl>
										<div>
											<dt>项目</dt>
											<dd>{selectedProject?.name ?? "未关联项目"}</dd>
										</div>
										<div>
											<dt>助手</dt>
											<dd>{selectedProfile ? profileName(selectedProfile) : "尚未选择"}</dd>
										</div>
										<div>
											<dt>状态</dt>
											<dd>{selectedSession ? <StatusPill value={selectedSession.status} /> : "草稿"}</dd>
										</div>
										<div>
											<dt>模型</dt>
											<dd>
												{selectedModel
													? `${selectedModel.name} · ${selectedModel.providerName ?? selectedModel.provider}`
													: "未选择可用模型"}
											</dd>
										</div>
										<div>
											<dt>思考强度</dt>
											<dd>{actualThinking ?? "模型不支持"}</dd>
										</div>
									</dl>
									{selectedProfile && (
										<p className="quiet-copy">
											已应用 v{selectedSession?.appliedProfileVersion ?? selectedProfile.version}
											{selectedSession?.appliedProfileVersion &&
											selectedSession.appliedProfileVersion !== selectedProfile.version
												? ` · v${selectedProfile.version} 将在下一轮生效`
												: ""}
										</p>
									)}
								</section>
								<section className="inspector-section">
									<h3>上下文来源</h3>
									{context.isLoading && <LoadingBlock />}
									{context.data?.sources.map((source, index) => (
										<div className="context-source" key={`${source.path ?? source.label}-${index}`}>
											<span className={`source-icon source-${source.kind}`}>
												{source.kind.slice(0, 1).toUpperCase()}
											</span>
											<span>
												<strong>{label(source.label)}</strong>
												<small>
													{source.path ?? `${source.characters} 个字符`}
													{source.truncated ? " · 已截断" : ""}
												</small>
											</span>
										</div>
									))}
									{!selectedSessionId && <p className="quiet-copy">创建会话后可查看实际加载的上下文。</p>}
								</section>
								{context.data?.knowledge && (
									<section className="inspector-section" aria-label="最近一次项目知识检索">
										<h3>最近一次项目知识检索</h3>
										<ol>
											{context.data.knowledge.queries.map((query) => (
												<li key={query}>{query}</li>
											))}
										</ol>
										<p className="quiet-copy">
											{context.data.knowledge.mqe.reason} · {context.data.knowledge.contextTokens} Token ·{" "}
											{Math.round(context.data.knowledge.elapsedMs)} ms
										</p>
										{context.data.knowledge.diagnostics.map((message) => (
											<p key={message}>{message}</p>
										))}
										<HydeTrace trace={context.data.knowledge.hyde} />
										{context.data.knowledge.hits.map((hit) => (
											<div className="context-source" key={hit.id ?? `${hit.path}:${hit.chunk}`}>
												<span>
													<strong>
														{hit.name ?? hit.path}
														{hit.startPage ? ` · 第 ${hit.startPage} 页` : ""}
													</strong>
													<small>
														{hit.headingPath?.join(" / ")} · {hit.tokenCount} Token
													</small>
													<small>
														{hit.matches
															?.map(
																(match) =>
																	`${match.method === "keyword" ? "关键词" : match.method === "hyde" ? "HyDE 向量" : "向量"}：${match.query}`,
															)
															.join("；")}
													</small>
												</span>
											</div>
										))}
									</section>
								)}
								<section className="inspector-section">
									<h3>工具</h3>
									<div className="tag-list">
										{(context.data?.runtime.toolNames ?? selectedProfile?.tools ?? []).map((tool) => (
											<span key={tool}>{label(tool)}</span>
										))}
									</div>
								</section>
								<section className="inspector-section">
									<h3>技能</h3>
									<div className="tag-list">
										{context.data?.sources
											.filter((source) => source.kind === "skill")
											.map((skill) => (
												<span key={skill.path}>{skill.label}</span>
											))}
									</div>
								</section>
							</div>
						</>
					)}
				</aside>
			)}
		</div>
	);
}
