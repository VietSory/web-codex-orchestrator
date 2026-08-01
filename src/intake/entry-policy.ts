import path from "node:path";

import type { Entry } from "yauzl";

import type { ArchiveLimits } from "./constants.js";
import type { SafeZipEntry } from "./contracts.js";
import { IntakeError } from "./errors.js";

const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMBOLIC_LINK = 0o120000;

export interface EntryPolicyState {
  exactPaths: Set<string>;
  lowercasePaths: Set<string>;
  nfcPaths: Set<string>;
}

export function createEntryPolicyState(): EntryPolicyState {
  return {
    exactPaths: new Set<string>(),
    lowercasePaths: new Set<string>(),
    nfcPaths: new Set<string>(),
  };
}

function unsafePath(message: string, entry: string): never {
  throw new IntakeError("ZIP_UNSAFE_PATH", message, entry);
}

function entryType(entry: Entry): boolean {
  const unixType = (entry.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
  const endsWithSlash = entry.fileName.endsWith("/");
  const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0;

  if (unixType === UNIX_SYMBOLIC_LINK) {
    throw new IntakeError("ZIP_UNSUPPORTED_ENTRY_TYPE", "Symbolic links are not allowed.", entry.fileName);
  }
  if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY) {
    throw new IntakeError("ZIP_UNSUPPORTED_ENTRY_TYPE", "Special ZIP entry types are not allowed.", entry.fileName);
  }

  const isDirectory = endsWithSlash || unixType === UNIX_DIRECTORY || (unixType === 0 && dosDirectory);
  if (isDirectory && unixType === UNIX_REGULAR_FILE) {
    throw new IntakeError("ZIP_UNSUPPORTED_ENTRY_TYPE", "A regular file cannot be a directory entry.", entry.fileName);
  }
  return isDirectory;
}

/** Validates a decoded ZIP name without touching the filesystem. */
export function inspectEntry(
  entry: Entry,
  limits: ArchiveLimits,
  state: EntryPolicyState,
): SafeZipEntry {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0 || entry.isEncrypted()) {
    throw new IntakeError("ZIP_ENCRYPTED_ENTRY", "Encrypted ZIP entries are not supported.", entry.fileName);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new IntakeError(
      "ZIP_UNSUPPORTED_COMPRESSION",
      `ZIP compression method ${entry.compressionMethod} is not supported.`,
      entry.fileName,
    );
  }

  const isDirectory = entryType(entry);
  const rawName = entry.fileName;
  if (rawName.includes("\0")) unsafePath("ZIP entry path contains a NUL character.", rawName);
  if (rawName.includes("\\")) unsafePath("ZIP entry path contains a backslash.", rawName);
  if (rawName.startsWith("/")) unsafePath("ZIP entry path must not be absolute.", rawName);
  if (/^[A-Za-z]:/.test(rawName)) unsafePath("ZIP entry path must not use a drive prefix.", rawName);

  const withoutDirectorySlash = isDirectory && rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
  if (!withoutDirectorySlash) unsafePath("ZIP entry path cannot be empty.", rawName);
  if (withoutDirectorySlash.length > limits.maximumPathLength) {
    unsafePath(`ZIP entry path exceeds ${limits.maximumPathLength} characters.`, rawName);
  }

  const segments = withoutDirectorySlash.split("/");
  for (const segment of segments) {
    if (!segment) unsafePath("ZIP entry path contains an empty segment.", rawName);
    if (segment === "." || segment === "..") unsafePath("ZIP entry path contains dot traversal.", rawName);
    if (segment.length > limits.maximumPathSegmentLength) {
      unsafePath(`ZIP entry segment exceeds ${limits.maximumPathSegmentLength} characters.`, rawName);
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      unsafePath("ZIP entry segment must not end in a dot or space.", rawName);
    }
    if (WINDOWS_RESERVED_NAMES.test(segment)) {
      unsafePath("ZIP entry uses a Windows reserved filename.", rawName);
    }
  }

  const normalizedPath = segments.join("/");
  const nfcPath = normalizedPath.normalize("NFC");
  const lowercasePath = nfcPath.toLocaleLowerCase("en-US");
  if (
    state.exactPaths.has(normalizedPath) ||
    state.lowercasePaths.has(lowercasePath) ||
    state.nfcPaths.has(nfcPath)
  ) {
    throw new IntakeError("ZIP_PATH_COLLISION", "ZIP entry path collides with another entry.", rawName);
  }
  state.exactPaths.add(normalizedPath);
  state.lowercasePaths.add(lowercasePath);
  state.nfcPaths.add(nfcPath);

  if (entry.uncompressedSize > limits.maximumEntryUncompressedBytes) {
    throw new IntakeError(
      "ZIP_ENTRY_TOO_LARGE",
      `ZIP entry exceeds ${limits.maximumEntryUncompressedBytes} uncompressed bytes.`,
      rawName,
    );
  }

  return {
    archiveName: rawName,
    normalizedPath,
    isDirectory,
    uncompressedSize: entry.uncompressedSize,
  };
}

export function resolveExtractionPath(extractionRoot: string, entry: SafeZipEntry): string {
  const target = path.resolve(extractionRoot, ...entry.normalizedPath.split("/"));
  const root = path.resolve(extractionRoot);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new IntakeError("ZIP_UNSAFE_PATH", "ZIP entry escapes the extraction root.", entry.archiveName);
  }
  return target;
}
