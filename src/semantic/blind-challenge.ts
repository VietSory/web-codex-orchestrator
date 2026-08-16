import crypto from "node:crypto";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { parseRepositoryCommand, type RepositoryBinding, type RepositoryCommand } from "../web-bridge/contracts.js";
import { buildSemanticEvidenceIndex, type SemanticEvidenceIndex, type SemanticEvidenceObservationInput } from "./evidence-index.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const MAX_GOAL_BYTES = 65_536;
const MAX_FINDINGS = 128;
const MAX_CITATIONS = 32;
const MAX_PATH_BYTES = 4096;
const MAX_TEXT_BYTES = 8192;
const MAX_PROMPT_BYTES = 128 * 1024;

export type SemanticFindingCategory = "component" | "invariant" | "risk" | "unknown" | "assumption";

export interface SemanticChallengeRequest {
  schema_version: "1.0";
  kind: "wco-semantic-blind-challenge";
  challenge_id: string;
  repository: RepositoryBinding;
  original_goal: string;
}

export interface SemanticChallengeEvidence {
  schema_version: "1.0";
  kind: "wco-semantic-challenge-evidence";
  challenge_id: string;
  repository: RepositoryBinding;
  evidence_index: SemanticEvidenceIndex;
  challenge_evidence_sha256: string;
}

export interface SemanticEvidenceCitation {
  path: string;
  content_sha256: string;
  start_byte: number;
  end_byte_exclusive: number;
}

export interface SemanticChallengeFinding {
  finding_id: string;
  category: SemanticFindingCategory;
  statement: string;
  citations: SemanticEvidenceCitation[];
}

export interface SemanticUnderstandingEnvelope {
  schema_version: "1.0";
  kind: "semantic_understanding_sealed";
  challenge_id: string;
  repository: RepositoryBinding;
  original_goal_sha256: string;
  findings: SemanticChallengeFinding[];
  unresolved_questions: string[];
}

export type SemanticChallengeAction =
  | { kind: "repository_command"; command: RepositoryCommand }
  | { kind: "semantic_understanding_sealed"; envelope: SemanticUnderstandingEnvelope };

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJsonBuffer(value)).digest("hex");
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} contains unexpected field '${key}'.`);
  for (const key of required) if (!(key in value)) throw new Error(`${label}.${key} is required.`);
}

function boundedText(value: unknown, label: string, maximumBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${label} is invalid or exceeds its byte bound.`);
  return value;
}

