import { MAINTAINER_AUTHORING_STANDARD, MAINTAINER_REVIEW_STANDARD } from "../shared/maintainer-reasoning-standard.js";
import { WEB_BRIDGE_PROTOCOL_VERSION, type FinalReviewRequest } from "./contracts.js";
import { assertChatGptCodexReviewEvidenceBinding } from "./chatgpt-codex-review-evidence.js";
import { CHATGPT_CODEX_AUTHOR_PHASE_MARKER, CHATGPT_CODEX_REVIEW_PHASE_MARKER } from "./chatgpt-codex-semantic-client.js";
import { prepareRepositoryResultForSemanticPrompt } from "./repository-result-semantic-context.js";
import type { AuthoringJobRequest } from "./web-bridge.js";

function boundedJson(value: unknown, maximum = 512_000): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maximum) throw new Error("WEB_CHATGPT_CODEX_CONTEXT_TOO_LARGE: semantic context exceeded the local bounded prompt budget.");
  return encoded;
}

function authorPayloadContract(request: AuthoringJobRequest, jobId: string): string { return [
  "The payload_json field is a JSON-encoded object, not a shell/tool request or prose.",
  "For kind=repository_command, payload_json must be exactly one of these closed shapes:",
  '{"operation":"summary"}',
  '{"operation":"tree"} or {"operation":"tree","prefix":"src","maximum_paths":100}; prefix and maximum_paths are optional.',
  '{"operation":"search","query":"healthStatus"} or the same object with optional integer maximum_matches.',
  '{"operation":"read","paths":["package.json","README.md"]}; optional known_content_sha256 maps paths to lowercase SHA-256.',
  '{"operation":"read","regions":[{"path":"src/app.js","start_byte":0,"end_byte_exclusive":1024}]}; optional known_content_sha256 maps paths to lowercase SHA-256.',
  "Never put repository_id, commands, argv, shell, purpose, or limits in a repository_command payload.",
  "For kind=contract_sealed, payload_json must be one closed WebContractEnvelope object with exactly these fields:",
  "protocol_version, job_id, repository, user_intent, title, goal, non_goals, architecture_decisions, allowed_paths, forbidden_paths, acceptance_criteria, verification_commands, risk_policy, delivery, sources, implementation_strategy, project_map_hints.",
  `protocol_version must be exactly ${JSON.stringify(WEB_BRIDGE_PROTOCOL_VERSION)} and job_id must be exactly ${JSON.stringify(jobId)}.`,
  `repository must equal ${boundedJson(request.repository)} and user_intent must equal ${JSON.stringify(request.user_intent)} exactly.`,
  "repository has exactly repository_id, base_branch, base_commit; acceptance_criteria items have exactly id, description; verification_commands items have exactly id, executable, args; risk_policy has exactly network_access, secrets_required, notes; delivery has exactly remote, base_branch, branch_name, draft, auto_merge; source items have exactly url, title, accessed_at, relevance.",
  "title and goal are strings. non_goals, architecture_decisions, allowed_paths, forbidden_paths, implementation_strategy, and project_map_hints are string arrays. acceptance_criteria and verification_commands are non-empty arrays. sources and risk_policy.notes are arrays, even when empty.",
  `delivery.remote must be "origin", delivery.base_branch must be ${JSON.stringify(request.repository.base_branch)}, delivery.branch_name must be a new git-check-ref-format-safe branch starting with "codex/", delivery.draft must be true, and delivery.auto_merge must be false.`,
].join("\n"); }

function authorFollowUpContract(request: AuthoringJobRequest, jobId: string): string { return [
  "Continue the same AUTHOR thread and the exact closed payload contract from the initial turn; do not reinterpret or widen it.",
  `If sealing, protocol_version=${JSON.stringify(WEB_BRIDGE_PROTOCOL_VERSION)}, job_id=${JSON.stringify(jobId)}, repository=${boundedJson(request.repository)}, and user_intent=${JSON.stringify(request.user_intent)} must remain exact.`,
  `Delivery remains remote="origin", base_branch=${JSON.stringify(request.repository.base_branch)}, a new codex/* branch, draft=true, auto_merge=false.`,
  "If more context is needed, request only the next bounded repository_command. Never request shell/Git mutation, secrets, network tools, implementation authority, or a verdict.",
].join("\n"); }

function authorFollowUpReasoningReminder(): string {
  return "Continue applying the senior-maintainer authoring standard from the initial turn: resolve material assumptions from exact repository evidence, trace affected execution/state boundaries far enough to understand blast radius, and never seal merely because tests, docs, or an earlier summary look convincing.";
}

function reviewPayloadContract(request: FinalReviewRequest, reviewId: string): string { return [
  "For kind=web_verdict, payload_json is a JSON-encoded closed WebVerdictEnvelope object, not prose.",
  "It must contain exactly protocol_version, review_id, run_id, result_bundle_sha256, verdict, summary, findings, plus optional repair_operations.",
  `protocol_version must be exactly ${JSON.stringify(WEB_BRIDGE_PROTOCOL_VERSION)}, review_id must be exactly ${JSON.stringify(reviewId)}, run_id must be exactly ${JSON.stringify(request.run_id)}, and result_bundle_sha256 must be exactly ${JSON.stringify(request.result_bundle_sha256)}.`,
  "verdict is APPROVE, REVISE, or BLOCK. Each finding has exactly id, severity, description; severity is blocking or non_blocking.",
  "Only REVISE may include repair_operations. Each repair operation has exactly op_id, kind, path, preimage_sha256, postimage_base64, postimage_sha256; kind is create_file, replace_file, or delete_file.",
].join("\n"); }

