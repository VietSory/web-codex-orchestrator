import crypto from "node:crypto";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";

export const WEB_BRIDGE_PROTOCOL_VERSION = "wco-web-bridge-v1" as const;

export class WebBridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "WebBridgeError"; }
}

export interface RepositoryBinding { repository_id: string; base_branch: string; base_commit: string; }
export interface WebSourceReceipt { url: string; title: string; accessed_at: string; relevance: string; }
export interface WebContractEnvelope {
  protocol_version: typeof WEB_BRIDGE_PROTOCOL_VERSION;
  job_id: string;
  repository: RepositoryBinding;
  user_intent: string;
  title: string;
  goal: string;
  non_goals: string[];
  architecture_decisions: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: Array<{ id: string; description: string }>;
  verification_commands: Array<{ id: string; executable: string; args: string[] }>;
  risk_policy: { network_access: boolean; secrets_required: boolean; notes: string[] };
  delivery: { remote: string; base_branch: string; branch_name: string; draft: true; auto_merge: false };
  sources: WebSourceReceipt[];
  implementation_strategy: string[];
  project_map_hints: string[];
}

export type WebImplementationOperation =
  | { kind: "create"; path: string; content_base64: string; content_sha256: string }
  | { kind: "replace"; path: string; content_base64: string; content_sha256: string }
  | { kind: "delete"; path: string };

export interface WebImplementationSubmission {
  protocol_version: typeof WEB_BRIDGE_PROTOCOL_VERSION;
  job_id: string;
  run_id: string;
  contract_only: boolean;
  summary: string;
  operations: WebImplementationOperation[];
  project_map: Array<{ path: string; purpose: string }>;
  sources: WebSourceReceipt[];
}

export interface WebVerdictEnvelope {
  protocol_version: typeof WEB_BRIDGE_PROTOCOL_VERSION;
  review_id: string;
  run_id: string;
  result_bundle_sha256: string;
  verdict: "APPROVE" | "REVISE" | "BLOCK";
  summary: string;
  findings: Array<{ id: string; severity: "blocking" | "non_blocking"; description: string }>;
}

export interface BridgeJobIdentity {
  protocol_version: typeof WEB_BRIDGE_PROTOCOL_VERSION;
  job_id: string;
  owner: string;
  created_at: string;
  expires_at: string;
  content_sha256: string;
}

export type AuthoringEvent =
  | { sequence: number; type: "repository_command"; request_id: string; command: RepositoryCommand }
  | { sequence: number; type: "contract_sealed"; envelope: WebContractEnvelope }
  | { sequence: number; type: "implementation_sealed"; submission: WebImplementationSubmission };

export type RepositoryCommand =
  | { operation: "summary" }
  | { operation: "tree"; prefix?: string; maximum_paths?: number }
  | { operation: "search"; query: string; maximum_matches?: number }
  | { operation: "read"; paths: string[] };

