import { describe, expect, it } from "vitest";
import { projectSlug } from "../src/project-service.ts";

describe("projectSlug", () => {
	it("creates an immutable workspace-safe slug", () => {
		expect(projectSlug("  CV Learning  ")).toBe("cv-learning");
		expect(projectSlug("Model---Evaluation 2026")).toBe("model-evaluation-2026");
	});

	it("rejects names that cannot produce a valid 2-64 character slug", () => {
		expect(() => projectSlug("视觉学习")).toThrowError(/ASCII slug/u);
		expect(() => projectSlug("a")).toThrowError(/ASCII slug/u);
	});

	it("uses an independent safe project ID for Chinese display names without changing existing slugs", () => {
		expect(projectSlug("视觉学习", "abc-123")).toBe("project-abc-123");
		expect(projectSlug("CV Learning", "abc-123")).toBe("cv-learning");
		expect(() => projectSlug("视觉学习", "../escape")).toThrow();
		expect(() => projectSlug("", "abc-123")).toThrow();
	});
});
