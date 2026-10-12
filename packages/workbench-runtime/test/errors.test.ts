import { describe, expect, test } from "vitest";
import { errorMessage, RuntimeError } from "../src/index.ts";

describe("RuntimeError", () => {
	test("preserves a supplier-neutral error code and cause", () => {
		const cause = new Error("provider disconnected");
		const error = new RuntimeError("runtime_failure", "Agent run failed", { cause });
		expect(error.name).toBe("RuntimeError");
		expect(error.code).toBe("runtime_failure");
		expect(error.cause).toBe(cause);
		expect(errorMessage(error)).toBe("Agent run failed");
		expect(errorMessage("failed")).toBe("failed");
	});
});
