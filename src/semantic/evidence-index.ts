import crypto from "node:crypto";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { parseRepositoryCommand, type RepositoryBinding, type RepositoryCommand } from "../web-bridge/contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_OBSERVATIONS = 128;
const MAX_INDEXED_PATHS = 256;
const MAX_INDEX_BYTES = 1_048_576;
const MAX_TRANSMITTED_BASE64_CHARS = 100_000;
const SENSITIVE_PATHS = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)[^/]*\.(pem|key)$/i,
  /(^|\/)id_rsa[^/]*$/i,
  /(^|\/)(credentials|secrets?)[^/]*$/i,
  /(^|\/)\.git(\/|$)/i,
] as const;

export interface SemanticEvidenceObservationInput {
  sequence: number;
  request_id: string;
  command: RepositoryCommand | unknown;
  result: unknown;
}

export interface SemanticEvidenceMetrics {
  context_bytes_prepared: number;
  context_bytes_transmitted: number;
  repeated_bytes_avoided: number;
  files_considered: number;
  files_read: number;
  regions_read: number;
  cache_hits: number;
  cache_misses: number;
}

export type SemanticEvidenceResult =
  | {
      kind: "summary";
      repository_id: string;
      base_branch: string;
      base_commit: string;
      tree_sha: string;
    }
  | {
      kind: "tree" | "search";
      returned_path_count: number;
      indexed_paths: string[];
      indexed_paths_truncated: boolean;
      source_truncated: boolean;
      all_paths_sha256: string;
    }
  | {
      kind: "read";
      files: Array<{
        path: string;
        content_sha256: string;
        blob_sha: string;
        size_bytes: number;
        start_byte: number;
        end_byte_exclusive: number;
        total_bytes: number;
        content_reference: string | null;
        content_transmitted: boolean;
      }>;
      metrics: SemanticEvidenceMetrics;
    };

export interface SemanticEvidenceObservation {
  sequence: number;
  request_id: string;
  operation: RepositoryCommand["operation"];
  command: RepositoryCommand;
  command_sha256: string;
  result: SemanticEvidenceResult;
  normalized_result_sha256: string;
  observation_sha256: string;
}

export interface SemanticEvidenceIndex {
  schema_version: "1.0";
  kind: "wco-semantic-evidence-index";
  repository: RepositoryBinding;
  observations: SemanticEvidenceObservation[];
  evidence_index_sha256: string;
}

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

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) throw new Error(`${label} is invalid.`);
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} must be a bounded safe integer.`);
  return value as number;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function sha256(value: unknown, label: string): string {
  const result = boundedText(value, label, 64);
  if (!SHA256.test(result)) throw new Error(`${label} must be lowercase SHA-256.`);
  return result;
}

function gitSha(value: unknown, label: string): string {
  const result = boundedText(value, label, 40);
  if (!GIT_SHA.test(result)) throw new Error(`${label} must be a lowercase 40-character Git object ID.`);
  return result;
}

function safeRepositoryPath(value: unknown, label: string): string {
  const result = boundedText(value, label, 4096);
  if (result.includes("\\") || result.startsWith("/") || /^[A-Za-z]:/.test(result)) throw new Error(`${label} is not a safe repository-relative path.`);
  const normalized = path.posix.normalize(result);
  if (normalized !== result || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error(`${label} is not canonical.`);
  if (SENSITIVE_PATHS.some((pattern) => pattern.test(result))) throw new Error(`${label} is denied by semantic evidence sensitive-path policy.`);
  return result;
}

function validateRepository(raw: RepositoryBinding): RepositoryBinding {
  if (!raw || typeof raw !== "object") throw new Error("repository binding is required.");
  const repository_id = boundedText(raw.repository_id, "repository.repository_id", 128);
  if (!SAFE_ID.test(repository_id)) throw new Error("repository.repository_id is invalid.");
  const base_branch = boundedText(raw.base_branch, "repository.base_branch", 256);
  const base_commit = gitSha(raw.base_commit, "repository.base_commit");
  return { repository_id, base_branch, base_commit };
}

function pathArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array with at most ${maximum} paths.`);
  const paths = value.map((entry, index) => safeRepositoryPath(entry, `${label}[${index}]`));
  if (new Set(paths).size !== paths.length) throw new Error(`${label} contains duplicate paths.`);
  return paths;
}

