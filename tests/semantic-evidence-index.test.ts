import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildSemanticEvidenceIndex } from "../src/semantic/evidence-index.js";

const repository = { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) } as const;
const blob = "b".repeat(40);

function sha(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function metrics(overrides: Record<string, number> = {}) {
  return {
    context_bytes_prepared: 6,
    context_bytes_transmitted: 6,
    repeated_bytes_avoided: 0,
    files_considered: 1,
    files_read: 1,
    regions_read: 1,
    cache_hits: 0,
    cache_misses: 1,
    ...overrides,
  };
}

function wholeRead(path = "src/app.ts", text = "hello\n") {
  const bytes = Buffer.from(text, "utf8");
  return {
    command: { operation: "read", paths: [path] },
    result: {
      files: [{
        path,
        content_base64: bytes.toString("base64"),
        content_sha256: sha(bytes),
        blob_sha: blob,
        size_bytes: bytes.length,
        start_byte: 0,
        end_byte_exclusive: bytes.length,
        total_bytes: bytes.length,
      }],
      metrics: metrics({ context_bytes_prepared: bytes.length, context_bytes_transmitted: bytes.length }),
    },
  };
}

function observation(sequence: number, requestId: string, command: unknown, result: unknown) {
  return { sequence, request_id: requestId, command, result };
}

test("evidence index is deterministic, repository-bound, and strips transmitted source bytes", () => {
  const read = wholeRead("src/private-name.ts", "TOP_SECRET_SOURCE\n");
  const options = { repository, observations: [observation(0, "req-read", read.command, read.result)] };
  const first = buildSemanticEvidenceIndex(options);
  const second = buildSemanticEvidenceIndex(options);
  assert.deepEqual(first, second);
  assert.match(first.evidence_index_sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.observations[0]?.result.kind, "read");

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /TOP_SECRET_SOURCE/);
  assert.doesNotMatch(serialized, new RegExp(Buffer.from("TOP_SECRET_SOURCE\n").toString("base64")));
  assert.doesNotMatch(serialized, /content_base64/);

  const changed = wholeRead("src/private-name.ts", "changed\n");
  const changedIndex = buildSemanticEvidenceIndex({
    repository,
    observations: [observation(0, "req-read", changed.command, changed.result)],
  });
  assert.notEqual(changedIndex.evidence_index_sha256, first.evidence_index_sha256);
});

test("transmitted read bytes are re-hashed and tampering fails closed", () => {
  const read = wholeRead();
  const tamperedHash: any = structuredClone(read.result);
  tamperedHash.files[0].content_sha256 = "c".repeat(64);
  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-a", read.command, tamperedHash)] }), /do not match content_sha256/i);

  const tamperedBase64: any = structuredClone(read.result);
  tamperedBase64.files[0].content_base64 = "not canonical base64";
  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-b", read.command, tamperedBase64)] }), /canonical base64|byte length/i);
});

test("cached content references bind the exact SHA without persisting source bytes", () => {
  const bytes = Buffer.from("hello\n");
  const contentSha = sha(bytes);
  const command = { operation: "read", paths: ["src/app.ts"], known_content_sha256: { "src/app.ts": contentSha } };
  const result = {
    files: [{
      path: "src/app.ts",
      content_base64: "",
      content_ref: `sha256:${contentSha}`,
      content_sha256: contentSha,
      blob_sha: blob,
      size_bytes: bytes.length,
      start_byte: 0,
      end_byte_exclusive: bytes.length,
      total_bytes: bytes.length,
    }],
    metrics: metrics({ context_bytes_prepared: bytes.length, context_bytes_transmitted: 0, repeated_bytes_avoided: bytes.length, cache_hits: 1, cache_misses: 0 }),
  };
  const index = buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-cache", command, result)] });
  assert.equal((index.observations[0]!.result as any).files[0].content_reference, `sha256:${contentSha}`);
  assert.equal((index.observations[0]!.result as any).files[0].content_transmitted, false);

  const wrongRef: any = structuredClone(result);
  wrongRef.files[0].content_ref = `sha256:${"d".repeat(64)}`;
  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-ref", command, wrongRef)] }), /exact SHA-256 content_ref/i);

  const injectedCommand = { ...command, known_content_sha256: { ...command.known_content_sha256, "src/unread.ts": "e".repeat(64) } };
  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-known", injectedCommand, result)] }), /does not bind an exact requested path\/region/i);
});

