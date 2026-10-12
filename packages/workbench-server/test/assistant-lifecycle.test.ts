import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("new conversations require an explicit assistant even with a configured default", async () => {
	const fixture = await createAssistantFixture();
	try {
		const standard = await fixture.application.services.profiles.getBySlug("standard");
		await fixture.application.services.profiles.setDefault(standard.id);
		const response = await fixture.request("/sessions", { method: "POST", body: "{}" });
		expect(response.status).toBe(400);
		expect(await fixture.application.services.sessions.list()).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("archiving and deleting a built-in assistant preserve history and survive restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		const standard = await fixture.application.services.profiles.getBySlug("standard");
		const session = await fixture.application.createSession({ profileId: standard.id });
		fixture.faux.setResponses([fauxAssistantMessage("保留这段历史")]);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, { text: "记录", context: context.runtime });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			/* drain */
		}
		const before = await fixture.application.services.sessions.readTranscript(session.id);
		const archived = await fixture.application.services.profiles.archive(standard.id, standard.version);
		expect(archived.status).toBe("archived");
		const restored = await fixture.application.services.profiles.restore(standard.id, archived.version);
		const stale = await fixture.request(`/profiles/${standard.id}`, {
			method: "DELETE",
			body: JSON.stringify({ expectedVersion: standard.version }),
		});
		expect(stale.status).toBe(409);
		const deleted = await fixture.request(`/profiles/${standard.id}`, {
			method: "DELETE",
			body: JSON.stringify({ expectedVersion: restored.version }),
		});
		expect(deleted.status).toBe(200);
		await fixture.restart();
		expect((await fixture.application.services.profiles.list(true)).map((p) => p.id)).not.toContain(standard.id);
		expect(await fixture.application.services.sessions.readTranscript(session.id)).toEqual(before);
		const ptc = await fixture.application.services.profiles.getBySlug("ptc");
		const changed = await fixture.request(`/sessions/${session.id}/assistant`, {
			method: "PUT",
			body: JSON.stringify({ profileId: ptc.id, expectedProfileId: standard.id }),
		});
		expect(changed.status).toBe(200);
		expect(await changed.json()).toMatchObject({
			id: session.id,
			agentProfileId: ptc.id,
			runtimeRef: session.runtimeRef,
		});
		expect(await fixture.application.services.sessions.readTranscript(session.id)).toEqual(before);
		fixture.faux.setResponses([fauxAssistantMessage("沿用新助手")]);
		const nextContext = await fixture.application.contextForSession(session.id);
		const nextRun = fixture.application.events.start(session.id, { text: "继续", context: nextContext.runtime });
		for await (const _entry of fixture.application.events.subscribe(nextRun.runId)) {
			/* drain */
		}
		expect((await fixture.application.repositories.agentRuns.get(nextRun.runId))?.profileSlug).toBe("ptc");
		await fixture.restart();
		expect((await fixture.application.services.sessions.get(session.id)).agentProfileId).toBe(ptc.id);
		expect(JSON.stringify(await fixture.application.services.sessions.readTranscript(session.id))).toContain(
			"保留这段历史",
		);
	} finally {
		await fixture.close();
	}
});
