import { createHash } from "node:crypto";
import { redact } from "../evidence/log-redaction.js";

export function redactPrompt(value: string): string { return redact(value); }
export function buildPrompt(parts: Record<string, string>): string { return Object.entries(parts).map(([key, value]) => `## ${key}\n${redactPrompt(value)}`).join("\n\n"); }
export function promptHash(prompt: string): string { return createHash("sha256").update(redactPrompt(prompt)).digest("hex"); }
