import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { ChatAttachment } from "@earendil-works/workbench-core/contracts";
import { createCanvas } from "@napi-rs/canvas";
import { expect, test } from "vitest";
import { ChatAttachmentService } from "../src/chat-attachment-service.ts";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { docxDocument, pdfDocument } from "./fixtures/knowledge-documents.ts";

type Fixture = Awaited<ReturnType<typeof createAssistantFixture>>;
async function upload(fixture: Fixture, sessionId: string, name: string, bytes: Buffer) {
	const response = await fixture.request(`/sessions/${sessionId}/attachments?name=${encodeURIComponent(name)}`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: new Uint8Array(bytes),
	});
	expect(response.status, await response.clone().text()).toBe(201);
	return (await response.json()) as ChatAttachment;
}
async function send(fixture: Fixture, sessionId: string, text: string, attachments: ChatAttachment[]) {
	const response = await fixture.request(`/sessions/${sessionId}/messages`, {
		method: "POST",
		body: JSON.stringify({ text, attachmentIds: attachments.map((item) => item.id) }),
	});
	expect(response.status, await response.clone().text()).toBe(202);
	const run = (await response.json()) as { runId: string };
	expect(await (await fixture.request(`/runs/${run.runId}/events`)).text()).toContain('"type":"run.completed"');
}

