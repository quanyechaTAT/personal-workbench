import { type Static, Type } from "typebox";

export const PermissionModeSchema = Type.Union([
	Type.Literal("ask"),
	Type.Literal("auto"),
	Type.Literal("full-access"),
]);
export type PermissionMode = Static<typeof PermissionModeSchema>;
export const SetPermissionModeSchema = Type.Object({ mode: PermissionModeSchema }, { additionalProperties: false });
export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "ask" || value === "auto" || value === "full-access";
}