export interface RepositoryCommandResult { request_id: string; result: unknown; }
export interface FinalReviewRequest { run_id: string; result_bundle_sha256: string; published_commit_sha: string; pull_request_url: string; review_round: number; }
export interface BridgeConnectionStatus { configured: boolean; connected: boolean; account?: string; pending_author_job?: string; pending_final_review?: string; }

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", `${label} must be an object.`); return value as Record<string, unknown>; }
function closed(value: Record<string, unknown>, allowed: readonly string[], label: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", `${label} contains unknown field '${key}'.`); }
function text(value: unknown, label: string, max = 16_384): string { if (typeof value !== "string" || value.length < 1 || value.length > max || /\0/.test(value)) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", `${label} is invalid.`); return value; }
function strings(value: unknown, label: string, maxItems = 256): string[] { if (!Array.isArray(value) || value.length > maxItems) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", `${label} must be a bounded array.`); return value.map((item, index) => text(item, `${label}[${index}]`, 4096)); }
function exactKeys(item: unknown, keys: readonly string[], label: string): Record<string, unknown> { const value = record(item, label); closed(value, keys, label); for (const key of keys) if (!(key in value)) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", `${label}.${key} is required.`); return value; }
function identifier(value: unknown, label: string): string { const result = text(value, label, 128); if (!ID.test(result)) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", `${label} is invalid.`); return result; }
function sha(value: unknown, label: string): string { const result = text(value, label, 64); if (!SHA.test(result)) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", `${label} must be lowercase SHA-256.`); return result; }
function bool(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", `${label} must be boolean.`); return value; }

function repository(value: unknown): RepositoryBinding {
  const r = exactKeys(value, ["repository_id", "base_branch", "base_commit"], "repository");
  return { repository_id: identifier(r.repository_id, "repository.repository_id"), base_branch: text(r.base_branch, "repository.base_branch", 256), base_commit: text(r.base_commit, "repository.base_commit", 64) };
}
function sources(value: unknown): WebSourceReceipt[] {
  if (!Array.isArray(value) || value.length > 128) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", "sources must be bounded.");
  return value.map((item, index) => { const r = exactKeys(item, ["url", "title", "accessed_at", "relevance"], `sources[${index}]`); return { url: text(r.url, "source.url", 2048), title: text(r.title, "source.title", 512), accessed_at: text(r.accessed_at, "source.accessed_at", 64), relevance: text(r.relevance, "source.relevance", 4096) }; });
}

export function parseWebContractEnvelope(input: unknown): WebContractEnvelope {
  const keys = ["protocol_version", "job_id", "repository", "user_intent", "title", "goal", "non_goals", "architecture_decisions", "allowed_paths", "forbidden_paths", "acceptance_criteria", "verification_commands", "risk_policy", "delivery", "sources", "implementation_strategy", "project_map_hints"] as const;
  const r = exactKeys(input, keys, "Web Contract Envelope");
  if (r.protocol_version !== WEB_BRIDGE_PROTOCOL_VERSION) throw new WebBridgeError("WEB_BRIDGE_PROTOCOL_UNSUPPORTED", "Unsupported Web bridge protocol version.");
  if (!Array.isArray(r.acceptance_criteria) || r.acceptance_criteria.length < 1 || r.acceptance_criteria.length > 128) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", "acceptance_criteria must be a non-empty bounded array.");
  const acceptance_criteria = r.acceptance_criteria.map((item, i) => { const v = exactKeys(item, ["id", "description"], `acceptance_criteria[${i}]`); return { id: identifier(v.id, "criterion.id"), description: text(v.description, "criterion.description", 4096) }; });
  if (!Array.isArray(r.verification_commands) || r.verification_commands.length < 1 || r.verification_commands.length > 64) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", "verification_commands must be a non-empty bounded array.");
  const verification_commands = r.verification_commands.map((item, i) => { const v = exactKeys(item, ["id", "executable", "args"], `verification_commands[${i}]`); return { id: identifier(v.id, "command.id"), executable: text(v.executable, "command.executable", 128), args: strings(v.args, "command.args", 128) }; });
  const risk = exactKeys(r.risk_policy, ["network_access", "secrets_required", "notes"], "risk_policy");
  const delivery = exactKeys(r.delivery, ["remote", "base_branch", "branch_name", "draft", "auto_merge"], "delivery");
  if (delivery.draft !== true || delivery.auto_merge !== false) throw new WebBridgeError("WEB_BRIDGE_POLICY_CONFLICT", "Delivery must remain Draft PR with auto_merge false.");
  return { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, job_id: identifier(r.job_id, "job_id"), repository: repository(r.repository), user_intent: text(r.user_intent, "user_intent"), title: text(r.title, "title", 256), goal: text(r.goal, "goal"), non_goals: strings(r.non_goals, "non_goals"), architecture_decisions: strings(r.architecture_decisions, "architecture_decisions"), allowed_paths: strings(r.allowed_paths, "allowed_paths"), forbidden_paths: strings(r.forbidden_paths, "forbidden_paths"), acceptance_criteria, verification_commands, risk_policy: { network_access: bool(risk.network_access, "risk_policy.network_access"), secrets_required: bool(risk.secrets_required, "risk_policy.secrets_required"), notes: strings(risk.notes, "risk_policy.notes") }, delivery: { remote: text(delivery.remote, "delivery.remote", 128), base_branch: text(delivery.base_branch, "delivery.base_branch", 256), branch_name: text(delivery.branch_name, "delivery.branch_name", 256), draft: true, auto_merge: false }, sources: sources(r.sources), implementation_strategy: strings(r.implementation_strategy, "implementation_strategy"), project_map_hints: strings(r.project_map_hints, "project_map_hints") };
}

export function parseWebImplementationSubmission(input: unknown): WebImplementationSubmission {
  const r = exactKeys(input, ["protocol_version", "job_id", "run_id", "contract_only", "summary", "operations", "project_map", "sources"], "Web implementation submission");
  if (r.protocol_version !== WEB_BRIDGE_PROTOCOL_VERSION) throw new WebBridgeError("WEB_BRIDGE_PROTOCOL_UNSUPPORTED", "Unsupported Web bridge protocol version.");
  if (!Array.isArray(r.operations) || r.operations.length > 256) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", "operations must be bounded.");
  const operations = r.operations.map((item, index): WebImplementationOperation => {
    const base = record(item, `operations[${index}]`);
    if (base.kind === "delete") { const value = exactKeys(base, ["kind", "path"], `operations[${index}]`); return { kind: "delete", path: text(value.path, "operation.path", 4096) }; }
    if (base.kind !== "create" && base.kind !== "replace") throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", "Operation kind is invalid.");
    const value = exactKeys(base, ["kind", "path", "content_base64", "content_sha256"], `operations[${index}]`);
    const encoded = text(value.content_base64, "operation.content_base64", 12_000_000);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || crypto.createHash("sha256").update(bytes).digest("hex") !== value.content_sha256) throw new WebBridgeError("WEB_BRIDGE_PAYLOAD_INVALID", "Operation payload encoding or digest is invalid.");
    return { kind: base.kind, path: text(value.path, "operation.path", 4096), content_base64: encoded, content_sha256: sha(value.content_sha256, "operation.content_sha256") };
  });
  if (!Array.isArray(r.project_map) || r.project_map.length > 10_000) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", "project_map must be bounded.");
  const project_map = r.project_map.map((item, index) => { const value = exactKeys(item, ["path", "purpose"], `project_map[${index}]`); return { path: text(value.path, "project_map.path", 4096), purpose: text(value.purpose, "project_map.purpose", 4096) }; });
  const contract_only = bool(r.contract_only, "contract_only");
  if (contract_only && operations.length !== 0 || !contract_only && operations.length === 0) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", "contract_only and operations are inconsistent.");
  return { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, job_id: identifier(r.job_id, "job_id"), run_id: text(r.run_id, "run_id", 256), contract_only, summary: text(r.summary, "summary"), operations, project_map, sources: sources(r.sources) };
}

export function parseWebVerdictEnvelope(input: unknown): WebVerdictEnvelope {
  const r = exactKeys(input, ["protocol_version", "review_id", "run_id", "result_bundle_sha256", "verdict", "summary", "findings"], "Web verdict envelope");
  if (r.protocol_version !== WEB_BRIDGE_PROTOCOL_VERSION) throw new WebBridgeError("WEB_BRIDGE_PROTOCOL_UNSUPPORTED", "Unsupported Web bridge protocol version.");
  if (!["APPROVE", "REVISE", "BLOCK"].includes(String(r.verdict)) || !Array.isArray(r.findings) || r.findings.length > 256) throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", "Verdict or findings are invalid.");
  const findings = r.findings.map((item, index) => { const value = exactKeys(item, ["id", "severity", "description"], `findings[${index}]`); if (value.severity !== "blocking" && value.severity !== "non_blocking") throw new WebBridgeError("WEB_BRIDGE_SCHEMA_INVALID", "Finding severity is invalid."); return { id: identifier(value.id, "finding.id"), severity: value.severity as "blocking" | "non_blocking", description: text(value.description, "finding.description", 8192) }; });
  return { protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, review_id: identifier(r.review_id, "review_id"), run_id: text(r.run_id, "run_id", 256), result_bundle_sha256: sha(r.result_bundle_sha256, "result_bundle_sha256"), verdict: r.verdict as WebVerdictEnvelope["verdict"], summary: text(r.summary, "summary"), findings };
}

export function contentDigest(value: unknown): string { return crypto.createHash("sha256").update(canonicalJsonBuffer(value)).digest("hex"); }
export function assertSha256(value: unknown, label: string): string { return sha(value, label); }