test("chat images and document text reach real Pi, persist in the same JSONL, and resume without Knowledge ingestion", async () => {
	const fixture = await createAssistantFixture(undefined, { modelInput: ["text", "image"] });
	try {
		const project = await fixture.application.createProject({ name: "聊天附件 中文 空格" });
		const session = await fixture.application.createSession({ projectId: project.id, profileSlug: "standard" });
		const canvas = createCanvas(48, 32);
		canvas.getContext("2d").fillRect(0, 0, 20, 20);
		const image = await upload(fixture, session.id, "剪贴板 图片.png", canvas.toBuffer("image/png"));
		const text = await upload(fixture, session.id, "说明 中文.txt", Buffer.from("验收编号 CHAT-728，库存是 17。"));
		let observed = false;
		fixture.faux.setResponses([
			(context) => {
				const user = [...context.messages].reverse().find((message) => message.role === "user");
				expect(user?.role).toBe("user");
				if (user?.role !== "user" || typeof user.content === "string") throw new Error("Image prompt missing");
				expect(user.content).toContainEqual(
					expect.objectContaining({ type: "image", mimeType: "image/png", data: expect.any(String) }),
				);
				expect(JSON.stringify(user.content)).toContain("CHAT-728");
				expect(context.systemPrompt).not.toContain("CHAT-728");
				observed = true;
				return fauxAssistantMessage("收到图片和库存 17。");
			},
		]);
		await send(fixture, session.id, "读取本轮附件，不调用工具。", [image, text]);
		expect(observed).toBe(true);
		const history = await fixture.application.services.sessions.readTranscript(session.id);
		const user = history.find((message) => message.role === "user")!;
		expect(
			user.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		).toBe("读取本轮附件，不调用工具。");
		expect(user.attachments?.map((item) => item.name)).toEqual([image.name, text.name]);
		expect(user.content.some((part) => part.type === "image")).toBe(true);
		expect(await fixture.application.services.knowledge.listDocuments(project)).toEqual([]);
		expect(await readFile(session.runtimeRef, "utf8")).toContain("workbench.chat-attachments.v1");
		await fixture.restart();
		const resumed = await fixture.application.services.sessions.readTranscript(session.id);
		expect(resumed[0]?.attachments).toEqual(user.attachments);
		expect(resumed[0]?.content).toEqual(user.content);
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
			session.runtimeSessionId,
		);
		const downloaded = await fixture.request(`/sessions/${session.id}/attachments/${text.id}/file`);
		expect(downloaded.headers.get("content-disposition")).toContain(encodeURIComponent(text.name));
		expect(await downloaded.text()).toBe("验收编号 CHAT-728，库存是 17。");
		const logs = JSON.stringify(await fixture.application.logger.readRecent(500));
		expect(logs).not.toContain("CHAT-728");
		fixture.faux.setResponses([fauxAssistantMessage("普通文本消息。")]);
		await send(fixture, session.id, "这一轮没有附件", []);
		const users = (await fixture.application.services.sessions.readTranscript(session.id)).filter(
			(message) => message.role === "user",
		);
		expect(users[1]?.attachments ?? []).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("image-only messages work; text-only models reject images before starting a run", async () => {
	for (const vision of [false, true]) {
		const fixture = await createAssistantFixture(undefined, { modelInput: vision ? ["text", "image"] : ["text"] });
		try {
			const session = await fixture.application.createSession({});
			const image = await upload(fixture, session.id, "image.png", createCanvas(8, 8).toBuffer("image/png"));
			if (vision) {
				fixture.faux.setResponses([fauxAssistantMessage("图片输入已收到。")]);
				await send(fixture, session.id, "", [image]);
			} else {
				const response = await fixture.request(`/sessions/${session.id}/messages`, {
					method: "POST",
					body: JSON.stringify({ text: "", attachmentIds: [image.id] }),
				});
				expect(response.status).toBe(400);
				expect(await response.text()).toContain("图片输入");
				expect(await fixture.application.services.sessions.readTranscript(session.id)).toEqual([]);
			}
		} finally {
			await fixture.close();
		}
	}
});

test("attachments are scoped to their session and all upload/download routes require Gateway authorization", async () => {
	const fixture = await createAssistantFixture();
	try {
		const a = await fixture.application.createSession({});
		const b = await fixture.application.createSession({});
		const file = await upload(fixture, a.id, "会话甲.txt", Buffer.from("只属于甲"));
		for (const path of [`/sessions/${b.id}/attachments/${file.id}/file`, `/sessions/${b.id}/messages`]) {
			const response = await fixture.request(
				path,
				path.endsWith("messages")
					? { method: "POST", body: JSON.stringify({ text: "读附件", attachmentIds: [file.id] }) }
					: undefined,
			);
			expect(response.status).toBe(404);
		}
		expect(await fixture.application.services.sessions.readTranscript(b.id)).toEqual([]);
		expect(await readdir(join(fixture.application.paths.inbox, "chat-attachments"))).toEqual([a.id]);
		const denied = await fetch(`${fixture.address.origin}/api/v1/sessions/${a.id}/attachments/${file.id}/file`);
		expect(denied.status).toBe(403);
		const foreign = await fixture.request(`/sessions/${a.id}/attachments?name=x.txt`, {
			method: "POST",
			headers: { origin: "https://example.com" },
			body: "sensitive",
		});
		expect(foreign.status).toBe(403);
	} finally {
		await fixture.close();
	}
});

test("PDF and Word parse locally; long, scanned and binary inputs describe their limits honestly", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "minimal" });
		const word = await upload(fixture, session.id, "中文 Word.docx", await docxDocument("WORD-823 中文数量 31"));
		const pdf = await upload(fixture, session.id, "Page report.pdf", pdfDocument(["PDF-651 count 9"]));
		const long = await upload(fixture, session.id, "长正文.txt", Buffer.from("正文".repeat(20_000)));
		expect(long.truncated).toBe(true);
		expect(long.textCharacters).toBe(24000);
		const scanned = await upload(fixture, session.id, "扫描.pdf", pdfDocument([""]));
		expect(scanned.diagnostics.join("\n")).toContain("扫描页");
		const binary = await upload(fixture, session.id, "原始数据.bin", Buffer.from([0, 1, 2, 3]));
		expect(binary.diagnostics.join("\n")).toContain("未自动解析");
		let seen = false;
		fixture.faux.setResponses([
			(context) => {
				const value = JSON.stringify(context.messages);
				expect(value).toContain("WORD-823 中文数量 31");
				expect(value).toContain("[第 1 页]");
				expect(value).toContain("PDF-651");
				seen = true;
				return fauxAssistantMessage("附件正文已收到。");
			},
		]);
		await send(fixture, session.id, "读取附件", [word, pdf]);
		expect(seen).toBe(true);
		expect(await fixture.application.services.memoryState.checkpoint(session.id)).toBeUndefined();
	} finally {
		await fixture.close();
	}
});

