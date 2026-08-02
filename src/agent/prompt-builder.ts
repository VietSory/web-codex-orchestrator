import { createHash } from "node:crypto";

const SECRET = /(?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi;
export function redactPrompt(value: string): string { return value.replace(SECRET, (match) => match.replace(/[:=].*$/, ": [REDACTED]")); }
export function buildPrompt(parts: Record<string, string>): string { return Object.entries(parts).map(([key, value]) => `## ${key}\n${redactPrompt(value)}`).join("\n\n"); }
export function promptHash(prompt: string): string { return createHash("sha256").update(redactPrompt(prompt)).digest("hex"); }