function safeId(value: unknown, label: string): string {
  const text = boundedText(value, label, 128);
  if (!SAFE_ID.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value as number;
}

function parseRepository(value: unknown, label: string): RepositoryBinding {
  const object = objectValue(value, label);
  exactKeys(object, ["repository_id", "base_branch", "base_commit"], ["repository_id", "base_branch", "base_commit"], label);
  const repository_id = safeId(object.repository_id, `${label}.repository_id`);
  const base_branch = boundedText(object.base_branch, `${label}.base_branch`, 256);
  const base_commit = boundedText(object.base_commit, `${label}.base_commit`, 40);
  if (!GIT_SHA.test(base_commit)) throw new Error(`${label}.base_commit must be a lowercase 40-character Git object ID.`);
  return { repository_id, base_branch, base_commit };
}

function sameRepository(left: RepositoryBinding, right: RepositoryBinding): boolean {
  return left.repository_id === right.repository_id && left.base_branch === right.base_branch && left.base_commit === right.base_commit;
}

function safePath(value: unknown, label: string): string {
  const text = boundedText(value, label, MAX_PATH_BYTES);
  if (text.startsWith("/") || text.includes("\\") || /^[A-Za-z]:/.test(text)) throw new Error(`${label} must be a canonical repository-relative path.`);
  const normalized = path.posix.normalize(text);
  if (normalized !== text || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error(`${label} must be a canonical repository-relative path.`);
  return text;
}

function parseCitation(value: unknown, label: string): SemanticEvidenceCitation {
  const object = objectValue(value, label);
  exactKeys(object, ["path", "content_sha256", "start_byte", "end_byte_exclusive"], ["path", "content_sha256", "start_byte", "end_byte_exclusive"], label);
  const citationPath = safePath(object.path, `${label}.path`);
  const content_sha256 = boundedText(object.content_sha256, `${label}.content_sha256`, 64);
  if (!SHA256.test(content_sha256)) throw new Error(`${label}.content_sha256 must be lowercase SHA-256.`);
  const start_byte = safeInteger(object.start_byte, `${label}.start_byte`);
  const end_byte_exclusive = safeInteger(object.end_byte_exclusive, `${label}.end_byte_exclusive`);
  if (end_byte_exclusive <= start_byte) throw new Error(`${label} must describe a non-empty byte region.`);
  return { path: citationPath, content_sha256, start_byte, end_byte_exclusive };
}

function parseFinding(value: unknown, label: string): SemanticChallengeFinding {
  const object = objectValue(value, label);
  exactKeys(object, ["finding_id", "category", "statement", "citations"], ["finding_id", "category", "statement", "citations"], label);
  const finding_id = safeId(object.finding_id, `${label}.finding_id`);
  const category = object.category;
  if (!(["component", "invariant", "risk", "unknown", "assumption"] as const).includes(category as SemanticFindingCategory)) throw new Error(`${label}.category is invalid.`);
  const statement = boundedText(object.statement, `${label}.statement`);
  if (!Array.isArray(object.citations) || object.citations.length > MAX_CITATIONS) throw new Error(`${label}.citations must contain at most ${MAX_CITATIONS} exact evidence references.`);
  const citations = object.citations.map((entry, index) => parseCitation(entry, `${label}.citations[${index}]`));
  if (category !== "unknown" && citations.length === 0) throw new Error(`${label} must cite exact repository evidence unless it is an unresolved unknown.`);
  return { finding_id, category: category as SemanticFindingCategory, statement, citations };
}

function challengeEvidencePayload(value: Omit<SemanticChallengeEvidence, "challenge_evidence_sha256"> | SemanticChallengeEvidence): unknown {
  return {
    schema_version: value.schema_version,
    kind: value.kind,
    challenge_id: value.challenge_id,
    repository: value.repository,
    evidence_index_sha256: value.evidence_index.evidence_index_sha256,
  };
}

function evidenceIndexPayload(index: SemanticEvidenceIndex): unknown {
  return {
    schema_version: index.schema_version,
    kind: index.kind,
    repository: index.repository,
    observations: index.observations,
  };
}

export function buildSemanticChallengeEvidence(options: { request: SemanticChallengeRequest; observations: readonly SemanticEvidenceObservationInput[] }): SemanticChallengeEvidence {
  const evidence_index = buildSemanticEvidenceIndex({ repository: options.request.repository, observations: options.observations });
  const payload = {
    schema_version: "1.0" as const,
    kind: "wco-semantic-challenge-evidence" as const,
    challenge_id: options.request.challenge_id,
    repository: options.request.repository,
    evidence_index,
  };
  return { ...payload, challenge_evidence_sha256: digest(challengeEvidencePayload(payload)) };
}

function assertChallengeEvidenceBinding(evidence: SemanticChallengeEvidence, request: SemanticChallengeRequest): void {
  if (!evidence || evidence.schema_version !== "1.0" || evidence.kind !== "wco-semantic-challenge-evidence") throw new Error("semantic challenge requires exact challenge-scoped evidence.");
  if (evidence.challenge_id !== request.challenge_id) throw new Error("semantic challenge evidence belongs to another challenge.");
  if (!evidence.evidence_index || evidence.evidence_index.schema_version !== "1.0" || evidence.evidence_index.kind !== "wco-semantic-evidence-index") throw new Error("semantic challenge evidence index kind/version is invalid.");
  if (!sameRepository(evidence.repository, request.repository) || !sameRepository(evidence.evidence_index.repository, request.repository)) throw new Error("semantic challenge evidence repository binding drifted from the challenge.");
  const expectedIndexDigest = digest(evidenceIndexPayload(evidence.evidence_index));
  if (!SHA256.test(evidence.evidence_index.evidence_index_sha256) || evidence.evidence_index.evidence_index_sha256 !== expectedIndexDigest) throw new Error("semantic challenge evidence index changed after validation.");
  const expected = digest(challengeEvidencePayload(evidence));
  if (!SHA256.test(evidence.challenge_evidence_sha256) || evidence.challenge_evidence_sha256 !== expected) throw new Error("semantic challenge evidence receipt digest is invalid.");
}

function citationKey(citation: SemanticEvidenceCitation): string {
  return `${citation.path}\u0000${citation.content_sha256}\u0000${citation.start_byte}\u0000${citation.end_byte_exclusive}`;
}

function observedCitationKeys(index: SemanticEvidenceIndex): Set<string> {
  const keys = new Set<string>();
  for (const observation of index.observations) {
    if (observation.result.kind !== "read") continue;
    for (const file of observation.result.files) {
      keys.add(citationKey({ path: file.path, content_sha256: file.content_sha256, start_byte: file.start_byte, end_byte_exclusive: file.end_byte_exclusive }));
    }
  }
  return keys;
}

function assertFindingCitationsObserved(findings: readonly SemanticChallengeFinding[], index: SemanticEvidenceIndex): void {
  const observed = observedCitationKeys(index);
  for (const finding of findings) {
    for (const citation of finding.citations) {
      if (!observed.has(citationKey(citation))) throw new Error(`semantic finding '${finding.finding_id}' cites evidence that was not observed by the challenger.`);
    }
  }
}

export function createSemanticChallengeRequest(input: { challengeId: string; repository: RepositoryBinding; originalGoal: string }): SemanticChallengeRequest {
  const challenge_id = safeId(input.challengeId, "challenge_id");
  const repository = parseRepository(input.repository, "repository");
  const original_goal = boundedText(input.originalGoal, "original_goal", MAX_GOAL_BYTES);
  return { schema_version: "1.0", kind: "wco-semantic-blind-challenge", challenge_id, repository, original_goal };
}

export function parseSemanticChallengeAction(value: unknown, request: SemanticChallengeRequest, challengeEvidence?: SemanticChallengeEvidence): SemanticChallengeAction {
  const object = objectValue(value, "semantic challenge action");
  exactKeys(object, ["kind", "command", "envelope"], ["kind"], "semantic challenge action");
  if (object.kind === "repository_command") {
    if (!("command" in object) || "envelope" in object) throw new Error("repository_command action must contain command only.");
    return { kind: "repository_command", command: parseRepositoryCommand(object.command) };
  }
  if (object.kind !== "semantic_understanding_sealed") throw new Error("semantic challenge action kind is invalid.");
  if (!("envelope" in object) || "command" in object) throw new Error("semantic_understanding_sealed action must contain envelope only.");
  if (!challengeEvidence) throw new Error("semantic understanding cannot seal without exact challenge-scoped evidence.");
  assertChallengeEvidenceBinding(challengeEvidence, request);
  const envelope = objectValue(object.envelope, "semantic understanding envelope");
  exactKeys(envelope, ["schema_version", "kind", "challenge_id", "repository", "original_goal_sha256", "findings", "unresolved_questions"], ["schema_version", "kind", "challenge_id", "repository", "original_goal_sha256", "findings", "unresolved_questions"], "semantic understanding envelope");
  if (envelope.schema_version !== "1.0" || envelope.kind !== "semantic_understanding_sealed") throw new Error("semantic understanding envelope version/kind is invalid.");
  const challenge_id = safeId(envelope.challenge_id, "semantic understanding envelope.challenge_id");
  if (challenge_id !== request.challenge_id) throw new Error("semantic understanding envelope is bound to another challenge.");
  const repository = parseRepository(envelope.repository, "semantic understanding envelope.repository");
  if (!sameRepository(repository, request.repository)) throw new Error("semantic understanding envelope repository binding drifted from the challenge.");
  const original_goal_sha256 = boundedText(envelope.original_goal_sha256, "semantic understanding envelope.original_goal_sha256", 64);
  if (!SHA256.test(original_goal_sha256) || original_goal_sha256 !== digest(request.original_goal)) throw new Error("semantic understanding envelope is not bound to the exact original goal.");
  if (!Array.isArray(envelope.findings) || envelope.findings.length < 1 || envelope.findings.length > MAX_FINDINGS) throw new Error(`semantic understanding envelope.findings must contain 1-${MAX_FINDINGS} items.`);
  const findings = envelope.findings.map((entry, index) => parseFinding(entry, `semantic understanding envelope.findings[${index}]`));
  if (new Set(findings.map((item) => item.finding_id)).size !== findings.length) throw new Error("semantic understanding envelope contains duplicate finding IDs.");
  assertFindingCitationsObserved(findings, challengeEvidence.evidence_index);
  if (!Array.isArray(envelope.unresolved_questions) || envelope.unresolved_questions.length > 64) throw new Error("semantic understanding envelope.unresolved_questions exceeds its bound.");
  const unresolved_questions = envelope.unresolved_questions.map((entry, index) => boundedText(entry, `semantic understanding envelope.unresolved_questions[${index}]`, 4096));
  if (findings.some((finding) => finding.category === "unknown") && unresolved_questions.length === 0) throw new Error("semantic understanding with unknown findings must preserve unresolved questions explicitly.");
  return {
    kind: "semantic_understanding_sealed",
    envelope: { schema_version: "1.0", kind: "semantic_understanding_sealed", challenge_id, repository, original_goal_sha256, findings, unresolved_questions },
  };
}

export function semanticChallengePrompt(request: SemanticChallengeRequest): string {
  const prompt = [
    "WCO_SEMANTIC_BLIND_CHALLENGE_V1",
    "You are an independent senior-maintainer semantic challenger. You have no mutation, shell, Git, publish, review-verdict, or merge authority.",
    "You have intentionally NOT been shown Web-A's candidate contract, architecture decisions, implementation strategy, allowed paths, acceptance criteria, or proposed solution. Do not ask for them and do not infer that they exist.",
    "Your task is to independently determine what the repository currently does and what must remain true for the original user goal to be implemented safely.",
    "Use bounded repository_command actions to inspect exact repository evidence. Do not assume unseen files, call paths, state transitions, recovery behavior, concurrency semantics, security boundaries, compatibility, or performance characteristics.",
    "Trace relevant callers/callees and state/authority boundaries far enough to identify material blast radius. Treat tests and docs as evidence, never as proof by themselves.",
    "Challenge unsupported assumptions. Record unresolved material questions instead of inventing facts. Do not design or approve Web-A's solution in this phase.",
    "Return exactly one JSON object per turn using one of two closed shapes:",
    '{"kind":"repository_command","command":<RepositoryCommand>}',
    '{"kind":"semantic_understanding_sealed","envelope":{"schema_version":"1.0","kind":"semantic_understanding_sealed","challenge_id":"...","repository":{...},"original_goal_sha256":"...","findings":[...],"unresolved_questions":[...]}}',
    "Each finding has exactly finding_id, category, statement, citations. category is component, invariant, risk, unknown, or assumption. Non-unknown findings must cite at least one exact read region with path, content_sha256, start_byte and end_byte_exclusive.",
    "Every citation is validated against exact read evidence actually observed in this challenge. Never invent a path, digest, or byte range. Unknown findings must remain explicit in unresolved_questions.",
    "Seal only an understanding of the problem/current system. Never output APPROVE, REVISE, BLOCK, repair operations, implementation operations, candidate paths, or a proposed code change.",
    `Challenge identity: ${request.challenge_id}`,
    `Repository binding: ${JSON.stringify(request.repository)}`,
    `Original goal SHA-256: ${digest(request.original_goal)}`,
    `Original user goal: ${request.original_goal}`,
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("Semantic challenge prompt exceeds the bounded prompt budget.");
  return prompt;
}
