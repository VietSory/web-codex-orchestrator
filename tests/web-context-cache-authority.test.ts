import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ContentAddressedContextCache } from "../src/web-bridge/context-cache.js";
import { ReadCoverageStore } from "../src/web-bridge/read-coverage-store.js";
import { ExactRepositoryReadService } from "../src/web-bridge/repo-read-service.js";

const run = promisify(execFile);
const sha256 = (value: Buffer | string): string => crypto.createHash("sha256").update(value).digest("hex");

test("context cache cannot replace exact Git blob authority with self-consistent tampered bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-context-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const cacheRoot = path.join(root, "cache");
  await mkdir(repo);
  await run("git", ["init", "-b", "main"], { cwd: repo });
  await run("git", ["config", "user.name", "Test"], { cwd: repo });
  await run("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, "app.txt"), "canonical\n");
  await run("git", ["add", "app.txt"], { cwd: repo });
  await run("git", ["commit", "-m", "base"], { cwd: repo });
  const base = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const blob = (await run("git", ["rev-parse", `${base}:app.txt`], { cwd: repo })).stdout.trim();

  const cache = new ContentAddressedContextCache(cacheRoot);
  const coverage = new ReadCoverageStore(path.join(root, "coverage"));
  const service = new ExactRepositoryReadService(repo, { repository_id: "repo", base_branch: "main", base_commit: base }, coverage, {}, cache);

  const first = await service.read("job-1", "read-1", ["app.txt"]);
  assert.equal(Buffer.from(first.files[0]!.content_base64, "base64").toString("utf8"), "canonical\n");
  assert.equal(first.metrics.cache_misses, 1);

  const cacheKey = `${base}\0${blob}\0full`;
  const cachePath = path.join(cacheRoot, `${sha256(cacheKey)}.json`);
  const malicious = Buffer.from("tampered but internally self-consistent\n");
  const record = JSON.parse(await readFile(cachePath, "utf8"));
  record.content_base64 = malicious.toString("base64");
  record.content_sha256 = sha256(malicious);
  await writeFile(cachePath, JSON.stringify(record));

  const second = await service.read("job-1", "read-2", ["app.txt"]);
  assert.equal(Buffer.from(second.files[0]!.content_base64, "base64").toString("utf8"), "canonical\n");
  assert.equal(second.files[0]!.blob_sha, blob);
  assert.equal(second.metrics.cache_hits, 0);
  assert.equal(second.metrics.cache_misses, 1);

  const repairedRecord = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(Buffer.from(repairedRecord.content_base64, "base64").toString("utf8"), "canonical\n");
});

test("context cache has a hard global entry-count bound and keeps the newly inserted content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-context-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new ContentAddressedContextCache(root, 1024, 2);
  await cache.put("key-a", Buffer.from("a"));
  await cache.put("key-b", Buffer.from("b"));
  await cache.put("key-c", Buffer.from("c"));

  const records = (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(records.length, 2);
  assert.equal((await cache.get("key-c"))?.toString("utf8"), "c");
});
