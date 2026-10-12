import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { KnowledgeSource } from "@earendil-works/workbench-core";
import { WorkbenchError } from "@earendil-works/workbench-core";
import WebSocket from "ws";
import { assembleMarkdown } from "./knowledge-markdown.ts";
import { PerceptionConfiguration, type PerceptionEndpoint } from "./perception-config.ts";

export interface PerceptionImage {
	dataUrl: string;
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
	page?: number;
}
export interface PerceptionOutput {
	text: string;
	sources: KnowledgeSource[];
	diagnostics: string[];
}
export interface AudioFormat {
	format: "wav" | "mp3";
	sampleRate: number;
	bytesPerSecond: number;
}
/** Provider-specific protocols stay behind this replaceable adapter. Audio uses transcription, not vectors. */
export interface PerceptionAdapter {
	configuration: PerceptionConfiguration;
	ocr(image: PerceptionImage, endpoint: PerceptionEndpoint, signal: AbortSignal): Promise<PerceptionOutput>;
	describe(image: PerceptionImage, endpoint: PerceptionEndpoint, signal: AbortSignal): Promise<PerceptionOutput>;
	transcribe(
		bytes: Buffer,
		format: AudioFormat,
		endpoint: PerceptionEndpoint,
		signal: AbortSignal,
	): Promise<PerceptionOutput>;
	embed(
		input: { text: string } | { image: string },
		endpoint: PerceptionEndpoint,
		signal: AbortSignal,
	): Promise<number[]>;
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function entries(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Provider messages may echo requests or secrets. Publish only recognized codes and local guidance. */
function providerFailure(endpoint: PerceptionEndpoint, status: number | undefined, value: unknown): WorkbenchError {
	const reply = object(value);
	const error = object(reply?.error) ?? object(reply?.header) ?? reply;
	const raw = error?.code ?? error?.error_code;
	const code =
		typeof raw === "string" &&
		/^(?:AccessDenied(?:\.[A-Za-z0-9_-]+)*|AllocationQuota(?:\.[A-Za-z0-9_-]+)*|InvalidApiKey|invalid_api_key|ModelNotFound|model_not_found|InvalidParameter(?:\.[A-Za-z0-9_-]+)*|Throttling(?:\.[A-Za-z0-9_-]+)*|access_denied|insufficient_quota)$/u.test(
			raw,
		) &&
		!raw.includes(endpoint.apiKey)
			? raw
			: undefined;
	const guidance =
		code === "AllocationQuota.FreeTierOnly"
			? "该模型免费额度已用完且开启用完即停；请在百炼控制台核对额度，或明确配置已有额度的模型。工作台不会自动关闭额度保护"
			: code?.startsWith("AccessDenied") || code === "access_denied"
				? "请核对该地域／业务空间的模型授权与服务开通状态；Embedding 可用不代表该感知模型有权限"
				: code === "InvalidApiKey" || code === "invalid_api_key" || status === 401
					? "请核对此能力的 API Key 与 Endpoint 是否属于同一地域／业务空间"
					: code === "ModelNotFound" || code === "model_not_found"
						? "该模型在当前地域／业务空间不可用，请核对模型 ID 与 API 协议"
						: "请核对模型权限、额度、地域／业务空间和 API 协议";
	const model =
		/^[a-zA-Z0-9_.-]{1,100}$/u.test(endpoint.model) && !endpoint.model.includes(endpoint.apiKey)
			? endpoint.model
			: "已配置模型";
	return new WorkbenchError(
		"external_failure",
		`感知模型 ${model}${status ? ` 返回 HTTP ${status}` : "任务失败"}${code ? `（${code}）` : ""}：${guidance}`,
	);
}

export function validateAudio(bytes: Buffer, name: string): AudioFormat {
	const invalid = () =>
		new WorkbenchError(
			"invalid_input",
			"音频首版支持单声道 16-bit PCM WAV（16 kHz）或单声道 MP3；其他格式需先转换，当前未配置转换能力",
		);
	if (/\.wav$/iu.test(name)) {
		if (
			bytes.length < 44 ||
			bytes.toString("ascii", 0, 4) !== "RIFF" ||
			bytes.toString("ascii", 8, 12) !== "WAVE" ||
			bytes.readUInt32LE(4) !== bytes.length - 8
		)
			throw invalid();
		let format: AudioFormat | undefined;
		let data = false;
		for (let offset = 12; offset + 8 <= bytes.length; ) {
			const size = bytes.readUInt32LE(offset + 4);
			const start = offset + 8;
			if (size > bytes.length - start) throw invalid();
			const kind = bytes.toString("ascii", offset, offset + 4);
			if (kind === "fmt ") {
				if (
					size < 16 ||
					bytes.readUInt16LE(start) !== 1 ||
					bytes.readUInt16LE(start + 2) !== 1 ||
					bytes.readUInt32LE(start + 4) !== 16000 ||
					bytes.readUInt32LE(start + 8) !== 32000 ||
					bytes.readUInt16LE(start + 12) !== 2 ||
					bytes.readUInt16LE(start + 14) !== 16
				)
					throw invalid();
				format = { format: "wav", sampleRate: 16000, bytesPerSecond: 32000 };
			}
			if (kind === "data" && size > 0 && size % 2 === 0) data = true;
			offset = start + size + (size % 2);
		}
		if (!format || !data) throw invalid();
		return format;
	}
	if (/\.mp3$/iu.test(name)) {
		let offset = 0;
		if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "ID3") {
			if ([...bytes.subarray(6, 10)].some((value) => value > 127)) throw invalid();
			offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
		}
		let format: AudioFormat | undefined;
		while (offset < bytes.length) {
			if (offset + 128 === bytes.length && bytes.toString("ascii", offset, offset + 3) === "TAG") break;
			if (offset + 4 > bytes.length) throw invalid();
			const header = bytes.readUInt32BE(offset);
			const version = (header >>> 19) & 3;
			const rate = (header >>> 10) & 3;
			const bitrate = (header >>> 12) & 15;
			if (
				header >>> 21 !== 0x7ff ||
				((header >>> 17) & 3) !== 1 ||
				version === 1 ||
				rate === 3 ||
				bitrate === 0 ||
				bitrate === 15 ||
				((header >>> 6) & 3) !== 3
			)
				throw invalid();
			const sampleRate = [44100, 48000, 32000][rate] / (version === 3 ? 1 : version === 2 ? 2 : 4);
			const rates =
				version === 3
					? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
					: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
			const frameSize =
				Math.floor(((version === 3 ? 144000 : 72000) * rates[bitrate]) / sampleRate) + ((header >>> 9) & 1);
			if (frameSize < 4 || frameSize > bytes.length - offset || (format && format.sampleRate !== sampleRate))
				throw invalid();
			format ??= { format: "mp3", sampleRate, bytesPerSecond: rates[bitrate] * 125 };
			offset += frameSize;
		}
		if (!format) throw invalid();
		return format;
	}
	throw invalid();
}

export class BailianPerceptionAdapter implements PerceptionAdapter {
	readonly configuration: PerceptionConfiguration;
	private readonly fetcher: typeof fetch;
	constructor(envFile?: string, fetcher: typeof fetch = fetch) {
		this.configuration = new PerceptionConfiguration(envFile);
		this.fetcher = fetcher;
	}
	private async post(
		endpoint: PerceptionEndpoint,
		payload: unknown,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const combined = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
		try {
			const response = await this.fetcher(endpoint.url, {
				method: "POST",
				redirect: "error",
				headers: { authorization: `Bearer ${endpoint.apiKey}`, "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: combined,
			});
			if (!response.body) throw new WorkbenchError("external_failure", "感知服务没有返回正文");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.length;
					if (size > (response.ok ? 16 * 1024 * 1024 : 8192))
						throw new WorkbenchError("external_failure", "感知服务响应超过 16 MiB 上限");
					chunks.push(chunk.value);
				}
			} finally {
				await reader.cancel().catch(() => undefined);
			}
			let value: Record<string, unknown> | undefined;
			try {
				value = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				if (!response.ok) throw providerFailure(endpoint, response.status, undefined);
				throw new WorkbenchError("external_failure", "感知服务返回无效 JSON 协议，未发布结果");
			}
			if (!response.ok || value?.code || value?.error) throw providerFailure(endpoint, response.status, value);
			if (!value || value.code)
				throw new WorkbenchError("external_failure", "感知服务返回错误或无效协议，未发布结果");
			return value;
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof WorkbenchError) throw error;
			throw new WorkbenchError(
				"external_failure",
				combined.aborted ? "感知服务请求超时" : "感知服务请求或响应解析失败",
			);
		}
	}
	async ocr(image: PerceptionImage, endpoint: PerceptionEndpoint, signal: AbortSignal): Promise<PerceptionOutput> {
		const reply = await this.post(
			endpoint,
			{
				model: endpoint.model,
				input: { messages: [{ role: "user", content: [{ image: image.dataUrl, enable_rotate: false }] }] },
				parameters: { ocr_options: { task: "advanced_recognition" } },
			},
			signal,
		);
		const output = object(reply.output);
		const choices = entries(output?.choices);
		const sections: Array<{ text: string; source: Omit<KnowledgeSource, "markdownStart" | "markdownEnd"> }> = [];
		let absentRegions = false;
		for (const choice of choices) {
			const row = object(choice);
			if (row?.finish_reason === "length")
				throw new WorkbenchError("external_failure", "OCR 响应被截断，未发布结果");
			for (const part of entries(object(row?.message)?.content)) {
				const content = object(part);
				const words = entries(object(content?.ocr_result)?.words_info);
				for (const word of words) {
					const value = object(word);
					if (typeof value?.text !== "string" || !value.text.trim()) continue;
					const rect = entries(value.rotate_rect);
					const region =
						rect.length === 5 &&
						rect.every((entry) => typeof entry === "number" && Number.isFinite(entry)) &&
						Number(rect[2]) > 0 &&
						Number(rect[3]) > 0
							? {
									centerX: (Number(rect[0]) * image.originalWidth) / image.width,
									centerY: (Number(rect[1]) * image.originalHeight) / image.height,
									width: (Number(rect[2]) * image.originalWidth) / image.width,
									height: (Number(rect[3]) * image.originalHeight) / image.height,
									angle: Number(rect[4]),
									imageWidth: image.originalWidth,
									imageHeight: image.originalHeight,
								}
							: undefined;
					absentRegions ||= !region;
					sections.push({
						text: value.text,
						source: {
							kind: "ocr",
							representation: "ocr",
							origin: "model",
							modelFingerprint: endpoint.fingerprint,
							page: image.page,
							region,
						},
					});
				}
				if (!words.length && typeof content?.text === "string" && content.text.trim()) {
					absentRegions = true;
					sections.push({
						text: content.text,
						source: {
							kind: "ocr",
							representation: "ocr",
							origin: "model",
							modelFingerprint: endpoint.fingerprint,
							page: image.page,
						},
					});
				}
			}
		}
		const assembled = assembleMarkdown(sections);
		if (!assembled.markdown.trim()) throw new WorkbenchError("external_failure", "OCR 未返回可识别文字，原件已保留");
		return {
			text: assembled.markdown,
			sources: assembled.sources,
			diagnostics: absentRegions ? ["OCR 部分文字没有区域坐标，仅可定位到原件或页码。"] : [],
		};
	}
	async describe(
		image: PerceptionImage,
		endpoint: PerceptionEndpoint,
		signal: AbortSignal,
	): Promise<PerceptionOutput> {
		const reply = await this.post(
			endpoint,
			{
				model: endpoint.model,
				messages: [
					{
						role: "user",
						content: [
							{ type: "image_url", image_url: { url: image.dataUrl } },
							{
								type: "text",
								text: "请用中文简要描述图片中可见的信息。区分可见内容与无法确定的内容，不推断人物身份或补造事实。",
							},
						],
					},
				],
				max_tokens: 1000,
				...(!/thinking/iu.test(endpoint.model) && /^qwen(?:3(?:\.[5-8])?|3-vl)-/u.test(endpoint.model)
					? { enable_thinking: false }
					: {}),
			},
			signal,
		);
		const choice = object(entries(reply.choices)[0]);
		const text = object(choice?.message)?.content;
		if (choice?.finish_reason === "length")
			throw new WorkbenchError("external_failure", "图像描述被截断，未发布结果");
		if (typeof text !== "string" || !text.trim())
			throw new WorkbenchError("external_failure", "视觉服务未返回图像描述");
		return {
			text,
			sources: [
				{
					kind: "description",
					representation: "model_description",
					origin: "model",
					modelFingerprint: endpoint.fingerprint,
					page: image.page,
					markdownStart: 0,
					markdownEnd: text.length,
				},
			],
			diagnostics: ["图像描述由模型生成，尚未经用户确认。"],
		};
	}
	async embed(
		input: { text: string } | { image: string },
		endpoint: PerceptionEndpoint,
		signal: AbortSignal,
	): Promise<number[]> {
		const reply = await this.post(endpoint, { model: endpoint.model, input: { contents: [input] } }, signal);
		const result = object(entries(object(reply.output)?.embeddings)[0]);
		const vector = entries(result?.embedding);
		if (vector.length !== 768 || !vector.every((value) => typeof value === "number" && Number.isFinite(value)))
			throw new WorkbenchError("external_failure", "图文 Embedding 返回维度或向量无效；该模型空间要求 768 维");
		return vector as number[];
	}
	async transcribe(
		bytes: Buffer,
		format: AudioFormat,
		endpoint: PerceptionEndpoint,
		signal: AbortSignal,
	): Promise<PerceptionOutput> {
		const combined = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
		combined.throwIfAborted();
		const taskId = randomUUID().replaceAll("-", "");
		const socket = new WebSocket(endpoint.url, {
			headers: { authorization: `Bearer ${endpoint.apiKey}` },
			maxPayload: 4 * 1024 * 1024,
			handshakeTimeout: 15_000,
			followRedirects: false,
		});
		const sentences = new Map<string, { text: string; beginMs: number; endMs: number; speaker?: string }>();
		let sending: Promise<void> | undefined;
		let started = false;
		let finishedSending = false;
		let settled = false;
		let textSize = 0;
		try {
			await new Promise<void>((resolve, reject) => {
				const aborted = () =>
					done(new WorkbenchError("external_failure", signal.aborted ? "音频转写已取消" : "音频转写超时"));
				combined.addEventListener("abort", aborted, { once: true });
				const done = (error?: WorkbenchError) => {
					if (settled) return;
					settled = true;
					combined.removeEventListener("abort", aborted);
					if (error) reject(error);
					else resolve();
				};
				socket.once("open", () =>
					socket.send(
						JSON.stringify({
							header: { action: "run-task", task_id: taskId, streaming: "duplex" },
							payload: {
								task_group: "audio",
								task: "asr",
								function: "recognition",
								model: endpoint.model,
								parameters: { format: format.format, sample_rate: format.sampleRate },
								input: {},
							},
						}),
					),
				);
				socket.on("message", (data, binary) => {
					if (settled) return;
					try {
						if (binary) throw new Error("unexpected binary");
						const event = object(JSON.parse(data.toString()));
						const header = object(event?.header);
						if (header?.task_id !== taskId) throw new Error("wrong task");
						if (header.event === "task-started" && !started) {
							started = true;
							sending = (async () => {
								for (let offset = 0; offset < bytes.length; offset += 8192) {
									combined.throwIfAborted();
									if (settled) return;
									await new Promise<void>((sent, failed) =>
										socket.send(bytes.subarray(offset, offset + 8192), { binary: true }, (error) =>
											error ? failed(error) : sent(),
										),
									);
									await delay(
										Math.min(100, Math.max(1, Math.floor((8192 / format.bytesPerSecond) * 1000))),
										undefined,
										{ signal: combined },
									);
								}
								if (settled) return;
								finishedSending = true;
								socket.send(
									JSON.stringify({
										header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
										payload: { input: {} },
									}),
								);
							})().catch(() =>
								done(new WorkbenchError("external_failure", "音频流发送失败或被中断，请重试整个文件")),
							);
						} else if (header.event === "result-generated") {
							if (!started) throw new Error("result before task start");
							const sentence = object(object(object(event?.payload)?.output)?.sentence);
							if (!sentence?.sentence_end) return;
							if (
								typeof sentence.text !== "string" ||
								typeof sentence.begin_time !== "number" ||
								typeof sentence.end_time !== "number" ||
								!Number.isFinite(sentence.begin_time) ||
								!Number.isFinite(sentence.end_time) ||
								sentence.begin_time < 0 ||
								sentence.end_time < sentence.begin_time ||
								(typeof sentence.sentence_id !== "number" && typeof sentence.sentence_id !== "string")
							)
								throw new Error("invalid sentence");
							const id = String(sentence.sentence_id);
							textSize += sentence.text.length - (sentences.get(id)?.text.length ?? 0);
							if (textSize > 4_000_000 || (!sentences.has(id) && sentences.size >= 20000))
								throw new Error("transcript exceeds limit");
							sentences.set(id, {
								text: sentence.text,
								beginMs: sentence.begin_time,
								endMs: sentence.end_time,
								speaker:
									typeof sentence.speaker_id === "string" || typeof sentence.speaker_id === "number"
										? String(sentence.speaker_id)
										: undefined,
							});
						} else if (header.event === "task-finished") {
							if (!finishedSending) throw new Error("premature task completion");
							done();
						} else if (header.event === "task-failed") done(providerFailure(endpoint, undefined, event));
					} catch {
						done(new WorkbenchError("external_failure", "ASR 返回无效协议，未发布转写"));
					}
				});
				socket.once("error", () => done(new WorkbenchError("external_failure", "ASR 连接失败，请检查配置或权限")));
				socket.once("close", () => done(new WorkbenchError("external_failure", "ASR 连接中断，请重试整个文件")));
			});
			await sending;
			signal.throwIfAborted();
			const sections = [...sentences.values()]
				.sort((a, b) => a.beginMs - b.beginMs)
				.map((sentence) => ({
					text: sentence.text,
					source: {
						kind: "transcript" as const,
						representation: "transcript" as const,
						origin: "model" as const,
						modelFingerprint: endpoint.fingerprint,
						beginMs: sentence.beginMs,
						endMs: sentence.endMs,
						speaker: sentence.speaker,
					},
				}));
			const assembled = assembleMarkdown(sections);
			if (!assembled.markdown.trim())
				throw new WorkbenchError("external_failure", "ASR 未返回最终句段或可识别语音，原件已保留");
			return {
				text: assembled.markdown,
				sources: assembled.sources,
				diagnostics: ["转写由 ASR 生成；仅保留最终句段和供应商实际返回的时间，不推断说话人身份。"],
			};
		} finally {
			socket.terminate();
			await sending?.catch(() => undefined);
		}
	}
}
