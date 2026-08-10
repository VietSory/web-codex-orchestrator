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
export interface RelayLimits { maximum_record_bytes: number; maximum_events_per_job: number; maximum_active_jobs_per_owner: number; maximum_ttl_seconds: number; }
export const DEFAULT_RELAY_LIMITS: RelayLimits = { maximum_record_bytes: 8_388_608, maximum_events_per_job: 1_000, maximum_active_jobs_per_owner: 32, maximum_ttl_seconds: 604_800 };
export function toAuthoringEvent(event: RelayStoredEvent): AuthoringEvent | null { if (!["repository_command", "contract_sealed", "implementation_sealed"].includes(event.type)) return null; return { sequence: event.sequence, type: event.type, ...(event.payload as object) } as AuthoringEvent; }
