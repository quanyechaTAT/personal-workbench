import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import { ErrorNotice, LoadingBlock } from "./ui.tsx";

export function ChatFilePreview({
	sessionId,
	path,
	onClose,
}: {
	sessionId: string;
	path: string;
	onClose: () => void;
}) {
	const file = useQuery({
		queryKey: ["chat-file-preview", sessionId, path],
		queryFn: () => api.previewSessionFile(sessionId, path),
		retry: false,
	});
	return (
		<>
			<div className="panel-heading">
				<div>
					<span>会话文件</span>
					<strong>文件预览</strong>
				</div>
				<button type="button" className="icon-button" onClick={onClose} aria-label="关闭文件预览" title="关闭预览">
					×
				</button>
			</div>
			<section className="inspector-scroll chat-file-preview" aria-label="文件预览">
				<p className="preview-file-path" title={path}>
					{file.data?.path ?? path}
				</p>
				{file.isLoading && <LoadingBlock label="正在加载文件" />}
				{file.error && <ErrorNotice error={file.error} />}
				{file.data &&
					(/\.md(?:own)?$/iu.test(file.data.path) ? (
						<Markdown text={file.data.content} />
					) : (
						<pre className="preview-file-text">{file.data.content}</pre>
					))}
			</section>
		</>
	);
}
