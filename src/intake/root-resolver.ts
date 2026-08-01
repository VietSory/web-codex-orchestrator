import type { SafeZipEntry } from "./contracts.js";
import { IntakeError } from "./errors.js";

export interface LogicalRoot {
  rootRelative: string;
  logicalRoot: string;
}

const BUNDLE_MARKERS = new Set([
  "manifest.json",
  "README.md",
  "REQUEST.md",
  "RESEARCH.md",
  "SOURCES.md",
  "PLAN.md",
  "RULES.md",
  "VALIDATION.md",
  "request.md",
  "research.md",
  "sources.md",
  "plan.md",
  "rules.md",
  "acceptance.json",
  "test-matrix.json",
  "validation.json",
  "risk-policy.json",
  "checksums.json",
]);

/** Resolves the logical root without reading or executing bundle files. */
export function resolveLogicalRoot(entries: SafeZipEntry[]): LogicalRoot {
  const topSegments = new Set<string>();
  const rootFiles = new Set<string>();
  let wrappedMarkerFound = false;

  for (const entry of entries) {
    const segments = entry.normalizedPath.split("/");
    topSegments.add(segments[0]!);
    if (!entry.isDirectory && segments.length === 1) rootFiles.add(segments[0]!);
    if (segments.length > 1 && BUNDLE_MARKERS.has(segments[1]!)) wrappedMarkerFound = true;
  }

  if (rootFiles.size > 0) {
    if (wrappedMarkerFound) {
      throw new IntakeError(
        "ZIP_AMBIGUOUS_ROOT",
        "Bundle files are split between archive root and a wrapper directory.",
      );
    }
    return { rootRelative: "", logicalRoot: "." };
  }

  if (topSegments.size !== 1) {
    throw new IntakeError(
      "ZIP_AMBIGUOUS_ROOT",
      "Archive must contain one logical root or files directly at archive root.",
    );
  }

  const wrapper = topSegments.values().next().value;
  if (!wrapper) throw new IntakeError("ZIP_AMBIGUOUS_ROOT", "Archive has no logical bundle root.");
  return { rootRelative: wrapper, logicalRoot: wrapper };
}
