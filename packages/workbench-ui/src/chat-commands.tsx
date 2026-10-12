import type { RuntimeModel, RuntimeModelRef } from "@earendil-works/workbench-runtime";
import { useEffect, useRef, useState } from "react";
import { api, type RuntimeSlashCommand, type RuntimeThinkingLevel, type WorkbenchSession } from "./api.ts";

export function parseChatCommand(text: string, commands: readonly RuntimeSlashCommand[]) {
	const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
	const command = commands.find((entry) => entry.name === match?.[1]);
	return command ? { command, argument: match?.[2]?.trim() ?? "" } : undefined;
}

export function useChatCommands(options: {
	commands: RuntimeSlashCommand[];
	session?: WorkbenchSession;
	running: boolean;
	models: RuntimeModel[];
	thinkingLevels: RuntimeThinkingLevel[];
	onNew(title?: string): Promise<void> | void;
	onName(title?: string): Promise<void> | void;
	onResume(argument: string): Promise<void> | void;
	onModel(model: RuntimeModelRef): Promise<void> | void;
	onThinking(level: RuntimeThinkingLevel): Promise<void> | void;
	onSettings(): void;
	onRefresh(): Promise<void>;
	onFocus(control: "模型" | "思考强度"): void;
}) {
	const [notice, setNotice] = useState<string>();
	const [pending, setPending] = useState(false);
	const controller = useRef<AbortController | undefined>(undefined);
	const downloads = useRef<string[]>([]);
	useEffect(
		() => () => {
			controller.current?.abort();
			for (const url of downloads.current) URL.revokeObjectURL(url);
		},
		[],
	);
	const dispatch = async (text: string): Promise<boolean> => {
		const parsed = parseChatCommand(text, options.commands);
		if (!parsed) return false;
		if (pending) return true;
		const { command, argument } = parsed;
		setPending(true);
		setNotice(undefined);
		const signal = new AbortController();
		controller.current = signal;
		try {
			if (command.action === "unsupported") throw new Error(command.unavailableReason);
			if (command.requiresSession && !options.session) throw new Error("请先创建或选择会话，再执行此命令。");
			if (options.running && command.requiresSession && command.action !== "name")
				throw new Error("请先停止当前会话，再执行此命令；可以新建其他会话。");
			const id = options.session?.id;
			switch (command.action) {
				case "settings":
					options.onSettings();
					break;
				case "new":
					await options.onNew(argument || undefined);
					break;
				case "name":
					await options.onName(argument || undefined);
					break;
				case "resume":
					await options.onResume(argument);
					break;
				case "hotkeys":
					setNotice("回车发送 · Shift + 回车换行 · / 打开命令与技能 · ↑↓ 选择 · 回车或 Tab 确认 · Esc 关闭菜单");
					break;
				case "model": {
					if (options.running) throw new Error("请先停止本轮，再切换模型。");
					if (!argument) {
						options.onFocus("模型");
						setNotice("请在顶部模型列表选择已添加的模型，也可输入 /model provider/model。");
						break;
					}
					const matches = options.models.filter(
						(model) =>
							model.available &&
							(`${model.provider}/${model.modelId}` === argument ||
								model.modelId === argument ||
								model.name === argument),
					);
					if (matches.length !== 1)
						throw new Error("模型不可用或存在重名，请使用顶部列表，或填写完整 provider/model。");
					await options.onModel(matches[0]);
					setNotice(`已选择 ${matches[0].name} · ${matches[0].providerName ?? matches[0].provider}`);
					break;
				}
				case "thinking": {
					if (options.running) throw new Error("请先停止本轮，再切换思考强度。");
					if (!argument) {
						options.onFocus("思考强度");
						setNotice(
							`当前可用档位：${options.thinkingLevels.map((level) => (level === "none" ? "off" : level)).join("、")}`,
						);
						break;
					}
					const value = argument === "off" ? "none" : argument;
					const level = options.thinkingLevels.find((entry) => entry === value);
					if (!level) throw new Error("当前模型未启用该思考档位，请在设置 → 模型 → 编辑中检查。");
					await options.onThinking(level);
					setNotice(`思考强度已设为 ${argument}`);
					break;
				}
				case "copy": {
					const history = await api.transcript(id!);
					const text = history
						.filter((message) => message.role === "assistant")
						.at(-1)
						?.content.filter((content) => content.type === "text")
						.map((content) => content.text ?? "")
						.join("\n");
					if (!text) throw new Error("当前会话还没有可复制的助手回复。");
					await navigator.clipboard.writeText(text);
					setNotice("已复制最后一条助手回复。");
					break;
				}
				case "reload":
					await api.reloadSession(id!);
					await options.onRefresh();
					setNotice("已从同一 Pi 会话重载当前指令、技能和工具配置。");
					break;
				case "session": {
					const result = await api.sessionCommand(id!, { name: "session" }, signal.signal);
					if (result.type !== "stats") throw new Error("运行时返回的会话统计类型无效");
					setNotice(
						`会话：${options.session!.title}\n用户消息：${result.userMessages} · 助手消息：${result.assistantMessages}\n工具调用：${result.toolCalls} · 工具结果：${result.toolResults}\nToken 总计：${result.tokens.total} · 输入：${result.tokens.input} · 输出：${result.tokens.output}\n费用：$${result.cost.toFixed(6)}`,
					);
					break;
				}
				case "compact": {
					const result = await api.sessionCommand(
						id!,
						{ name: "compact", instructions: argument || undefined },
						signal.signal,
					);
					if (result.type !== "compaction") throw new Error("运行时返回的压缩类型无效");
					await options.onRefresh();
					setNotice(
						`已压缩上下文：${result.tokensBefore} → ${result.estimatedTokensAfter ?? "未知"} Token\n${result.summary}`,
					);
					break;
				}
				case "export": {
					const format = argument || "html";
					if (format !== "html" && format !== "jsonl")
						throw new Error("使用 /export html 或 /export jsonl。网页下载不接受本机文件路径。");
					const result = await api.sessionCommand(id!, { name: "export", format }, signal.signal);
					if (result.type !== "export") throw new Error("运行时返回的导出类型无效");
					for (const url of downloads.current) URL.revokeObjectURL(url);
					const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType }));
					downloads.current = [url];
					const link = document.createElement("a");
					link.href = url;
					link.download = result.fileName;
					document.body.append(link);
					link.click();
					link.remove();
					setNotice(`已导出 ${result.fileName}`);
					break;
				}
			}
		} catch (error) {
			setNotice(signal.signal.aborted ? "命令已取消。" : error instanceof Error ? error.message : String(error));
		} finally {
			controller.current = undefined;
			setPending(false);
		}
		return true;
	};
	return { dispatch, notice, pending, dismiss: () => setNotice(undefined), cancel: () => controller.current?.abort() };
}
