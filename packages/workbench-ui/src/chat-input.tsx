import { type RefObject, useEffect, useRef, useState } from "react";
import type { ChatCapability, RuntimeSlashCommand } from "./api.ts";
import { label } from "./labels.ts";

export function slashToken(text: string, caret: number): { start: number; end: number; query: string } | undefined {
	const prefix = text.slice(0, caret);
	const match = /(?:^|\s)\/([\p{L}\p{N}_:.-]*)$/u.exec(prefix);
	if (!match) return undefined;
	return { start: caret - match[1].length - 1, end: caret, query: match[1].toLowerCase() };
}

export function fileToken(text: string, caret: number): { start: number; end: number; query: string } | undefined {
	const match = /(?:^|\s)@([^\s@]*)$/u.exec(text.slice(0, caret));
	if (!match) return undefined;
	return { start: caret - match[1].length - 1, end: caret, query: match[1] };
}

export function ChatInput({
	value,
	onChange,
	inputRef,
	items,
	loading,
	error,
	disabled,
	placeholder,
	onSelect,
	commands = [],
	onFiles,
	fileInputRef,
}: {
	value: string;
	onChange(value: string): void;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	items: ChatCapability[];
	loading: boolean;
	error?: string;
	disabled: boolean;
	placeholder: string;
	onSelect(item: ChatCapability): void;
	commands?: RuntimeSlashCommand[];
	onFiles?(files: File[]): void;
	fileInputRef?: RefObject<HTMLInputElement | null>;
}) {
	const [caret, setCaret] = useState(value.length);
	const [dismissed, setDismissed] = useState<string>();
	const [highlight, setHighlight] = useState(0);
	const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const ownFileInput = useRef<HTMLInputElement>(null);
	const attachmentInput = fileInputRef ?? ownFileInput;
	const file = onFiles ? fileToken(value, Math.min(caret, value.length)) : undefined;
	const fileKey = file ? `file:${file.start}:${file.query}` : undefined;
	const fileOpen = Boolean(file && fileKey !== dismissed && !disabled);
	const token = slashToken(value, Math.min(caret, value.length));
	const tokenKey = token ? `${token.start}:${token.query}` : undefined;
	const open = Boolean(token && tokenKey !== dismissed && !disabled);
	const query = token?.query ?? "";
	const search = query.startsWith("skill:") ? query.slice("skill:".length) : query;
	const skills = items.filter((item) =>
		`${item.name} ${item.id} ${label(item.label)} ${label(item.description)} 技能 skill`
			.toLowerCase()
			.includes(search),
	);
	const builtins =
		token?.start === 0 && !query.startsWith("skill:")
			? commands.filter((command) => `${command.name} ${command.description} Pi 命令`.toLowerCase().includes(search))
			: [];
	const matches: Array<{ kind: "command"; command: RuntimeSlashCommand } | { kind: "skill"; item: ChatCapability }> = [
		...builtins.map((command) => ({ kind: "command" as const, command })),
		...skills.map((item) => ({ kind: "skill" as const, item })),
	];
	const index = Math.min(highlight, Math.max(0, matches.length - 1));
	useEffect(() => {
		if (open) void optionRefs.current[index]?.scrollIntoView({ block: "nearest" });
	}, [open, index]);
	const pick = (option: (typeof matches)[number]) => {
		if (!token) return;
		const insertion = option.kind === "command" ? `/${option.command.name} ` : "";
		if (option.kind === "skill") onSelect(option.item);
		onChange(value.slice(0, token.start) + insertion + value.slice(token.end));
		setDismissed(tokenKey);
		const position = token.start + insertion.length;
		setCaret(position);
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(position, position);
		});
	};
	const pickFile = () => {
		if (!file) return;
		onChange(value.slice(0, file.start) + value.slice(file.end));
		setCaret(file.start);
		setDismissed(fileKey);
		attachmentInput.current?.click();
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(file.start, file.start);
		});
	};
	return (
		<div className="chat-input-field">
			{onFiles && (
				<input
					ref={attachmentInput}
					type="file"
					multiple
					hidden
					aria-label="上传聊天附件"
					disabled={disabled}
					onChange={(event) => {
						const files = Array.from(event.currentTarget.files ?? []);
						event.currentTarget.value = "";
						if (files.length) onFiles(files);
						inputRef.current?.focus();
					}}
				/>
			)}
			{fileOpen && (
				<div className="slash-popup file-upload-popup">
					<div className="slash-heading">
						添加本轮附件 <small>回车选择 · Esc 关闭</small>
					</div>
					<div role="listbox" aria-label="文件上传" id="chat-file-upload" className="slash-options">
						<button
							type="button"
							role="option"
							aria-selected
							id="chat-file-upload-option"
							tabIndex={-1}
							onMouseDown={(event) => event.preventDefault()}
							onClick={pickFile}
						>
							<span>
								<strong>上传文件…</strong>
								<small>从电脑选择图片、文档或其他文件，可多选</small>
							</span>
						</button>
					</div>
					<p className="slash-note">附件随消息发送 · 图片可直接 Ctrl+V 粘贴</p>
				</div>
			)}
			{open && (
				<div className="slash-popup">
					<div className="slash-heading">
						命令与技能 <small>↑↓ 选择 · 回车确认 · Esc 关闭</small>
					</div>
					{loading && <p className="quiet-copy">正在加载可用技能…</p>}
					{error && <p className="error-notice">{error}</p>}
					<div role="listbox" aria-label="命令与技能" id="chat-capabilities" className="slash-options">
						{matches.map((option, itemIndex) => (
							<button
								type="button"
								role="option"
								tabIndex={-1}
								aria-selected={index === itemIndex}
								id={`chat-capability-${itemIndex}`}
								key={option.kind === "command" ? `command:${option.command.name}` : `skill:${option.item.id}`}
								ref={(element) => {
									optionRefs.current[itemIndex] = element;
								}}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => pick(option)}
							>
								<span>
									<strong>
										{option.kind === "command" ? `/${option.command.name}` : label(option.item.label)}
									</strong>
									<small>
										{option.kind === "command"
											? `Pi 命令${option.command.action === "unsupported" ? " · 仅 CLI" : ""}${option.command.argumentHint ? ` · ${option.command.argumentHint}` : ""}`
											: `技能 · ${option.item.name}`}
									</small>
								</span>
								<small>
									{option.kind === "command" ? option.command.description : label(option.item.description)}
								</small>
							</button>
						))}
						{!loading && !error && !matches.length && (
							<p className="quiet-copy">
								没有匹配的命令或技能。请在技能页导入或启用技能；项目技能仅在对应项目中可用。
							</p>
						)}
					</div>
					<p className="slash-note">命令在行首执行；技能用于本轮。工具由模型自动调用。</p>
				</div>
			)}
			<textarea
				ref={inputRef}
				aria-label="消息输入"
				aria-controls={fileOpen ? "chat-file-upload" : open ? "chat-capabilities" : undefined}
				aria-activedescendant={
					fileOpen ? "chat-file-upload-option" : open && matches.length ? `chat-capability-${index}` : undefined
				}
				value={value}
				disabled={disabled}
				rows={1}
				placeholder={placeholder}
				onChange={(event) => {
					setHighlight(0);
					onChange(event.target.value);
					setCaret(event.target.selectionStart);
					setDismissed(undefined);
				}}
				onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
				onPaste={(event) => {
					if (!onFiles || disabled) return;
					const files = Array.from(event.clipboardData.files);
					if (!files.length) return;
					event.preventDefault();
					onFiles(files);
					const text = event.clipboardData.getData("text/plain");
					if (text) {
						const start = event.currentTarget.selectionStart;
						onChange(value.slice(0, start) + text + value.slice(event.currentTarget.selectionEnd));
						setCaret(start + text.length);
					}
				}}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.keyCode === 229) return;
					if (
						fileOpen &&
						["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"].includes(event.key) &&
						!event.shiftKey
					) {
						event.preventDefault();
						if (event.key === "Escape") setDismissed(fileKey);
						else if (event.key === "Enter" || event.key === "Tab") pickFile();
						return;
					}
					if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
						event.preventDefault();
						setHighlight(
							(index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % Math.max(matches.length, 1),
						);
						return;
					}
					if (open && event.key === "Escape") {
						event.preventDefault();
						setDismissed(tokenKey);
						return;
					}
					if (open && matches[index] && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
						event.preventDefault();
						pick(matches[index]);
						return;
					}
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						event.currentTarget.form?.requestSubmit();
					}
				}}
			/>
		</div>
	);
}
