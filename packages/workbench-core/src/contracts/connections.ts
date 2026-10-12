import { type Static, Type } from "typebox";

const StdioConfigSchema = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		args: Type.Array(Type.String(), { maxItems: 256 }),
		cwd: Type.Optional(Type.String()),
		environmentKeys: Type.Array(Type.String({ minLength: 1 }), { maxItems: 128 }),
	},
	{ additionalProperties: false },
);

const RemoteConfigSchema = Type.Object(
	{
		url: Type.String({ minLength: 1 }),
		headerNames: Type.Array(Type.String({ minLength: 1 }), { maxItems: 128 }),
		clientId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const McpSecretInputSchema = Type.Object(
	{
		bearerToken: Type.Optional(Type.String()),
		clientSecret: Type.Optional(Type.String()),
		headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
		environment: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
	},
	{ additionalProperties: false },
);

export const SaveMcpConnectionSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 120 }),
		callTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600000 })),
		transport: Type.Union([Type.Literal("stdio"), Type.Literal("streamable-http"), Type.Literal("sse")]),
		stdio: Type.Optional(StdioConfigSchema),
		remote: Type.Optional(RemoteConfigSchema),
		authKind: Type.Union([Type.Literal("none"), Type.Literal("headers"), Type.Literal("oauth")]),
		secret: Type.Optional(McpSecretInputSchema),
		enabled: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const UpdateMcpConnectionSchema = Type.Object(
	{ ...SaveMcpConnectionSchema.properties, expectedVersion: Type.Integer({ minimum: 1 }) },
	{ additionalProperties: false },
);

export interface McpConnectionDto {
	callTimeoutMs?: number;
	id: string;
	name: string;
	transport: "stdio" | "streamable-http" | "sse";
	stdio?: { command: string; args: string[]; cwd?: string; environmentKeys: string[] };
	remote?: { url: string; headerNames: string[]; clientId?: string };
	authKind: "none" | "headers" | "oauth";
	enabled: boolean;
	version: number;
	lastError?: string;
	lastConnectedAt?: string;
	authentication?: { configured: boolean; oauth?: boolean };
}

export type SaveMcpConnectionRequest = Static<typeof SaveMcpConnectionSchema>;
export type UpdateMcpConnectionRequest = Static<typeof UpdateMcpConnectionSchema>;