function normalizePathResult(value: unknown, label: string, kind: "tree" | "search", command: RepositoryCommand): SemanticEvidenceResult {
  const object = objectValue(value, label);
  const key = kind === "tree" ? "paths" : "matches";
  exactKeys(object, [key, "truncated"], [key, "truncated"], label);
  const paths = pathArray(object[key], `${label}.${key}`, kind === "tree" ? 5_000 : 500);
  const source_truncated = bool(object.truncated, `${label}.truncated`);
  if (kind === "tree" && command.operation === "tree" && command.prefix) {
    const prefix = safeRepositoryPath(command.prefix, "tree command prefix");
    for (const item of paths) if (item !== prefix && !item.startsWith(`${prefix}/`)) throw new Error(`${label} returned path '${item}' outside the requested tree prefix.`);
  }
  return {
    kind,
    returned_path_count: paths.length,
    indexed_paths: paths.slice(0, MAX_INDEXED_PATHS),
    indexed_paths_truncated: paths.length > MAX_INDEXED_PATHS,
    source_truncated,
    all_paths_sha256: digest(paths),
  };
}

function metrics(value: unknown): SemanticEvidenceMetrics {
  const object = objectValue(value, "read result.metrics");
  const keys = ["context_bytes_prepared", "context_bytes_transmitted", "repeated_bytes_avoided", "files_considered", "files_read", "regions_read", "cache_hits", "cache_misses"] as const;
  exactKeys(object, keys, keys, "read result.metrics");
  const result = Object.fromEntries(keys.map((key) => [key, safeInteger(object[key], `read result.metrics.${key}`)])) as unknown as SemanticEvidenceMetrics;
  if (result.context_bytes_transmitted > result.context_bytes_prepared) throw new Error("read result.metrics transmitted bytes exceed prepared bytes.");
  if (result.repeated_bytes_avoided > result.context_bytes_prepared) throw new Error("read result.metrics repeated bytes exceed prepared bytes.");
  return result;
}

