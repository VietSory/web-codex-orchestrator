import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { buildSemanticEvidenceIndex } from "../src/semantic/evidence-index.js";
import { ExactRepositoryReadService } from "../src/web-bridge/repo-read-service.js";
import { ReadCoverageStore } from "../src/web-bridge/read-coverage-store.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const emptySha256 = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const emptyBlob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-empty-read-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "WCO Semantic Empty"]);
  git(repo, ["config", "user.email", "wco-semantic-empty@example.invalid"]);
  await writeFile(path.join(repo, "empty.txt"), Buffer.alloc(0));
  git(repo, ["add", "empty.txt"]);
  git(repo, ["commit", "-m", "add empty semantic fixture"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  const repository = { repository_id: "semantic-empty-repo", base_branch: "main", base_commit: baseCommit };
  const reader = new ExactRepositoryReadService(repo, repository, new ReadCoverageStore(path.join(root, "coverage")));
  return { repository, reader };
}

function metrics() {
  return {
    context_bytes_prepared: 0,
    context_bytes_transmitted: 0,
    repeated_bytes_avoided: 0,
    files_considered: 1,
    files_read: 1,
    regions_read: 1,
    cache_hits: 0,
    cache_misses: 1,
  };
}

test("actual zero-byte ExactRepositoryReadService result survives semantic evidence normalization", async (t) => {
  const { repository, reader } = await fixture(t);
  const command = { operation: "read" as const, paths: ["empty.txt"] };
  const result = await reader.execute("job-semantic-empty", "req-semantic-empty", command);
  const index = buildSemanticEvidenceIndex({ repository, observations: [{ sequence: 0, request_id: "req-semantic-empty", command, result }] });
  const normalized = index.observations[0]!.result;
  assert.equal(normalized.kind, "read");
  if (normalized.kind !== "read") return;
  assert.deepEqual(normalized.files[0], {
    path: "empty.txt",
    content_sha256: emptySha256,
    blob_sha: emptyBlob,
    size_bytes: 0,
    start_byte: 0,
    end_byte_exclusive: 0,
    total_bytes: 0,
    content_reference: null,
    content_transmitted: true,
  });
  assert.deepEqual(normalized.metrics, metrics());
});

test("known empty content uses exact reference mode and forged zero-byte evidence fails closed", async (t) => {
  const { repository, reader } = await fixture(t);
  const command = { operation: "read" as const, paths: ["empty.txt"], known_content_sha256: { "empty.txt": emptySha256 } };
  const result = await reader.execute("job-semantic-cached", "req-semantic-cached", command) as {
    files: Array<Record<string, unknown>>;
    metrics: Record<string, number>;
  };
  const index = buildSemanticEvidenceIndex({ repository, observations: [{ sequence: 0, request_id: "req-semantic-cached", command, result }] });
  const normalized = index.observations[0]!.result;
  assert.equal(normalized.kind, "read");
  if (normalized.kind === "read") {
    assert.equal(normalized.files[0]!.content_reference, `sha256:${emptySha256}`);
    assert.equal(normalized.files[0]!.content_transmitted, false);
  }

  for (const mutation of [
    { blob_sha: "b".repeat(40) },
    { content_sha256: "c".repeat(64) },
  ]) {
    const forged = {
      files: [{ ...result.files[0]!, ...mutation }],
      metrics: result.metrics,
    };
    assert.throws(
      () => buildSemanticEvidenceIndex({ repository, observations: [{ sequence: 0, request_id: "req-forged", command, result: forged }] }),
      /canonical empty Git\/content digests/i,
    );
  }
});

test("semantic evidence does not generalize the empty-file exception to arbitrary zero-length ranges", () => {
  const repository = { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) };
  const command = { operation: "read", paths: ["empty.txt"] };
  const result = {
    files: [{
      path: "empty.txt",
      content_base64: "",
      content_sha256: emptySha256,
      blob_sha: emptyBlob,
      size_bytes: 0,
      start_byte: 0,
      end_byte_exclusive: 0,
      total_bytes: 1,
    }],
    metrics: metrics(),
  };
  assert.throws(
    () => buildSemanticEvidenceIndex({ repository, observations: [{ sequence: 0, request_id: "req-non-empty-total", command, result }] }),
    /byte range\/size is inconsistent/i,
  );
});
