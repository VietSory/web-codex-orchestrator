import crypto from "node:crypto";
import { WebBridgeError } from "./contracts.js";

export const MAX_CHATGPT_CODEX_REVIEW_EVIDENCE_JSON_BYTES = 480 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactUtf8(bytes: Buffer, label: string): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", `${label} is not valid exact UTF-8 text.`);
  }
  return text;
}

function semanticEntry(path: string, value: unknown): { content_utf8: string; sha256: string; size_bytes: number } {
  const entry = object(value, `Review evidence '${path}'`);
  const keys = Object.keys(entry);
  if (keys.length !== 3 || !keys.includes("content_base64") || !keys.includes("sha256") || !keys.includes("size_bytes")) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", `Review evidence '${path}' has an unexpected transport shape.`);
  }
  if (typeof entry.content_base64 !== "string" || !CANONICAL_BASE64.test(entry.content_base64)) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", `Review evidence '${path}' is not canonical base64.`);
  }
  if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", `Review evidence '${path}' has an invalid SHA-256.`);
  }
  if (!Number.isSafeInteger(entry.size_bytes) || (entry.size_bytes as number) < 0) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", `Review evidence '${path}' has an invalid size.`);
  }

  const bytes = Buffer.from(entry.content_base64, "base64");
  if (bytes.toString("base64") !== entry.content_base64 || bytes.byteLength !== entry.size_bytes) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", `Review evidence '${path}' base64/size binding is invalid.`);
  }
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", `Review evidence '${path}' content digest is invalid.`);
  }
  return { content_utf8: exactUtf8(bytes, `Review evidence '${path}'`), sha256: digest, size_bytes: bytes.byteLength };
}

/**
 * Convert the stable generic WebBridge evidence transport into exact readable
 * local semantic context. This is intentionally ChatGPT/Codex-specific: manual,
 * MCP, and Action Relay bridges keep the existing base64 wire contract.
 */
export function prepareChatGptCodexReviewEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(evidence);
  if (keys.length !== 3 || !keys.includes("purpose") || !keys.includes("binding") || !keys.includes("entries")) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", "Review evidence has an unexpected top-level shape.");
  }
  if (evidence.purpose !== "independent_code_review" && evidence.purpose !== "final_intent_review") {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", "Review evidence has an invalid purpose.");
  }
  const binding = object(evidence.binding, "Review evidence binding");
  const entries = object(evidence.entries, "Review evidence entries");
  const readableEntries: Record<string, { content_utf8: string; sha256: string; size_bytes: number }> = {};
  for (const [entryPath, entry] of Object.entries(entries)) readableEntries[entryPath] = semanticEntry(entryPath, entry);

  const readable = { purpose: evidence.purpose, binding, entries: readableEntries };
  const encoded = JSON.stringify(readable);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CHATGPT_CODEX_REVIEW_EVIDENCE_JSON_BYTES) {
    throw new WebBridgeError(
      "WEB_RESULT_REVIEW_CONTEXT_LIMIT",
      "Exact review evidence exceeds the bounded ChatGPT/Codex semantic context. Split the change into a smaller reviewable task; WCO refuses to truncate evidence and approve from partial context.",
    );
  }
  return readable;
}