function canonicalBase64(value: string, label: string): Buffer {
  if (value.length > MAX_TRANSMITTED_BASE64_CHARS) throw new Error(`${label} exceeds the bounded transmitted-content limit.`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} is not canonical base64.`);
  return bytes;
}

function normalizeReadResult(value: unknown, command: RepositoryCommand): SemanticEvidenceResult {
  if (command.operation !== "read") throw new Error("Internal semantic evidence read normalization mismatch.");
  const object = objectValue(value, "read result");
  exactKeys(object, ["files", "metrics"], ["files", "metrics"], "read result");
  if (!Array.isArray(object.files) || object.files.length < 1 || object.files.length > 32) throw new Error("read result.files must contain 1-32 exact file regions.");
  const expected = command.regions
    ? command.regions.map((region) => ({ path: safeRepositoryPath(region.path, "read command region.path"), start: region.start_byte, end: region.end_byte_exclusive }))
    : command.paths!.map((item) => ({ path: safeRepositoryPath(item, "read command path"), start: 0, end: -1 }));
  if (object.files.length !== expected.length) throw new Error("read result file count does not match the exact read command.");

  const files = object.files.map((raw, index) => {
    const item = objectValue(raw, `read result.files[${index}]`);
    exactKeys(
      item,
      ["path", "content_base64", "content_ref", "content_sha256", "blob_sha", "size_bytes", "start_byte", "end_byte_exclusive", "total_bytes"],
      ["path", "content_base64", "content_sha256", "blob_sha", "size_bytes", "start_byte", "end_byte_exclusive", "total_bytes"],
      `read result.files[${index}]`,
    );
    const filePath = safeRepositoryPath(item.path, `read result.files[${index}].path`);
    const contentSha = sha256(item.content_sha256, `read result.files[${index}].content_sha256`);
    const blobSha = gitSha(item.blob_sha, `read result.files[${index}].blob_sha`);
    const size = safeInteger(item.size_bytes, `read result.files[${index}].size_bytes`, 1, 1_048_576);
    const start = safeInteger(item.start_byte, `read result.files[${index}].start_byte`, 0, 1_048_575);
    const end = safeInteger(item.end_byte_exclusive, `read result.files[${index}].end_byte_exclusive`, 1, 1_048_576);
    const total = safeInteger(item.total_bytes, `read result.files[${index}].total_bytes`, 1, 1_048_576);
    if (end <= start || end - start !== size || end > total) throw new Error(`read result.files[${index}] byte range/size is inconsistent.`);

    const wanted = expected[index]!;
    if (filePath !== wanted.path || start !== wanted.start || wanted.end === -1 ? end !== total : end !== wanted.end) {
      throw new Error(`read result.files[${index}] does not bind the exact requested path/region.`);
    }

    if (typeof item.content_base64 !== "string") throw new Error(`read result.files[${index}].content_base64 must be a string.`);
    const contentBase64 = item.content_base64;
    let content_reference: string | null = null;
    let content_transmitted = false;
    if (contentBase64.length === 0) {
      if (typeof item.content_ref !== "string" || item.content_ref !== `sha256:${contentSha}`) throw new Error(`read result.files[${index}] empty content requires an exact SHA-256 content_ref.`);
      content_reference = item.content_ref;
    } else {
      if (item.content_ref !== undefined) throw new Error(`read result.files[${index}] cannot carry content_ref with transmitted bytes.`);
      const bytes = canonicalBase64(contentBase64, `read result.files[${index}].content_base64`);
      if (bytes.byteLength !== size) throw new Error(`read result.files[${index}] transmitted byte length does not match size_bytes.`);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== contentSha) throw new Error(`read result.files[${index}] transmitted bytes do not match content_sha256.`);
      content_transmitted = true;
    }

    return {
      path: filePath,
      content_sha256: contentSha,
      blob_sha: blobSha,
      size_bytes: size,
      start_byte: start,
      end_byte_exclusive: end,
      total_bytes: total,
      content_reference,
      content_transmitted,
    };
  });

  return { kind: "read", files, metrics: metrics(object.metrics) };
}

function normalizeResult(result: unknown, command: RepositoryCommand, repository: RepositoryBinding): SemanticEvidenceResult {
  if (command.operation === "summary") {
    const object = objectValue(result, "summary result");
    exactKeys(object, ["repository_id", "base_branch", "base_commit", "tree_sha"], ["repository_id", "base_branch", "base_commit", "tree_sha"], "summary result");
    const repository_id = boundedText(object.repository_id, "summary result.repository_id", 128);
    const base_branch = boundedText(object.base_branch, "summary result.base_branch", 256);
    const base_commit = gitSha(object.base_commit, "summary result.base_commit");
    const tree_sha = gitSha(object.tree_sha, "summary result.tree_sha");
    if (repository_id !== repository.repository_id || base_branch !== repository.base_branch || base_commit !== repository.base_commit) throw new Error("summary result does not bind the exact semantic evidence repository.");
    return { kind: "summary", repository_id, base_branch, base_commit, tree_sha };
  }
  if (command.operation === "tree") return normalizePathResult(result, "tree result", "tree", command);
  if (command.operation === "search") return normalizePathResult(result, "search result", "search", command);
  return normalizeReadResult(result, command);
}

export function buildSemanticEvidenceIndex(options: { repository: RepositoryBinding; observations: readonly SemanticEvidenceObservationInput[] }): SemanticEvidenceIndex {
  const repository = validateRepository(options.repository);
  if (!Array.isArray(options.observations) || options.observations.length < 1 || options.observations.length > MAX_OBSERVATIONS) throw new Error(`semantic evidence observations must contain 1-${MAX_OBSERVATIONS} items.`);
  const requestIds = new Set<string>();
  let previousSequence = -1;
  const observations = options.observations.map((input, index): SemanticEvidenceObservation => {
    const sequence = safeInteger(input.sequence, `observations[${index}].sequence`, 0);
    if (sequence <= previousSequence) throw new Error("semantic evidence observation sequence must be strictly increasing.");
    previousSequence = sequence;
    const request_id = boundedText(input.request_id, `observations[${index}].request_id`, 128);
    if (!SAFE_ID.test(request_id)) throw new Error(`observations[${index}].request_id is invalid.`);
    if (requestIds.has(request_id)) throw new Error(`duplicate semantic evidence request_id '${request_id}'.`);
    requestIds.add(request_id);
    const command = parseRepositoryCommand(input.command);
    if (command.operation === "tree" && command.prefix) safeRepositoryPath(command.prefix, `observations[${index}].command.prefix`);
    if (command.operation === "read") {
      for (const item of command.paths ?? []) safeRepositoryPath(item, `observations[${index}].command.path`);
      for (const region of command.regions ?? []) safeRepositoryPath(region.path, `observations[${index}].command.region.path`);
    }
    const result = normalizeResult(input.result, command, repository);
    const command_sha256 = digest(command);
    const normalized_result_sha256 = digest(result);
    const observation_sha256 = digest({ sequence, request_id, command_sha256, normalized_result_sha256 });
    return { sequence, request_id, operation: command.operation, command, command_sha256, result, normalized_result_sha256, observation_sha256 };
  });

  const payload = { schema_version: "1.0" as const, kind: "wco-semantic-evidence-index" as const, repository, observations };
  const evidence_index_sha256 = digest(payload);
  const index: SemanticEvidenceIndex = { ...payload, evidence_index_sha256 };
  if (canonicalJsonBuffer(index).byteLength > MAX_INDEX_BYTES) throw new Error(`semantic evidence index exceeds ${MAX_INDEX_BYTES} bytes.`);
  return index;
}
