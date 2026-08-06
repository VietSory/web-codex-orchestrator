// Canonical JSON serialization for Phase 6
// UTF-8, sorted keys, 2-space indent, LF endings, exactly one trailing newline.

/**
 * Recursively sort object keys by Unicode code point.
 * Arrays retain contract-defined semantic order (not sorted).
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize to canonical JSON:
 * - UTF-8 (implicit in Node.js string handling)
 * - Object keys sorted by Unicode code point
 * - 2-space indentation
 * - LF line endings
 * - Exactly one trailing newline
 */
export function canonicalJson(value: unknown): string {
  const sorted = sortKeys(value);
  const json = JSON.stringify(sorted, null, 2);
  // Normalize line endings to LF and add exactly one trailing newline
  return json.replace(/\r\n/g, "\n") + "\n";
}

/**
 * Produce canonical JSON as a UTF-8 Buffer.
 */
export function canonicalJsonBuffer(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}