test("read results must bind the exact requested path, order, and byte region", () => {
  const bytesA = Buffer.from("alpha");
  const bytesB = Buffer.from("bravo");
  const command = { operation: "read", paths: ["src/a.ts", "src/b.ts"] };
  const file = (path: string, bytes: Buffer) => ({
    path,
    content_base64: bytes.toString("base64"),
    content_sha256: sha(bytes),
    blob_sha: blob,
    size_bytes: bytes.length,
    start_byte: 0,
    end_byte_exclusive: bytes.length,
    total_bytes: bytes.length,
  });
  const wrongOrder = { files: [file("src/b.ts", bytesB), file("src/a.ts", bytesA)], metrics: metrics({ context_bytes_prepared: 10, context_bytes_transmitted: 10, files_considered: 2, files_read: 2, regions_read: 2, cache_misses: 2 }) };
  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-order", command, wrongOrder)] }), /does not bind the exact requested path\/region/i);

  const regionBytes = Buffer.from("ell");
  const regionCommand = { operation: "read", regions: [{ path: "src/app.ts", start_byte: 1, end_byte_exclusive: 4 }] };
  const wrongRegion = {
    files: [{ path: "src/app.ts", content_base64: regionBytes.toString("base64"), content_sha256: sha(regionBytes), blob_sha: blob, size_bytes: 3, start_byte: 0, end_byte_exclusive: 3, total_bytes: 6 }],
    metrics: metrics({ context_bytes_prepared: 3, context_bytes_transmitted: 3 }),
  };
  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-region", regionCommand, wrongRegion)] }), /does not bind the exact requested path\/region/i);
});

test("summary evidence cannot drift repository/base identity", () => {
  const command = { operation: "summary" };
  const valid = { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40), tree_sha: "f".repeat(40) };
  assert.doesNotThrow(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-summary", command, valid)] }));
  for (const result of [
    { ...valid, repository_id: "other" },
    { ...valid, base_branch: "dev" },
    { ...valid, base_commit: "0".repeat(40) },
  ]) assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-summary", command, result)] }), /does not bind the exact semantic evidence repository/i);
});

test("sensitive and non-canonical repository paths are rejected independently of upstream", () => {
  for (const path of [".env", ".git/config", "config/credentials.json", "certs/server.pem", "../escape.ts", "src\\app.ts"]) {
    const read = wholeRead(path);
    assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, `req-${sha(path).slice(0, 8)}`, read.command, read.result)] }), /denied|not canonical|safe repository-relative path/i, path);
  }
});

test("observation identity is ordered and replay-safe", () => {
  const one = { command: { operation: "summary" }, result: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40), tree_sha: "1".repeat(40) } };
  const two = { command: { operation: "tree", prefix: "src" }, result: { paths: ["src/a.ts"], truncated: false } };
  const valid = [observation(1, "req-one", one.command, one.result), observation(2, "req-two", two.command, two.result)];
  const index = buildSemanticEvidenceIndex({ repository, observations: valid });
  assert.equal(index.observations.length, 2);

  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(1, "same", one.command, one.result), observation(2, "same", two.command, two.result)] }), /duplicate semantic evidence request_id/i);
  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(2, "req-two", two.command, two.result), observation(1, "req-one", one.command, one.result)] }), /strictly increasing/i);

  const resequenced = buildSemanticEvidenceIndex({ repository, observations: [observation(10, "req-one", one.command, one.result), observation(20, "req-two", two.command, two.result)] });
  assert.notEqual(resequenced.evidence_index_sha256, index.evidence_index_sha256);
});

test("tree/search evidence is compact but digest-bound to the complete returned path list", () => {
  const paths = Array.from({ length: 300 }, (_, index) => `src/generated/file-${String(index).padStart(3, "0")}.ts`);
  const command = { operation: "tree", prefix: "src" };
  const first = buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-tree", command, { paths, truncated: false })] });
  const tree = first.observations[0]!.result as any;
  assert.equal(tree.returned_path_count, 300);
  assert.equal(tree.indexed_paths.length, 256);
  assert.equal(tree.indexed_paths_truncated, true);
  assert.match(tree.all_paths_sha256, /^[a-f0-9]{64}$/);

  const reordered = [...paths];
  [reordered[298], reordered[299]] = [reordered[299]!, reordered[298]!];
  const second = buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-tree", command, { paths: reordered, truncated: false })] });
  assert.notEqual((second.observations[0]!.result as any).all_paths_sha256, tree.all_paths_sha256);
  assert.notEqual(second.evidence_index_sha256, first.evidence_index_sha256);

  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-prefix", command, { paths: ["tests/outside.ts"], truncated: false })] }), /outside the requested tree prefix/i);
});

test("result objects and transfer metrics are closed and internally consistent", () => {
  const treeCommand = { operation: "tree" };
  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-extra", treeCommand, { paths: ["src/a.ts"], truncated: false, surprise: true })] }), /unexpected field/i);

  const read = wholeRead();
  const impossible: any = structuredClone(read.result);
  impossible.metrics.context_bytes_transmitted = 7;
  impossible.metrics.context_bytes_prepared = 6;
  assert.throws(() => buildSemanticEvidenceIndex({ repository, observations: [observation(0, "req-metric", read.command, impossible)] }), /context_bytes_transmitted does not match normalized read evidence/i);
});
