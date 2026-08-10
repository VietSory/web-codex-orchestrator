import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExactRepositoryReadService } from "../src/web-bridge/repo-read-service.js";
import { ReadCoverageStore } from "../src/web-bridge/read-coverage-store.js";

const run = promisify(execFile);
test("Web repository reads use exact base objects, deny secrets, and persist coverage", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "wco-read-test-")); await run("git", ["init", "-b", "main"], { cwd: repo }); await run("git", ["config", "user.name", "Test"], { cwd: repo }); await run("git", ["config", "user.email", "test@example.invalid"], { cwd: repo }); await mkdir(path.join(repo, "src")); await writeFile(path.join(repo, "src/app.txt"), "committed\n"); await writeFile(path.join(repo, ".env"), "TRACKED_SECRET=x\n"); await run("git", ["add", "."], { cwd: repo }); await run("git", ["commit", "-m", "base"], { cwd: repo }); const base = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(); await writeFile(path.join(repo, "src/app.txt"), "uncommitted\n");
  const receiptRoot = path.join(repo, ".wco-test-receipts"); const coverage = new ReadCoverageStore(receiptRoot); const service = new ExactRepositoryReadService(repo, { repository_id: "repo", base_branch: "main", base_commit: base }, coverage);
  const read = await service.read("job", "request", ["src/app.txt"], () => new Date("2026-01-01T00:00:00.000Z")); assert.equal(Buffer.from(read.files[0]!.content_base64, "base64").toString(), "committed\n"); assert.equal((await coverage.list("job"))[0]!.path, "src/app.txt");
  assert.deepEqual(await service.search("committed"), { matches: ["src/app.txt"], truncated: false });
  assert.deepEqual(await service.search("uncommitted"), { matches: [], truncated: false });
  await assert.rejects(service.read("job", "secret", [".env"]), /sensitive/i); const tree = await service.tree(); assert.ok(!tree.paths.includes(".env"));
});
