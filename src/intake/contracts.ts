export type IntakeErrorCode =
  | "INPUT_NOT_FOUND"
  | "INPUT_NOT_REGULAR_FILE"
  | "INPUT_SYMLINK"
  | "INPUT_NOT_ZIP"
  | "ARCHIVE_TOO_LARGE"
  | "ZIP_MALFORMED"
  | "ZIP_TOO_MANY_ENTRIES"
  | "ZIP_ENTRY_TOO_LARGE"
  | "ZIP_TOTAL_TOO_LARGE"
  | "ZIP_UNSAFE_PATH"
  | "ZIP_PATH_COLLISION"
  | "ZIP_ENCRYPTED_ENTRY"
  | "ZIP_UNSUPPORTED_ENTRY_TYPE"
  | "ZIP_UNSUPPORTED_COMPRESSION"
  | "ZIP_AMBIGUOUS_ROOT"
  | "BUNDLE_CONTRACT_INVALID"
  | "CHECKSUMS_INVALID"
  | "CHECKSUM_MISSING_FILE"
  | "CHECKSUM_UNKNOWN_FILE"
  | "CHECKSUM_MISMATCH"
  | "PAYLOAD_CONTRACT_INVALID"
  | "OPERATIONAL_ERROR";

export interface IntakeErrorDetail {
  code: IntakeErrorCode;
  message: string;
  entry?: string;
}

export interface AcceptedIntakeReceipt {
  receipt_version: "1.0";
  status: "accepted";
  task_id: string;
  bundle_schema_version: "1.0" | "1.1" | "1.2";
  archive_sha256: string;
  archive_bytes: number;
  entry_count: number;
  total_uncompressed_bytes: number;
  logical_root: string;
  stored_bundle: string;
  checks: string[];
  errors: [];
  created_at: string;
}

export interface RejectedIntakeReceipt {
  receipt_version: "1.0";
  status: "rejected";
  archive_sha256?: string;
  archive_bytes?: number;
  entry_count?: number;
  total_uncompressed_bytes?: number;
  checks: string[];
  errors: IntakeErrorDetail[];
  created_at: string;
}

export type IntakeReceipt = AcceptedIntakeReceipt | RejectedIntakeReceipt;

export interface SafeZipEntry {
  archiveName: string;
  normalizedPath: string;
  isDirectory: boolean;
  uncompressedSize: number;
}

export interface ArchiveInspection {
  entries: SafeZipEntry[];
  entryCount: number;
  totalUncompressedBytes: number;
}
