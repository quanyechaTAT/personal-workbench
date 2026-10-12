import { type Static, Type } from "typebox";

const tabId = Type.Optional(Type.String({ minLength: 1, maxLength: 80 }));
const ref = Type.String({ pattern: "^[a-z0-9]{1,40}$" });
export const BrowserUseSchema = Type.Union(
	[
		Type.Object({ action: Type.Literal("tabs") }, { additionalProperties: false }),
		Type.Object(
			{ action: Type.Literal("open"), url: Type.String({ minLength: 1, maxLength: 8192 }), tabId },
			{ additionalProperties: false },
		),
		Type.Object({ action: Type.Literal("snapshot"), tabId }, { additionalProperties: false }),
		Type.Object({ action: Type.Literal("screenshot"), tabId }, { additionalProperties: false }),
		Type.Object(
			{
				action: Type.Literal("click"),
				tabId,
				ref,
				button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{ action: Type.Literal("fill"), tabId, ref, text: Type.String({ maxLength: 20_000 }) },
			{ additionalProperties: false },
		),
		Type.Object(
			{ action: Type.Literal("press"), tabId, ref, key: Type.String({ minLength: 1, maxLength: 80 }) },
			{ additionalProperties: false },
		),
		Type.Object(
			{ action: Type.Literal("scroll"), tabId, deltaY: Type.Integer({ minimum: -10_000, maximum: 10_000 }) },
			{ additionalProperties: false },
		),
		Type.Object({ action: Type.Literal("back"), tabId }, { additionalProperties: false }),
		Type.Object({ action: Type.Literal("close"), tabId }, { additionalProperties: false }),
	],
	{ type: "object" },
);
const windowId = Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,18}$" }));
const point = {
	x: Type.Integer({ minimum: -100_000, maximum: 100_000 }),
	y: Type.Integer({ minimum: -100_000, maximum: 100_000 }),
};
export const ComputerUseSchema = Type.Union(
	[
		Type.Object({ action: Type.Literal("windows") }, { additionalProperties: false }),
		Type.Object({ action: Type.Literal("screenshot"), windowId }, { additionalProperties: false }),
		Type.Object(
			{ action: Type.Literal("focus"), windowId: Type.String({ pattern: "^[1-9][0-9]{0,18}$" }) },
			{ additionalProperties: false },
		),
		Type.Object(
			{
				action: Type.Literal("click"),
				...point,
				windowId,
				button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
				double: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		Type.Object({ action: Type.Literal("move"), ...point, windowId }, { additionalProperties: false }),
		Type.Object(
			{ action: Type.Literal("drag"), ...point, toX: point.x, toY: point.y, windowId },
			{ additionalProperties: false },
		),
		Type.Object(
			{ action: Type.Literal("scroll"), amount: Type.Integer({ minimum: -20, maximum: 20 }), windowId },
			{ additionalProperties: false },
		),
		Type.Object(
			{ action: Type.Literal("type"), text: Type.String({ maxLength: 10_000 }), windowId },
			{ additionalProperties: false },
		),
		Type.Object(
			{ action: Type.Literal("keypress"), key: Type.String({ minLength: 1, maxLength: 80 }), windowId },
			{ additionalProperties: false },
		),
		Type.Object(
			{ action: Type.Literal("wait"), milliseconds: Type.Integer({ minimum: 1, maximum: 5000 }), windowId },
			{ additionalProperties: false },
		),
	],
	{ type: "object" },
);
export type BrowserUseInput = Static<typeof BrowserUseSchema>;
export type ComputerUseInput = Static<typeof ComputerUseSchema>;
export interface InteractionResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: Record<string, unknown>;
}
export interface InteractionService<T> {
	execute(sessionId: string, input: T, signal?: AbortSignal): Promise<InteractionResult>;
}
