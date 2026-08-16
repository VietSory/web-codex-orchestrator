import type { AuthoringEvent, BridgeJobIdentity, FinalReviewRequest } from "../contracts.js";
import type { AuthoringJobRequest } from "../web-bridge.js";

export type RelayJobKind = "authoring" | "final_review";
export interface RelayStoredEvent { sequence: number; type: string; payload: unknown; created_at: string; idempotency_key: string; content_sha256: string; }
export interface RelayJobRecord {
  schema_version: "1.0";
  identity: BridgeJobIdentity;
  kind: RelayJobKind;
  request: AuthoringJobRequest | FinalReviewRequest;
  events: RelayStoredEvent[];
  idempotency: Record<string, string>;
}
export interface RelayLimits {
  maximum_record_bytes: number;
  maximum_record_files: number;
  maximum_events_per_job: number;
  maximum_active_jobs_per_owner: number;
  maximum_ttl_seconds: number;
}
export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maximum_record_bytes: 8_388_608,
  maximum_record_files: 4_096,
  maximum_events_per_job: 1_000,
  maximum_active_jobs_per_owner: 32,
  maximum_ttl_seconds: 604_800,
};

export function isRelayJobPending(record: RelayJobRecord, nowMs = Date.now()): boolean {
  const expiresAt = Date.parse(record.identity.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return false;
  if (record.kind === "final_review") return !record.events.some((event) => event.type === "web_verdict");
  const mode = (record.request as AuthoringJobRequest).orchestration_mode ?? "PAIR";
  if (mode !== "PAIR" && mode !== "AUTOPILOT") return false;
  // Harness-first PAIR and AUTOPILOT both require the original Web author to
  // finish by sealing exact implementation authority. A contract alone is not
  // executable authority and must never make the relay drop the pending job.
  return !record.events.some((event) => event.type === "implementation_sealed");
}

export function toAuthoringEvent(event: RelayStoredEvent): AuthoringEvent | null {
  if (!["repository_command", "contract_sealed", "implementation_sealed"].includes(event.type)) return null;
  return { sequence: event.sequence, type: event.type, ...(event.payload as object) } as AuthoringEvent;
}
