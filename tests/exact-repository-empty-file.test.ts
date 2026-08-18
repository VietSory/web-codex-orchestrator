import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExactRepositoryReadService } from "../src/web-bridge/repo-read-service.js";
import { ReadCoverageStore } from "../src/web-bridge/read-coverage-store.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("exact whole-file read attests an empty Git blob as zero-byte full coverage", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-empty-exact-read-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const coverageRoot = path.join(root, "coverage");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "WCO Empty Read"]);
  git(repo, ["config", "user.email", "wco-empty-read@example.invalid"]);
  await writeFile(path.join(repo, "empty.txt"), Buffer.alloc(0));
  git(repo, ["add", "empty.txt"]);
  git(repo, ["commit", "-m", "add empty fixture"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  const blobSha = git(repo, ["rev-parse", `${baseCommit}:empty.txt`]);
  const coverage = new ReadCoverageStore(coverageRoot);
  const reader = new ExactRepositoryReadService(repo, {
    repository_id: "empty-read-repo",
    base_branch: "main",
    base_commit: baseCommit,
  }, coverage);

  const result = await reader.read("job-empty", "req-empty", ["empty.txt"], () => new Date("2026-08-18T00:00:00.000Z"));
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0], {
    path: "empty.txt",
    content_base64: "",
    content_sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    blob_sha: blobSha,
    size_bytes: 0,
    start_byte: 0,
    end_byte_exclusive: 0,
    total_bytes: 0,
  });
  assert.equal(result.metrics.files_read, 1);
  assert.equal(result.metrics.regions_read, 1);
  assert.equal(result.metrics.context_bytes_prepared, 0);
  assert.equal(result.metrics.context_bytes_transmitted, 0);

  const receipts = await coverage.list("job-empty");
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0], {
    schema_version: "1.0",
    job_id: "job-empty",
    request_id: "req-empty",
    base_commit: baseCommit,
    path: "empty.txt",
    blob_sha: blobSha,
    content_sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    start_byte: 0,
    end_byte_exclusive: 0,
    total_bytes: 0,
    observed_at: "2026-08-18T00:00:00.000Z",
  });
});

test("zero-byte coverage remains narrow: explicit empty ranges and inconsistent receipts still fail closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-empty-range-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "WCO Empty Read"]);
  git(repo, ["config", "user.email", "wco-empty-read@example.invalid"]);
  await writeFile(path.join(repo, "empty.txt"), Buffer.alloc(0));
  git(repo, ["add", "empty.txt"]);
  git(repo, ["commit", "-m", "add empty fixture"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  const coverage = new ReadCoverageStore(path.join(root, "coverage"));
  const reader = new ExactRepositoryReadService(repo, {
    repository_id: "empty-range-repo",
    base_branch: "main",
    base_commit: baseCommit,
  }, coverage);

  await assert.rejects(
    reader.readRegions("job-range", "req-range", [{ path: "empty.txt", start_byte: 0, end_byte_exclusive: 0 }]),
    /byte range is invalid/i,
  );

  await assert.rejects(
    coverage.append({
      schema_version: "1.0",
      job_id: "job-bad",
      request_id: "req-bad",
      base_commit: baseCommit,
      path: "empty.txt",
      blob_sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
      content_sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      start_byte: 0,
      end_byte_exclusive: 1,
      total_bytes: 0,
      observed_at: "2026-08-18T00:00:00.000Z",
    }),
    /byte range is inconsistent/i,
  );
});
