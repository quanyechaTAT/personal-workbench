import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const SCREENSHOT_NOTICE = "[截图仅供下一次视觉模型请求，查看后自动清理；需要重看时请重新截图。]";
const TEXT_MODEL_NOTICE = "[图像已屏蔽：当前模型不支持图像输入，请切换支持视觉的模型。]";

export function isScreenshotResult(toolName: string, details?: unknown): boolean {
	if (toolName === "browser_use" || toolName === "computer_use") return true;
	return (
		toolName === "run_code" &&
		typeof details === "object" &&
		details !== null &&
		"ptcCalls" in details &&
		Array.isArray(details.ptcCalls) &&
		details.ptcCalls.some(
			(call: unknown) =>
				typeof call === "object" &&
				call !== null &&
				"toolName" in call &&
				(call.toolName === "browser_use" || call.toolName === "computer_use"),
		)
	);
}

export function createScreenshotExtension() {
	// Image bytes never enter durable tool results. They live only until the next successful model response.
	const pending = new Map<string, ImageContent[]>();
	const delivered = new Set<string>();
	const clear = () => {
		pending.clear();
		delivered.clear();
	};
	const extension: ExtensionFactory = (pi) => {
		pi.on("tool_result", (event, context) => {
			const images = event.content.filter((part): part is ImageContent => part.type === "image");
			if (images.length === 0) return undefined;
			const supportsImages = context.model?.input.includes("image") === true;
			if (!supportsImages) {
				return {
					content: event.content.map((part) =>
						part.type === "image" ? { type: "text" as const, text: TEXT_MODEL_NOTICE } : part,
					),
					isError: true,
				};
			}
			if (!isScreenshotResult(event.toolName, event.details)) return undefined;
			const totalSize = [...pending.values()].flat().reduce((size, image) => size + image.data.length, 0);
			if (
				!event.isError &&
				pending.size < 8 &&
				totalSize + images.reduce((size, image) => size + image.data.length, 0) <= 32 * 1024 * 1024
			) {
				pending.set(event.toolCallId, images);
			} else {
				return {
					content: [{ type: "text", text: "截图未保留：本轮图像数量或大小达到上限，需先查看已有截图。" }],
					isError: true,
				};
			}
			return {
				content: event.content.map((part) =>
					part.type === "image" ? { type: "text" as const, text: SCREENSHOT_NOTICE } : part,
				),
			};
		});
		pi.on("context", (event, context) => {
			delivered.clear();
			const supportsImages = context.model?.input.includes("image") === true;
			const messages: ContextEvent["messages"] = event.messages.map((message) => {
				if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") return message;
				if (typeof message.content === "string") return message;
				const screenshot = message.role === "toolResult" && isScreenshotResult(message.toolName, message.details);
				const content: (TextContent | ImageContent)[] = message.content.map((part) =>
					part.type === "image" && (!supportsImages || screenshot)
						? { type: "text", text: supportsImages ? SCREENSHOT_NOTICE : TEXT_MODEL_NOTICE }
						: part,
				);
				if (supportsImages && message.role === "toolResult") {
					for (const [id, images] of pending) {
						if (
							id === message.toolCallId ||
							(message.toolName === "run_code" && id.startsWith(`${message.toolCallId}:`))
						) {
							content.push(...images);
							delivered.add(id);
						}
					}
				}
				return { ...message, content };
			});
			if (!supportsImages) clear();
			return { messages };
		});
		pi.on("message_end", (event) => {
			if (
				event.message.role === "assistant" &&
				event.message.stopReason !== "error" &&
				event.message.stopReason !== "aborted"
			) {
				for (const id of delivered) pending.delete(id);
				delivered.clear();
			}
		});
		pi.on("agent_settled", clear);
		pi.on("session_shutdown", clear);
	};
	return { extension, clear };
}
