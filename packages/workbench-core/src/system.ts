import { randomUUID } from "node:crypto";

export interface SystemServices {
	now(): Date;
	id(): string;
}

export const defaultSystemServices: SystemServices = {
	now: () => new Date(),
	id: () => randomUUID(),
};

export function toTimestamp(date: Date): string {
	return date.toISOString();
}
