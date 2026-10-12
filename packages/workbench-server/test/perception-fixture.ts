import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { KnowledgeDocument, Project } from "@earendil-works/workbench-core";
import { createCanvas } from "@napi-rs/canvas";
import { WebSocketServer } from "ws";
import { createAssistantFixture } from "./assistant-fixture.ts";

export function imageDocument(): Buffer {
	const canvas = createCanvas(400, 180);
	const context = canvas.getContext("2d");
	context.fillStyle = "white";
	context.fillRect(0, 0, 400, 180);
	context.fillStyle = "black";
	context.font = "28px sans-serif";
	context.fillText("项目星辰 Python 3.12", 15, 70);
	return canvas.toBuffer("image/png");
}
export function wavDocument(): Buffer {
	const bytes = Buffer.alloc(44 + 3200);
	bytes.write("RIFF");
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(16000, 24);
	bytes.writeUInt32LE(32000, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36);
	bytes.writeUInt32LE(3200, 40);
	return bytes;
}
export function scannedDocument(): Buffer {
	const canvas = createCanvas(400, 180);
	const context = canvas.getContext("2d");
	context.fillStyle = "white";
	context.fillRect(0, 0, 400, 180);
	context.fillStyle = "black";
	context.font = "28px sans-serif";
	context.fillText("SCANNED Python 3.12", 15, 70);
	const image = canvas.toBuffer("image/jpeg");
	const content = Buffer.from("q 400 0 0 180 0 0 cm /Im1 Do Q");
	const objects = [
		Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
		Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
		Buffer.from(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 180] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
		),
		Buffer.concat([
			Buffer.from(
				`<< /Type /XObject /Subtype /Image /Width 400 /Height 180 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`,
			),
			image,
			Buffer.from("\nendstream"),
		]),
		Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
	];
	let output = Buffer.from("%PDF-1.4\n");
	const offsets: number[] = [];
	for (const [index, value] of objects.entries()) {
		offsets.push(output.length);
		output = Buffer.concat([output, Buffer.from(`${index + 1} 0 obj\n`), value, Buffer.from("\nendobj\n")]);
	}
	const xref = output.length;
	return Buffer.concat([
		output,
		Buffer.from(
			`xref\n0 6\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
		),
	]);
}

/** Real Pi/SQLite/Gateway with deterministic native HTTP and WebSocket protocol servers. */
export async function createPerceptionFixture(staticRoot?: string) {
	const fixture = await createAssistantFixture(staticRoot);
	const counts = { ocr: 0, vision: 0, multimodal: 0, text: 0, asr: 0, audioBytes: 0 };
	let holdOcr = false;
	let holdAsr = false;
	let badDimensions = false;
	let extraSentence = false;
	let prematureAsr = false;
	let ocrError: string | undefined;
	let visionError: string | undefined;
	const service = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const payload = JSON.parse(body) as {
			input?:
				| {
						messages?: Array<{ content: Array<{ image: string }> }>;
						contents?: Array<{ image?: string; text?: string }>;
				  }
				| string[];
			messages?: Array<{ content: unknown[] }>;
		};
		response.setHeader("content-type", "application/json");
		if (request.url === "/ocr") {
			counts.ocr++;
			if (ocrError) {
				response.writeHead(403);
				response.end(JSON.stringify({ code: ocrError, message: "fixture-perception-secret" }));
				return;
			}
			if (holdOcr) return;
			const input = payload.input as { messages: Array<{ content: Array<{ image: string }> }> };
			if (!input.messages[0].content[0].image.startsWith("data:image/png;base64,"))
				throw new Error("Missing image input");
			response.end(
				JSON.stringify({
					output: {
						choices: [
							{
								message: {
									content: [
										{
											ocr_result: {
												words_info: [
													{ text: "项目星辰使用 Python 3.12。", rotate_rect: [180, 60, 330, 50, 0] },
												],
											},
										},
									],
								},
							},
						],
					},
				}),
			);
		} else if (request.url === "/vision") {
			counts.vision++;
			if (visionError) {
				response.writeHead(403);
				response.end(JSON.stringify({ error: { code: visionError, message: "fixture-perception-secret" } }));
				return;
			}
			response.end(
				JSON.stringify({
					choices: [{ finish_reason: "stop", message: { content: "截图显示项目星辰的 Python 3.12 版本说明。" } }],
				}),
			);
		} else if (request.url === "/multimodal") {
			counts.multimodal++;
			response.end(
				JSON.stringify({
					output: {
						embeddings: [
							{ index: 0, type: "fixture", embedding: [1, ...Array<number>(badDimensions ? 766 : 767).fill(0)] },
						],
					},
				}),
			);
		} else {
			counts.text++;
			const input = payload.input as string[];
			response.end(JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 0, 0] })) }));
		}
	});
	const sockets = new WebSocketServer({ server: service, path: "/asr" });
	sockets.on("connection", (socket) => {
		let taskId = "";
		socket.on("message", (data, binary) => {
			if (binary) {
				counts.audioBytes += data.toString().length;
				return;
			}
			const message = JSON.parse(data.toString()) as { header: { action: string; task_id: string } };
			taskId = message.header.task_id;
			if (message.header.action === "run-task") {
				counts.asr++;
				if (prematureAsr) {
					socket.send(JSON.stringify({ header: { task_id: taskId, event: "task-finished" } }));
					return;
				}
				socket.send(JSON.stringify({ header: { task_id: taskId, event: "task-started" } }));
			}
			if (message.header.action === "finish-task" && !holdAsr) {
				const sentence = {
					sentence_id: 1,
					begin_time: 120,
					end_time: 880,
					text: "录音确认星辰项目迁移到 Python 3.12。",
					sentence_end: true,
				};
				socket.send(
					JSON.stringify({
						header: { task_id: taskId, event: "result-generated" },
						payload: { output: { sentence: { ...sentence, sentence_end: false, text: "临时草稿" } } },
					}),
				);
				for (let repeat = 0; repeat < 2; repeat++)
					socket.send(
						JSON.stringify({
							header: { task_id: taskId, event: "result-generated" },
							payload: { output: { sentence } },
						}),
					);
				if (extraSentence)
					socket.send(
						JSON.stringify({
							header: { task_id: taskId, event: "result-generated" },
							payload: {
								output: {
									sentence: {
										...sentence,
										sentence_id: 2,
										begin_time: 900,
										end_time: 1600,
										text: "尚未验证 OCR 权限。",
									},
								},
							},
						}),
					);
				socket.send(JSON.stringify({ header: { task_id: taskId, event: "task-finished" } }));
			}
		});
	});
	await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
	const address = service.address();
	if (!address || typeof address === "string") throw new Error("No perception test port");
	const origin = `http://127.0.0.1:${address.port}`;
	const environment = `EMBED_API_KEY=fixture-perception-secret\nEMBED_BASE_URL=${origin}/v1\nEMBED_MODEL_NAME=perception-text\nEMBED_TOKENIZER=cl100k_base\nEMBED_TOKENIZER_MODEL=perception-text\nMEMORY_OCR_ENDPOINT=${origin}/ocr\nMEMORY_ASR_ENDPOINT=ws://127.0.0.1:${address.port}/asr\nMEMORY_VISION_ENDPOINT=${origin}/vision\nMEMORY_MULTIMODAL_ENDPOINT=${origin}/multimodal\n`;
	await writeFile(fixture.embeddingEnvFile, environment);
	return {
		fixture,
		counts,
		environment,
		setHoldOcr(value: boolean) {
			holdOcr = value;
		},
		setHoldAsr(value: boolean) {
			holdAsr = value;
		},
		setBadDimensions(value: boolean) {
			badDimensions = value;
		},
		setExtraSentence(value: boolean) {
			extraSentence = value;
		},
		setPrematureAsr(value: boolean) {
			prematureAsr = value;
		},
		setProviderErrors(ocr?: string, vision?: string) {
			ocrError = ocr;
			visionError = vision;
		},
		async project(name: string): Promise<Project> {
			const sourcePath = join(fixture.root, name);
			await mkdir(sourcePath);
			return fixture.application.createProject({ sourcePath });
		},
		async wait(project: Project, id: string): Promise<KnowledgeDocument> {
			for (let attempt = 0; attempt < 400; attempt++) {
				const document = (await fixture.application.services.knowledge.listDocuments(project)).find(
					(value) => value.id === id,
				);
				if (document && (document.status === "ready" || document.status === "failed")) return document;
				await new Promise<void>((resolve) => setTimeout(resolve, 25));
			}
			throw new Error("Perception job did not settle");
		},
		async close() {
			await fixture.close();
			for (const socket of sockets.clients) socket.terminate();
			await new Promise<void>((resolve) => sockets.close(() => resolve()));
			service.closeAllConnections();
			await new Promise<void>((resolve) => service.close(() => resolve()));
		},
	};
}
