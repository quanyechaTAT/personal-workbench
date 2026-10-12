import { describe, expect, test } from "vitest";
import { minimalShellEnvironment } from "../src/shell-environment.ts";

describe("minimalShellEnvironment", () => {
	test("keeps shell prerequisites and removes inherited credentials", () => {
		expect(
			minimalShellEnvironment({
				Path: "C:\\Windows\\System32",
				SystemRoot: "C:\\Windows",
				TEMP: "C:\\Temp",
				OPENAI_API_KEY: "must-not-leak",
				ANTHROPIC_OAUTH_TOKEN: "must-not-leak",
				PERSONAL_WORKBENCH_HOME: "must-not-leak",
			}),
		).toEqual({ Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
	});
});
