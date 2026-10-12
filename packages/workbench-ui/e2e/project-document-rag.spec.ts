import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";
import { docxDocument, pdfDocument } from "../../workbench-server/test/fixtures/knowledge-documents.ts";

test("upload Word and PDF, view parsed text, retrieve page citations, restart, and delete knowledge",async({page})=> {
	const fixture=await createAssistantFixture(fileURLToPath(new URL("../dist",import.meta.url)));
	const embedding=createServer(async(request,response)=> {
		let body=""; for await (const chunk of request) body+=chunk.toString();
		const input=(JSON.parse(body) as {input:string[]}).input;
		response.setHeader("content-type","application/json");
		response.end(JSON.stringify({data:input.map((text,index)=>({index,embedding:/vision|视觉/iu.test(text) ? [1,0] : [0,1]}))}));
	});
	await new Promise<void>((resolve)=>embedding.listen(0,"127.0.0.1",resolve));
	try {
		const address=embedding.address(); if (!address || typeof address==="string") throw new Error("No embedding test port");
		await writeFile(fixture.embeddingEnvFile,`EMBED_API_KEY=browser-rag-secret\nEMBED_BASE_URL=http://127.0.0.1:${address.port}/v1\nEMBED_MODEL_NAME=browser-rag\nEMBED_TOKENIZER=cl100k_base\nEMBED_TOKENIZER_MODEL=browser-rag\n`);
		const source=join(fixture.root,"CV资料项目"); await mkdir(source);
		const project=await fixture.application.createProject({sourcePath:source});
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/knowledge`);
		await expect(page.getByText("browser-rag",{exact:true})).toBeVisible();
		await page.getByLabel("上传知识文档").setInputFiles([{name:"研究说明.docx",mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",buffer:await docxDocument("视觉 vision 项目说明，数据集含 1200 张图片。")},{name:"vision-report.pdf",mimeType:"application/pdf",buffer:pdfDocument(["Vision experiment has 91 percent accuracy."])}]);
		await expect(page.locator(".knowledge-stage.ready")).toHaveCount(2);
		await expect(page.locator(".knowledge-preview")).toContainText("Vision experiment");
		await page.getByRole("button",{name:/研究说明.docx/}).click();
		await expect(page.locator(".knowledge-preview")).toContainText("1200");
		await page.getByText("派生 Markdown 与来源映射", { exact: true }).click();
		await expect(page.locator(".knowledge-preview details")).toContainText("Word 页码");
		const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "下载完整 Markdown" }).click()]);
		expect(await download.failure()).toBeNull();
		await page.getByLabel("检索项目资料").fill("vision accuracy");
		await page.getByRole("button",{name:"检索",exact:true}).click();
		await expect(page.getByRole("heading",{name:"vision-report.pdf · 第 1 页 · 片段 1"})).toBeVisible();
		await expect(page.locator("body")).not.toContainText("browser-rag-secret");
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/knowledge`);
		await expect(page.locator(".knowledge-stage.ready")).toHaveCount(2);
		page.once("dialog",(dialog)=>dialog.accept());
		await page.locator(".knowledge-document").filter({hasText:"vision-report.pdf"}).getByRole("button",{name:"删除",exact:true}).click();
		await expect(page.locator(".knowledge-document")).toHaveCount(1);
		await page.getByLabel("检索项目资料").fill("vision");
		await page.getByRole("button",{name:"检索",exact:true}).click();
		await expect(page.locator(".knowledge-result")).toHaveCount(1);
		await expect(page.locator(".knowledge-result")).toContainText("研究说明.docx");
	} finally {
		await fixture.close();
		await new Promise<void>((resolve,reject)=>embedding.close((error)=>error ? reject(error) : resolve()));
	}
});
