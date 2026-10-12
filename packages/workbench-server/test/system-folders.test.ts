import { expect, test } from "vitest";
import { NativeSystemFolderReader } from "../src/system-folders.ts";

test.each([
	"D:\\Desktop",
	"E:\\研究资料\\个人 桌面",
	"C:\\Users\\test\\OneDrive - Research\\Desktop",
	"\\\\fileserver\\users\\test\\Desktop",
])("Windows desktop resolution preserves the OS path %s", async (path) => {
	const folders = new NativeSystemFolderReader({ platform: "win32", windowsQuery: async () => JSON.stringify(path) });
	expect(await folders.readDesktop()).toEqual({ path, source: "windows-known-folder" });
});

test.each(["", "Desktop", "C:Desktop", "D:\\Desktop\nwrong"])(
	"invalid OS desktop %j is unavailable, never inferred",
	async (path) => {
		const folders = new NativeSystemFolderReader({
			platform: "win32",
			windowsQuery: async () => JSON.stringify(path),
		});
		expect(await folders.readDesktop()).toMatchObject({ source: "unavailable" });
		expect((await folders.readDesktop()).path).toBeUndefined();
	},
);

test.each(["invalid-json", "null", "{}"])(
	"malformed desktop response %s never becomes a default path",
	async (response) => {
		const folders = new NativeSystemFolderReader({ platform: "win32", windowsQuery: async () => response });
		const result = await folders.readDesktop();
		expect(result.source).toBe("unavailable");
		expect(result.path).toBeUndefined();
		expect(result.diagnostic).toBeTruthy();
	},
);

test("OS lookup failures are explicit and do not fall back to the home directory", async () => {
	const folders = new NativeSystemFolderReader({
		platform: "win32",
		windowsQuery: async () => {
			throw new Error("lookup unavailable");
		},
	});
	expect(await folders.readDesktop()).toMatchObject({ source: "unavailable", diagnostic: expect.any(String) });
});
