import type { KnowledgeDocument, KnowledgeSource } from "@earendil-works/workbench-core/contracts";
import { useRef, useState } from "react";

const representations: Record<string, string> = {
	original_text: "原文",
	ocr: "OCR（模型识别）",
	transcript: "转写（模型识别）",
	model_description: "图像描述（模型生成，未确认）",
	original_image: "原始图片",
};
export function SourceLocator({ source, onLocate }: { source: KnowledgeSource; onLocate?: () => void }) {
	return (
		<button type="button" className="perception-source" onClick={onLocate} disabled={!onLocate}>
			{source.representation === "model_description" && source.reviewedAt
				? "图像描述（模型生成，用户已核对）"
				: representations[source.representation ?? "original_text"]}
			{source.page ? ` · 第 ${source.page} 页` : ""}
			{source.region ? " · 图片区域" : ""}
			{source.beginMs !== undefined
				? ` · ${(source.beginMs / 1000).toFixed(2)}–${((source.endMs ?? source.beginMs) / 1000).toFixed(2)} 秒`
				: ""}
		</button>
	);
}
export function PerceptionPreview({
	projectId,
	document,
	source,
}: {
	projectId: string;
	document: KnowledgeDocument;
	source?: KnowledgeSource;
}) {
	const audio = useRef<HTMLAudioElement>(null);
	const [pageFailed, setPageFailed] = useState(false);
	const base = `/api/v1/projects/${encodeURIComponent(projectId)}/knowledge/documents/${encodeURIComponent(document.id)}`;
	const image = document.mimeType.startsWith("image/");
	const region = source?.region;
	return (
		<section className="perception-original" aria-label="感知原件定位">
			<small>
				受管理原件 · 内容版本 {document.contentVersion ?? 1} · SHA-256 {document.sha256}
			</small>
			{(image || (source?.kind === "ocr" && source.page)) && !pageFailed && (
				<div className="perception-image">
					<img
						alt={`${document.name}${source?.page ? ` 第 ${source.page} 页` : ""}`}
						src={image ? `${base}/view` : `${base}/page?page=${source!.page}`}
						onError={() => setPageFailed(true)}
					/>
					{region && (
						<span
							role="img"
							aria-label="OCR 文字区域"
							className="perception-region"
							style={{
								left: `${(100 * region.centerX) / region.imageWidth}%`,
								top: `${(100 * region.centerY) / region.imageHeight}%`,
								width: `${(100 * region.width) / region.imageWidth}%`,
								height: `${(100 * region.height) / region.imageHeight}%`,
								transform: `translate(-50%, -50%) rotate(${region.angle}deg)`,
							}}
						/>
					)}
				</div>
			)}
			{pageFailed && <p>此页的图像预览不可用，可打开原始 PDF。</p>}
			{document.mimeType === "application/pdf" && (
				<a href={`${base}/view#page=${source?.page ?? 1}`} target="_blank" rel="noreferrer">
					打开原始 PDF · 第 {source?.page ?? 1} 页
				</a>
			)}
			{document.mimeType.startsWith("audio/") && (
				<>
					<audio
						ref={audio}
						controls
						preload="metadata"
						src={`${base}/view`}
						aria-label={`原始音频 ${document.name}`}
					>
						<track kind="captions" src={`${base}/captions`} srcLang="zh" label="转写字幕" default />
					</audio>
					{source?.beginMs !== undefined && (
						<button
							type="button"
							onClick={() => {
								if (audio.current) {
									audio.current.currentTime = source.beginMs! / 1000;
									void audio.current.play().catch(() => undefined);
								}
							}}
						>
							播放 {(source.beginMs / 1000).toFixed(2)} 秒起的片段
						</button>
					)}
				</>
			)}
			{source && <SourceLocator source={source} />}
		</section>
	);
}