test("malformed inputs, excess size/count, source edits and symlink escapes do not create model runs", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({});
		for (const name of ["../escape.txt", "C:\\private.txt", ".env", "auth.json"]) {
			const response = await fixture.request(
				`/sessions/${session.id}/attachments?name=${encodeURIComponent(name)}`,
				{ method: "POST", body: "private" },
			);
			expect(response.status).toBeGreaterThanOrEqual(400);
		}
		for (const [name, bytes] of [
			["empty.txt", Buffer.alloc(0)],
			["spoof.png", Buffer.from("not an image")],
			["spoof.docx", Buffer.from("broken")],
			["too-big.txt", Buffer.alloc(20 * 1024 * 1024 + 1)],
		] as const) {
			const response = await fixture.request(`/sessions/${session.id}/attachments?name=${name}`, {
				method: "POST",
				body: new Uint8Array(bytes),
			});
			expect(response.status).toBe(400);
		}
		const file = await upload(fixture, session.id, "修改.txt", Buffer.from("原件"));
		const directory = join(fixture.application.paths.inbox, "chat-attachments", session.id, file.id);
		await writeFile(join(directory, "original.txt"), "外部编辑");
		expect((await fixture.request(`/sessions/${session.id}/attachments/${file.id}/file`)).status).toBe(409);
		const excess = await fixture.request(`/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({
				text: "test",
				attachmentIds: Array.from({ length: 9 }, (_value, index) => `id-${index}`),
			}),
		});
		expect(excess.status).toBe(400);
		const outside = join(fixture.root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "keep.txt"), "不得删除");
		await rm(directory, { recursive: true });
		await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
		expect((await fixture.request(`/sessions/${session.id}/attachments/${file.id}/file`)).status).toBe(403);
		expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("不得删除");
		expect(await fixture.application.services.sessions.readTranscript(session.id)).toEqual([]);
		await rm(directory, { force: true });
	} finally {
		await fixture.close();
	}
});

test("restart cleans abandoned uploads and orphan sessions, retains sent evidence, and session deletion clears originals", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({});
		const pending = await upload(fixture, session.id, "未发送.txt", Buffer.from("待清理"));
		const sent = await upload(fixture, session.id, "已发送.txt", Buffer.from("证据保留"));
		fixture.faux.setResponses([fauxAssistantMessage("收到证据。")]);
		await send(fixture, session.id, "测试", [sent]);
		for (const file of [pending, sent]) {
			const path = join(fixture.application.paths.inbox, "chat-attachments", session.id, file.id, "metadata.json");
			const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
			await writeFile(path, JSON.stringify({ ...value, createdAt: "2000-01-01T00:00:00.000Z" }));
		}
		await fixture.restart();
		expect((await fixture.request(`/sessions/${session.id}/attachments/${pending.id}/file`)).status).toBe(404);
		expect((await fixture.request(`/sessions/${session.id}/attachments/${sent.id}/file`)).status).toBe(200);
		expect(
			(await fixture.request(`/sessions/${session.id}/attachments/${sent.id}`, { method: "DELETE" })).status,
		).toBe(409);
		expect((await fixture.request(`/sessions/${session.id}`, { method: "DELETE" })).status).toBe(200);
		expect(await readdir(join(fixture.application.paths.inbox, "chat-attachments"))).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("cancelled processing publishes no attachment; combined document budget rejects excess without a run", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({});
		const service = new ChatAttachmentService(fixture.application.paths, fixture.application.services.sessions);
		await expect(
			service.upload(session.id, "取消.txt", Buffer.from("test"), AbortSignal.abort()),
		).rejects.toBeDefined();
		const a = await upload(fixture, session.id, "长文件甲.txt", Buffer.from("甲".repeat(24_000)));
		const b = await upload(fixture, session.id, "长文件乙.txt", Buffer.from("乙".repeat(24_000)));
		const response = await fixture.request(`/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "分析", attachmentIds: [a.id, b.id] }),
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("48000");
		expect(await fixture.application.services.sessions.readTranscript(session.id)).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("corrupt derived content is rejected and corrupt metadata cannot prevent startup or erase the original", async () => {
	const fixture = await createAssistantFixture(undefined, { modelInput: ["text", "image"] });
	try {
		const session = await fixture.application.createSession({});
		const file = await upload(fixture, session.id, "损坏恢复.txt", Buffer.from("保留原件"));
		const directory = join(fixture.application.paths.inbox, "chat-attachments", session.id, file.id);
		await writeFile(join(directory, "text.txt"), "伪造内容");
		const response = await fixture.request(`/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "读取", attachmentIds: [file.id] }),
		});
		expect(response.status).toBe(409);
		expect(await response.text()).toContain("正文表示");
		expect(await fixture.application.services.sessions.readTranscript(session.id)).toEqual([]);
		await writeFile(join(directory, "metadata.json"), "broken metadata");
		await fixture.restart();
		expect(await readFile(join(directory, "original.txt"), "utf8")).toBe("保留原件");
		expect((await fixture.request(`/sessions/${session.id}/attachments/${file.id}/file`)).status).toBe(500);
		expect(JSON.stringify(await fixture.application.logger.readRecent(100))).toContain("chat.attachments.recovery");
	} finally {
		await fixture.close();
	}
});
