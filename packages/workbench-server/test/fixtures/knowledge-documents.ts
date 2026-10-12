import JSZip from "jszip";

/** Small real files for parser and upload tests, generated without Office/Python. */
export async function docxDocument(text: string): Promise<Buffer> {
	const zip = new JSZip();
	zip.file(
		"[Content_Types].xml",
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
	);
	zip.file(
		"_rels/.rels",
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
	);
	zip.file(
		"word/document.xml",
		`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</w:t></w:r></w:p></w:body></w:document>`,
	);
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function structuredDocxDocument(): Promise<Buffer> {
	const zip = await JSZip.loadAsync(await docxDocument(""));
	zip.file(
		"word/styles.xml",
		'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
	);
	zip.file(
		"word/_rels/document.xml.rels",
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
	);
	zip.file(
		"word/document.xml",
		'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>检索规范</w:t></w:r></w:p><w:p><w:r><w:t>星辰项目采用结构化分块，保留原文。版本 v2.1 不使用新版模型。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>参数</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>分块上限</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>256 Token</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
	);
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export function pdfDocument(pages: Array<string | Array<{ text: string; size?: number }>>): Buffer {
	const objects: string[] = [];
	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	objects.push(
		`<< /Type /Pages /Kids [${pages.map((_page, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
	);
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	for (const [index, text] of pages.entries()) {
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
		);
		const lines = typeof text === "string" ? [{ text, size: 12 }] : text;
		const stream = `BT 40 750 Td ${lines.map((line, position) => `${position ? "0 -30 Td " : ""}/F1 ${line.size ?? 12} Tf (${line.text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj`).join(" ")} ET`;
		objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
	}
	let output = "%PDF-1.4\n";
	const offsets: number[] = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(output));
		output += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(output);
	output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(output);
}
