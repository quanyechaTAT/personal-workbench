import { BrowserUseSchema, ComputerUseSchema } from "@earendil-works/workbench-core/contracts";
import { Parse } from "typebox/value";
import { expect, test } from "vitest";

test("model-facing interaction schemas have object roots and validate required action fields", () => {
	expect(Reflect.get(BrowserUseSchema, "type")).toBe("object");
	expect(Reflect.get(ComputerUseSchema, "type")).toBe("object");
	expect(Parse(BrowserUseSchema, { action: "fill", ref: "e1", text: "中文" })).toEqual({
		action: "fill",
		ref: "e1",
		text: "中文",
	});
	expect(() => Parse(BrowserUseSchema, { action: "fill", ref: "e1" })).toThrow();
	expect(() => Parse(ComputerUseSchema, { action: "drag", x: 10, y: 10 })).toThrow();
	expect(() => Parse(ComputerUseSchema, { action: "click", x: Infinity, y: 10 })).toThrow();
});
