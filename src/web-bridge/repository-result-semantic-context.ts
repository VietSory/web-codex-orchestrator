import crypto from "node:crypto";
import { WebBridgeError } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function exactUtf8(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

function semanticFile(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const file = value as Record<string, unknown>;
  if (!("content_base64" in file)) return value;
  if (typeof file.content_base64 !== "string" || !CANONICAL_BASE64.test(file.content_base64)) {
    throw new WebBridgeError("WEB_REPOSITORY_CONTEXT_INVALID", "Repository semantic context contains non-canonical base64 content.");
  }
  if (typeof file.content_sha256 !== "string" || !SHA256.test(file.content_sha256)) {
    throw new WebBridgeError("WEB_REPOSITORY_CONTEXT_INVALID", "Repository semantic context lacks an exact SHA-256 binding.");
  }
  if (!Number.isSafeInteger(file.size_bytes) || (file.size_bytes as number) < 0) {
    throw new WebBridgeError("WEB_REPOSITORY_CONTEXT_INVALID", "Repository semantic context has an invalid byte size.");
  }

  // A content-addressed cache hit intentionally carries no payload. Preserve
  // only the immutable reference instead of retransmitting an empty base64
  // field that could be mistaken for the exact file contents.
  if (file.content_ref !== undefined) {
    const expectedReference = `sha256:${file.content_sha256}`;
    if (file.content_ref !== expectedReference || file.content_base64 !== "") {
      throw new WebBridgeError("WEB_REPOSITORY_CONTEXT_INVALID", "Repository context reference is malformed or not bound to the exact content digest.");
    }
    const { content_base64: _encoded, ...rest } = file;
    return rest;
  }

  const bytes = Buffer.from(file.content_base64, "base64");
  if (bytes.toString("base64") !== file.content_base64 || bytes.byteLength !== file.size_bytes) {
    throw new WebBridgeError("WEB_REPOSITORY_CONTEXT_INVALID", "Repository semantic context base64/size binding is invalid.");
  }
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== file.content_sha256) {
    throw new WebBridgeError("WEB_REPOSITORY_CONTEXT_INVALID", "Repository semantic context digest is invalid.");
  }

  const text = exactUtf8(bytes);
  if (text === null) return value;
  const { content_base64: _encoded, ...rest } = file;
  return { ...rest, content_utf8: text };
}

/**
 * Repository reads are transported as digest-bound base64 so the wire format
 * stays binary-safe. Semantic reasoning should not pay the base64 expansion or
 * reason over encoded source text. Convert only exact UTF-8 payloads after
 * re-attesting their size and SHA-256; binary payloads remain untouched.
 */
export function prepareRepositoryResultForSemanticPrompt(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.files)) return value;
  return { ...result, files: result.files.map(semanticFile) };
}
