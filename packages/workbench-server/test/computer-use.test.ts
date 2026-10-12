import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { ComputerUseService } from "../src/computer-use.ts";

test.skipIf(process.platform !== "win32")(
	"computer use focuses a controlled window, types Unicode, presses keys and captures real pixels",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-computer-"));
		if (!resolve(root).startsWith(resolve(join(tmpdir(), "workbench-computer-"))))
			throw new Error("Unexpected test directory");
		const textFile = join(root, "text.txt");
		const helper = join(root, "form.ps1");
		await writeFile(
			helper,
			`Add-Type -AssemblyName System.Windows.Forms\n$form=New-Object System.Windows.Forms.Form\n$form.Text='Workbench computer test'\n$form.Width=460\n$form.Height=220\n$form.StartPosition='CenterScreen'\n$box=New-Object System.Windows.Forms.TextBox\n$box.Multiline=$true\n$box.Dock='Fill'\n$form.Controls.Add($box)\n$box.Add_KeyUp({ param($sender,$e) [System.IO.File]::AppendAllText($env:WORKBENCH_COMPUTER_TEST_TEXT+'.keys', ($e.KeyCode.ToString()+':'+$e.Control+':'+$e.Shift+':'+$sender.SelectionLength+[Environment]::NewLine)) })\n$box.Add_TextChanged({ [System.IO.File]::WriteAllText($env:WORKBENCH_COMPUTER_TEST_TEXT, $box.Text) })\n$form.Show()\n$box.Focus() | Out-Null\n[Console]::WriteLine('READY:'+$form.Handle.ToInt64())\n[System.Windows.Forms.Application]::Run($form)\n`,
			"utf8",
		);
		const child = spawn("powershell.exe", ["-NoProfile", "-Sta", "-File", helper], {
			windowsHide: true,
			env: { ...process.env, WORKBENCH_COMPUTER_TEST_TEXT: textFile },
		});
		const service = new ComputerUseService(join(root, "cache"));
		try {
			const windowId = await new Promise<string>((resolveReady, reject) => {
				let output = "";
				const timer = setTimeout(() => reject(new Error("Test window timeout")), 15000);
				child.stdout.on("data", (chunk: Buffer) => {
					output += chunk.toString();
					const match = /READY:(\d+)/u.exec(output);
					if (match) {
						clearTimeout(timer);
						resolveReady(match[1]);
					}
				});
				child.once("error", reject);
			});
			const listed = await service.execute("test", { action: "windows" });
			expect(JSON.stringify(listed.details)).toContain(windowId);
			await service.execute("test", { action: "type", windowId, text: "中文测试" });
			await expect.poll(async () => readFile(textFile, "utf8")).toBe("中文测试");
			await service.execute("test", { action: "keypress", windowId, key: "CTRL+HOME" });
			await service.execute("test", { action: "keypress", windowId, key: "CTRL+SHIFT+END" });
			await service.execute("test", { action: "type", windowId, text: "替换成功" });
			await expect
				.poll(async () => readFile(textFile, "utf8"), {
					message: await readFile(`${textFile}.keys`, "utf8").catch(() => "No key events"),
				})
				.toBe("替换成功");
			const captured = await service.execute("test", { action: "screenshot", windowId });
			const image = captured.content.find((part) => part.type === "image");
			expect(image?.type).toBe("image");
			if (image?.type === "image") expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe("PNG");
			const region = captured.details.capture as { x: number; y: number; width: number; height: number };
			const point = { x: region.x + 60, y: region.y + 90 };
			const moved = await service.execute("test", { action: "move", windowId, ...point });
			expect(moved.details.cursor).toEqual(point);
			const clicked = await service.execute("test", { action: "click", windowId, ...point });
			expect(clicked.details.foregroundWindowId).toBe(windowId);
			const dragged = await service.execute("test", {
				action: "drag",
				windowId,
				...point,
				toX: point.x + 40,
				toY: point.y,
			});
			const cursor = dragged.details.cursor as { x: number; y: number };
			expect(
				Math.abs(cursor.x - point.x - 40),
				JSON.stringify({ region, point, cursor, screen: dragged.details.screen }),
			).toBeLessThanOrEqual(1);
			expect(Math.abs(cursor.y - point.y)).toBeLessThanOrEqual(1);
			await service.execute("test", { action: "scroll", windowId, amount: -2 });
			await expect(service.execute("test", { action: "click", windowId, x: -99999, y: -99999 })).rejects.toThrow();
			const controller = new AbortController();
			const waiting = service.execute("test", { action: "wait", windowId, milliseconds: 5000 }, controller.signal);
			setTimeout(() => controller.abort(), 150);
			await expect(waiting).rejects.toThrow();
		} finally {
			child.kill();
			await service.dispose();
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		}
	},
	60_000,
);