function reviewRepositoryContract(request: FinalReviewRequest): string { return [
  "If exact change evidence is insufficient to resolve a material code question, return kind=repository_command instead of guessing or approving.",
  `Every review repository_command is executed read-only against the exact immutable published commit ${JSON.stringify(request.published_commit_sha)}; it can never change repository state or review authority.`,
  "repository_command payload_json must be exactly one of these closed shapes:",
  '{"operation":"summary"}',
  '{"operation":"tree"} or {"operation":"tree","prefix":"src","maximum_paths":100}.',
  '{"operation":"search","query":"symbolName"} or the same object with optional integer maximum_matches.',
  '{"operation":"read","paths":["src/file.ts"]}; optional known_content_sha256 maps paths to lowercase SHA-256.',
  '{"operation":"read","regions":[{"path":"src/file.ts","start_byte":0,"end_byte_exclusive":4096}]}; optional known_content_sha256 maps paths to lowercase SHA-256.',
  "Request only the smallest exact search/read needed to trace changed behavior, callers, invariants, error paths, recovery/concurrency boundaries, or missing tests. Never request shell, Git mutation, secrets, network tools, publish, or merge authority.",
].join("\n"); }

export function chatGptCodexAuthorPrompt(request: AuthoringJobRequest, jobId: string): string {
  return [
    CHATGPT_CODEX_AUTHOR_PHASE_MARKER,
    "You are WCO's semantic architect. You have no repository mutation authority.",
    MAINTAINER_AUTHORING_STANDARD,
    "Return exactly one structured provider envelope matching the supplied output schema.",
    "Allowed author actions are repository_command or contract_sealed only. Never return implementation_sealed or web_verdict during authoring.",
    "Inspect repository content only through bounded WCO RepositoryCommand requests. Do not assume unseen files.",
    authorPayloadContract(request, jobId),
    "When enough exact evidence exists, seal a complete WebContractEnvelope. Delivery must remain Draft PR with auto_merge=false.",
    "Never request secrets, deployment, merge, force-push, direct shell access, or direct Git mutation.",
    `Repository binding: ${boundedJson(request.repository)}`,
    `User intent: ${request.user_intent}`,
    `Mode: ${request.orchestration_mode ?? "PAIR"}`,
  ].join("\n");
}

export function chatGptCodexRepositoryResultPrompt(result: unknown, request: AuthoringJobRequest, jobId: string): string {
  return [
    CHATGPT_CODEX_AUTHOR_PHASE_MARKER,
    "WCO executed your exact bounded repository request. Treat this result as authoritative only for the requested repository evidence.",
    boundedJson(prepareRepositoryResultForSemanticPrompt(result)),
    authorFollowUpContract(request, jobId),
    authorFollowUpReasoningReminder(),
    "Return the next repository_command if more exact context is required; otherwise return contract_sealed. Never return implementation_sealed or web_verdict.",
  ].join("\n");
}

export function chatGptCodexClarificationPrompt(clarification: unknown, request: AuthoringJobRequest, jobId: string): string {
  return [
    CHATGPT_CODEX_AUTHOR_PHASE_MARKER,
    "The user added a clarification to the same unsealed AUTHOR task. Incorporate it without changing task identity or widening authority.",
    `User clarification: ${boundedJson(clarification, 65_536)}`,
    authorFollowUpContract(request, jobId),
    authorFollowUpReasoningReminder(),
    "Use bounded repository_command evidence if the clarification creates a new material assumption; otherwise continue toward contract_sealed. Never return implementation_sealed or web_verdict.",
  ].join("\n");
}

export function chatGptCodexReviewPrompt(request: FinalReviewRequest, evidence: Record<string, unknown>, reviewId: string): string {
  assertChatGptCodexReviewEvidenceBinding(request, evidence);
  return [
    CHATGPT_CODEX_REVIEW_PHASE_MARKER,
    "You are WCO's independent semantic reviewer. You have no mutation, shell, Git, publish, or merge authority.",
    MAINTAINER_REVIEW_STANDARD,
    "When this evidence is for independent_code_review, independently derive correctness from the exact change evidence instead of inheriting the author's conclusions. When it is for final_intent_review, re-check the final result against the original user intent, frozen architecture/acceptance authority, and end-to-end behavior even if an earlier reviewer approved.",
    "Allowed review actions are repository_command or web_verdict only. If a material correctness question depends on unchanged/out-of-diff code, do not guess from the diff: request the minimum exact repository context first.",
    reviewRepositoryContract(request),
    "APPROVE only when the final Draft PR evidence satisfies the sealed intent and verification and no material question remains unresolved. REVISE/BLOCK must contain concrete bounded findings.",
    reviewPayloadContract(request, reviewId),
    `Review request: ${boundedJson(request)}`,
    `Exact review evidence: ${boundedJson(evidence)}`,
  ].join("\n");
}

/**
 * Continue the same provider thread after one bounded repository lookup. The
 * large Result Bundle evidence intentionally stays in the thread instead of
 * being retransmitted on every lookup, keeping exact-context review cheaper
 * than manual full-context copy/paste loops.
 */
export function chatGptCodexReviewRepositoryResultPrompt(result: unknown, request: FinalReviewRequest, reviewId: string): string {
  return [
    CHATGPT_CODEX_REVIEW_PHASE_MARKER,
    "Continue the same REVIEW thread. WCO executed your bounded read-only repository request against the exact published commit from the initial review.",
    `Repository result: ${boundedJson(prepareRepositoryResultForSemanticPrompt(result), 192_000)}`,
    "Keep applying the senior-maintainer review standard from the initial turn. Do not inherit implementation claims or treat green tests as proof.",
    "Allowed actions remain repository_command or web_verdict. Request another bounded lookup only for a still-material unresolved question; otherwise decide the verdict now.",
    reviewRepositoryContract(request),
    reviewPayloadContract(request, reviewId),
  ].join("\n");
}
