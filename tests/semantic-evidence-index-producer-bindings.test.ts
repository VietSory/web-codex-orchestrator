import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildSemanticEvidenceIndex } from "../src/semantic/evidence-index.js";

const repository = { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) } as const;
const blob = "b".repeat(40);
const sha = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const observation = (command: unknown, result: unknown) => ({ sequence: 0, request_id: "req", command, result });

function file(path: string, text: string, transmitted = true) {
  const bytes = Buffer.from(text, "utf8");
  const content_sha256 = sha(bytes);
  return {
    path,
    content_base64: transmitted ? bytes.toString("base64") : "",
    ...(transmitted ? {} : { content_ref: `sha256:${content_sha256}` }),
    content_sha256,
    blob_sha: blob,
    size_bytes: bytes.length,
    start_byte: 0,
    end_byte_exclusive: bytes.length,
    total_bytes: bytes.length,
  };
}

test("tree and search evidence cannot exceed the exact command-requested result bound", () => {
  assert.throws(
    () => buildSemanticEvidenceIndex({ repository, observations: [observation({ operation: "tree", maximum_paths: 1 }, { paths: ["src/a.ts", "src/b.ts"], truncated: true })] }),
    /at most 1 paths/i,
  );
  assert.throws(
    () => buildSemanticEvidenceIndex({ repository, observations: [observation({ operation: "search", query: "needle", maximum_matches: 1 }, { matches: ["src/a.ts", "src/b.ts"], truncated: true })] }),
    /at most 1 paths/i,
  );
});

test("read transfer metrics are derived from normalized evidence instead of trusted as metadata", () => {
  const a = file("src/a.ts", "alpha", true);
  const b = file("src/b.ts", "bravo", false);
  const command = { operation: "read", paths: ["src/a.ts", "src/b.ts"], known_content_sha256: { "src/b.ts": b.content_sha256 } };
  const validMetrics = {
    context_bytes_prepared: 10,
    context_bytes_transmitted: 5,
    repeated_bytes_avoided: 5,
    files_considered: 2,
    files_read: 2,
    regions_read: 2,
    cache_hits: 1,
    cache_misses: 1,
  };
  assert.doesNotThrow(() => buildSemanticEvidenceIndex({ repository, observations: [observation(command, { files: [a, b], metrics: validMetrics })] }));

  for (const [key, value] of [
    ["context_bytes_prepared", 11],
    ["context_bytes_transmitted", 0],
    ["repeated_bytes_avoided", 0],
    ["files_considered", 1],
    ["files_read", 1],
    ["regions_read", 1],
  ] as const) {
    assert.throws(
      () => buildSemanticEvidenceIndex({ repository, observations: [observation(command, { files: [a, b], metrics: { ...validMetrics, [key]: value } })] }),
      new RegExp(`metrics\\.${key} does not match`, "i"),
      key,
    );
  }

  assert.throws(
    () => buildSemanticEvidenceIndex({ repository, observations: [observation(command, { files: [a, b], metrics: { ...validMetrics, cache_hits: 0, cache_misses: 1 } })] }),
    /cache hit\/miss count does not match/i,
  );
});

test("multi-region reads count unique files separately from exact regions", () => {
  const one = Buffer.from("a", "utf8");
  const two = Buffer.from("b", "utf8");
  const command = { operation: "read", regions: [
    { path: "src/app.ts", start_byte: 0, end_byte_exclusive: 1 },
    { path: "src/app.ts", start_byte: 1, end_byte_exclusive: 2 },
  ] };
  const files = [
    { path: "src/app.ts", content_base64: one.toString("base64"), content_sha256: sha(one), blob_sha: blob, size_bytes: 1, start_byte: 0, end_byte_exclusive: 1, total_bytes: 2 },
    { path: "src/app.ts", content_base64: two.toString("base64"), content_sha256: sha(two), blob_sha: blob, size_bytes: 1, start_byte: 1, end_byte_exclusive: 2, total_bytes: 2 },
  ];
  const metrics = {
    context_bytes_prepared: 2,
    context_bytes_transmitted: 2,
    repeated_bytes_avoided: 0,
    files_considered: 1,
    files_read: 1,
    regions_read: 2,
    cache_hits: 1,
    cache_misses: 1,
  };
  assert.doesNotThrow(() => buildSemanticEvidenceIndex({ repository, observations: [observation(command, { files, metrics })] }));
});
