export const WEB_IMPLEMENTATION_PACK_VERSION = "2.0" as const;
export const WEB_RESPONSE_ENVELOPE_VERSION = "2.0" as const;

export type WebAuthorityErrorCode =
  | "WEB_AUTHORITY_INVALID_RUN_ID"
  | "WEB_AUTHORITY_STATE_DIR_UNSAFE"
  | "WEB_AUTHORITY_INPUT_NOT_FOUND"
  | "WEB_AUTHORITY_INPUT_NOT_REGULAR"
  | "WEB_AUTHORITY_INPUT_SYMLINK"
  | "WEB_AUTHORITY_ARCHIVE_TOO_LARGE"
  | "WEB_AUTHORITY_ARCHIVE_INVALID"
  | "WEB_AUTHORITY_ENTRY_UNSAFE"
  | "WEB_AUTHORITY_ENTRY_LIMIT"
  | "WEB_AUTHORITY_ENTRY_TOO_LARGE"
  | "WEB_AUTHORITY_TOTAL_TOO_LARGE"
  | "WEB_AUTHORITY_CHECKSUM_MISMATCH"
  | "WEB_AUTHORITY_MANIFEST_INVALID"
  | "WEB_AUTHORITY_BINDING_MISMATCH"
  | "WEB_AUTHORITY_OPERATION_INVALID"
  | "WEB_AUTHORITY_PREIMAGE_INVALID"
  | "WEB_AUTHORITY_SOURCE_INVALID"
  | "WEB_AUTHORITY_REGISTRY_CONFLICT"
  | "WEB_AUTHORITY_REGISTRY_INVALID"
  | "WEB_AUTHORITY_OPERATIONAL_ERROR";

export class WebAuthorityError extends Error {
  readonly code: WebAuthorityErrorCode;
  constructor(code: WebAuthorityErrorCode, message: string) {
    super(message);
    this.name = "WebAuthorityError";
    this.code = code;
  }
}

export interface WebPackRepositoryBinding {
  id: string;
  base_branch: string;
  base_commit: string;
  tree_sha: string;
}

export interface WebPackBindings {
  spec_set_sha256: string;
  repository_inventory_sha256: string;
  read_coverage_sha256: string;
  project_map_sha256: string;
  source_receipts_sha256: string;
  preimages_sha256: string;
  architecture_lock_sha256: string;
  acceptance_lock_sha256: string;
  prohibited_changes_sha256: string;
  operations_sha256: string;
}

export interface WebImplementationPackManifest {
  schema_version: "2.0";
  kind: "wco-web-implementation-pack";
  pack_id: string;
  run_id: string;
  task_id: string;
  task_bundle_sha256: string;
  repository: WebPackRepositoryBinding;
  bindings: WebPackBindings;
  created_at: string;
}

export type WebOperationKind = "create_file" | "replace_file" | "delete_file";

export interface WebImplementationOperation {
  op_id: string;
  kind: WebOperationKind;
  path: string;
  preimage_sha256: string | null;
  payload_entry?: string;
  payload_sha256?: string;
}

export interface WebOperationsDocument {
  schema_version: "2.0";
  operations: WebImplementationOperation[];
}

export interface WebPreimagesDocument {
  schema_version: "2.0";
  entries: Array<{ path: string; sha256: string | null }>;
}

export interface WebSourceReceipt {
  source_id: string;
  source_type: "web" | "github" | "document" | "mcp" | "other";
  locator: string;
  accessed_at: string;
  content_sha256: string;
  authority: "primary" | "secondary" | "community" | "unknown";
}

export interface WebSourceReceiptsDocument {
  schema_version: "2.0";
  receipts: WebSourceReceipt[];
}

export interface WebChecksumEntry {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface WebChecksumsDocument {
  schema_version: "2.0";
  algorithm: "sha256";
  entries: WebChecksumEntry[];
}

export interface WebImplementationPack {
  archive_sha256: string;
  archive_size_bytes: number;
  entry_count: number;
  uncompressed_size_bytes: number;
  manifest: WebImplementationPackManifest;
  operations: WebOperationsDocument;
  preimages: WebPreimagesDocument;
  sources: WebSourceReceiptsDocument;
  entries: ReadonlyMap<string, Buffer>;
}

export interface ArtifactRegistrationRecord {
  registry_version: "1.0";
  artifact_kind: "web-implementation-pack";
  artifact_sha256: string;
  artifact_size_bytes: number;
  stored_relative_path: string;
  run_id: string;
  task_id: string;
  task_bundle_sha256: string;
  pack_id: string;
  repository: WebPackRepositoryBinding;
  bindings: WebPackBindings;
  manifest_sha256: string;
  registered_at: string;
}

export interface WebResponseEnvelope {
  schema_version: "2.0";
  kind: "wco-web-response";
  run_id: string;
  response_id: string;
  in_reply_to_artifact_sha256: string;
  decision: "APPROVE" | "REVISE" | "ESCALATE";
  payload_sha256: string;
  created_at: string;
}

export interface WebAuthorityLimits {
  maximum_archive_bytes: number;
  maximum_entries: number;
  maximum_entry_bytes: number;
  maximum_total_uncompressed_bytes: number;
  maximum_operations: number;
  maximum_source_receipts: number;
}

export const DEFAULT_WEB_AUTHORITY_LIMITS: WebAuthorityLimits = {
  maximum_archive_bytes: 33_554_432,
  maximum_entries: 512,
  maximum_entry_bytes: 8_388_608,
  maximum_total_uncompressed_bytes: 67_108_864,
  maximum_operations: 256,
  maximum_source_receipts: 512,
};

export const REQUIRED_WEB_PACK_ENTRIES = [
  "implementation-pack.json",
  "repository-inventory.json",
  "read-coverage.json",
  "project-map.json",
  "source-receipts.json",
  "preimages.json",
  "architecture-lock.json",
  "acceptance-lock.json",
  "prohibited-changes.json",
  "operations.json",
  "checksums.json",
] as const;
