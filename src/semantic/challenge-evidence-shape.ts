import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { parseRepositoryCommand } from "../web-bridge/contracts.js";

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function repository(value: unknown): unknown {
  const record = objectValue(value, "semantic challenge evidence repository");
  return { repository_id: record.repository_id, base_branch: record.base_branch, base_commit: record.base_commit };
}

function normalizedResult(value: unknown): unknown {
  const result = objectValue(value, "semantic challenge normalized evidence result");
  if (result.kind === "summary") {
    return {
      kind: result.kind,
      repository_id: result.repository_id,
      base_branch: result.base_branch,
      base_commit: result.base_commit,
      tree_sha: result.tree_sha,
    };
  }
  if (result.kind === "tree" || result.kind === "search") {
    return {
      kind: result.kind,
      returned_path_count: result.returned_path_count,
      indexed_paths: result.indexed_paths,
      indexed_paths_truncated: result.indexed_paths_truncated,
      source_truncated: result.source_truncated,
      all_paths_sha256: result.all_paths_sha256,
    };
  }
  if (result.kind !== "read") throw new Error("semantic challenge normalized evidence result kind is invalid.");
  if (!Array.isArray(result.files)) throw new Error("semantic challenge normalized read evidence files must be an array.");
  const files = result.files.map((entry) => {
    const file = objectValue(entry, "semantic challenge normalized read evidence file");
    return {
      path: file.path,
      content_sha256: file.content_sha256,
      blob_sha: file.blob_sha,
      size_bytes: file.size_bytes,
      start_byte: file.start_byte,
      end_byte_exclusive: file.end_byte_exclusive,
      total_bytes: file.total_bytes,
      content_reference: file.content_reference,
      content_transmitted: file.content_transmitted,
    };
  });
  const metrics = objectValue(result.metrics, "semantic challenge normalized read evidence metrics");
  return {
    kind: result.kind,
    files,
    metrics: {
      context_bytes_prepared: metrics.context_bytes_prepared,
      context_bytes_transmitted: metrics.context_bytes_transmitted,
      repeated_bytes_avoided: metrics.repeated_bytes_avoided,
      files_considered: metrics.files_considered,
      files_read: metrics.files_read,
      regions_read: metrics.regions_read,
      cache_hits: metrics.cache_hits,
      cache_misses: metrics.cache_misses,
    },
  };
}

/**
 * Reconstruct the only byte-stripped normalized Evidence Index shape that may
 * cross a durable recovery boundary. Canonical-byte equality makes unknown or
 * reintroduced producer fields (for example content_base64) fail closed even
 * when an attacker recomputes every surrounding digest self-consistently.
 */
export function assertCanonicalByteStrippedChallengeEvidence(value: unknown): void {
  const evidence = objectValue(value, "semantic challenge evidence");
  const index = objectValue(evidence.evidence_index, "semantic challenge evidence index");
  if (!Array.isArray(index.observations)) throw new Error("semantic challenge evidence observations must be an array.");
  const observations = index.observations.map((entry) => {
    const observation = objectValue(entry, "semantic challenge evidence observation");
    return {
      sequence: observation.sequence,
      request_id: observation.request_id,
      operation: observation.operation,
      command: parseRepositoryCommand(observation.command),
      command_sha256: observation.command_sha256,
      result: normalizedResult(observation.result),
      normalized_result_sha256: observation.normalized_result_sha256,
      observation_sha256: observation.observation_sha256,
    };
  });
  const canonical = {
    schema_version: evidence.schema_version,
    kind: evidence.kind,
    challenge_id: evidence.challenge_id,
    repository: repository(evidence.repository),
    evidence_index: {
      schema_version: index.schema_version,
      kind: index.kind,
      repository: repository(index.repository),
      observations,
      evidence_index_sha256: index.evidence_index_sha256,
    },
    challenge_evidence_sha256: evidence.challenge_evidence_sha256,
  };
  if (!canonicalJsonBuffer(value).equals(canonicalJsonBuffer(canonical))) {
    throw new Error("semantic challenge recovery evidence contains noncanonical or non-byte-stripped fields.");
  }
}
