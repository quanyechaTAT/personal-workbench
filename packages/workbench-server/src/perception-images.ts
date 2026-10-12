import { WorkbenchError } from "@earendil-works/workbench-core";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PerceptionImage } from "./perception-adapter.ts";

export async function prepareImage(bytes: Buffer, page?: number): Promise<PerceptionImage> {
	let width = 0;
	let height = 0;
	if (bytes.length > 24 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
		width = bytes.readUInt32BE(16);
		height = bytes.readUInt32BE(20);
	} else if (bytes.length > 26 && bytes.toString("ascii", 0, 2) === "BM") {
		width = Math.abs(bytes.readInt32LE(18));
		height = Math.abs(bytes.readInt32LE(22));
	} else if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		for (let offset = 2; offset + 4 < bytes.length; ) {
			if (bytes[offset] !== 0xff) break;
			const marker = bytes[offset + 1];
			if (marker === 0xd8 || marker === 0xd9) {
				offset += 2;
				continue;
			}
			const length = bytes.readUInt16BE(offset + 2);
			if (length < 2 || offset + 2 + length > bytes.length) break;
			if (
				[0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) &&
				length >= 7
			) {
				height = bytes.readUInt16BE(offset + 5);
				width = bytes.readUInt16BE(offset + 7);
				break;
			}
			offset += 2 + length;
		}
	}
	if (!width || !height || width * height > 20_000_000)
		throw new WorkbenchError("invalid_input", "图片格式无效或超过 2000 万像素，请缩小后上传");
	let image: Awaited<ReturnType<typeof loadImage>>;
	try {
		image = await loadImage(bytes);
	} catch {
		throw new WorkbenchError("invalid_input", "无法解码图片，请检查文件内容");
	}
	let scale = Math.min(1, 2000 / Math.max(width, height));
	for (let attempt = 0; attempt < 5; attempt++) {
		const canvas = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
		canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
		const encoded = canvas.toBuffer("image/png");
		if (encoded.length <= 3 * 1024 * 1024)
			return {
				dataUrl: `data:image/png;base64,${encoded.toString("base64")}`,
				width: canvas.width,
				height: canvas.height,
				originalWidth: width,
				originalHeight: height,
				page,
			};
		scale *= 0.7;
	}
	throw new WorkbenchError("invalid_input", "图片转换后仍超过服务的 3 MiB 限制");
}

export async function renderScannedPages(
	bytes: Buffer,
	pages: number[],
	signal: AbortSignal,
	onPage: (image: PerceptionImage, bytes: Buffer) => Promise<void>,
): Promise<void> {
	const loading = getDocument({
		data: new Uint8Array(bytes),
		useWorkerFetch: false,
		disableFontFace: true,
		verbosity: 0,
	});
	const abort = () => {
		void loading.destroy();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		const pdf = await loading.promise;
		for (const number of pages) {
			signal.throwIfAborted();
			const page = await pdf.getPage(number);
			const dimensions = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({
				scale: Math.min(2, 2000 / Math.max(dimensions.width, dimensions.height)),
			});
			const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
			await page.render({ canvas: canvas as unknown as Parameters<typeof page.render>[0]["canvas"], viewport })
				.promise;
			const rendered = canvas.toBuffer("image/png");
			await onPage(await prepareImage(rendered, number), rendered);
			page.cleanup();
		}
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof WorkbenchError) throw error;
		throw new WorkbenchError("invalid_input", "无法渲染扫描 PDF 页，请检查文件或拆分上传");
	} finally {
		signal.removeEventListener("abort", abort);
		await loading.destroy();
	}
}
