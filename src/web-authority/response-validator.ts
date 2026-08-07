import { WebAuthorityError, type WebResponseEnvelope } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateWebResponseEnvelope(value: unknown): WebResponseEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Web response envelope must be a JSON object.");
  }
  const envelope = value as Record<string, unknown>;
  const allowed = new Set(["schema_version", "kind", "run_id", "response_id", "in_reply_to_artifact_sha256", "decision", "payload_sha256", "created_at"]);
  for (const key of Object.keys(envelope)) if (!allowed.has(key)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", `Unexpected Web response field '${key}'.`);
  if (envelope.schema_version !== "2.0" || envelope.kind !== "wco-web-response") throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Unsupported Web response schema/kind.");
  if (typeof envelope.run_id !== "string" || envelope.run_id.lastIndexOf(":") <= 0) throw new WebAuthorityError("WEB_AUTHORITY_INVALID_RUN_ID", "Web response run_id is invalid.");
  if (typeof envelope.response_id !== "string" || !SAFE_ID.test(envelope.response_id)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Web response response_id is invalid.");
  if (typeof envelope.in_reply_to_artifact_sha256 !== "string" || !SHA256.test(envelope.in_reply_to_artifact_sha256)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Web response in_reply_to_artifact_sha256 is invalid.");
  if (typeof envelope.payload_sha256 !== "string" || !SHA256.test(envelope.payload_sha256)) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Web response payload_sha256 is invalid.");
  if (!["APPROVE", "REVISE", "ESCALATE"].includes(String(envelope.decision))) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Web response decision is invalid.");
  if (typeof envelope.created_at !== "string" || !Number.isFinite(Date.parse(envelope.created_at))) throw new WebAuthorityError("WEB_AUTHORITY_MANIFEST_INVALID", "Web response created_at is invalid.");
  return envelope as unknown as WebResponseEnvelope;
}
