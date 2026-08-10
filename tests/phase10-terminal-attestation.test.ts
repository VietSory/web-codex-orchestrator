import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createPhase9Fixture, buildPhase9Pack } from "./helpers/phase9-fixture.js";
import { registerWebImplementationPack } from "../src/web-authority/authority-service.js";
import { executeRegisteredWebPack } from "../src/executor/service.js";
import { ExecutorError } from "../src/executor/contracts.js";
import type { ExecutorReviewerPort, ExecutorVerifierPort } from "../src/executor/gates.js";
import { executorPaths } from "../src/executor/paths.js";
import { writeGitPublishReceipt } from "../src/publish/publish-store.js";
import { attestReadyExecutorSnapshot } from "../src/orchestration/executor-ready.js";

const execFile = promisify(execFileCallback);
async function git(cwd: string, ...args: string[]): Promise<string> { return (await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout; }

const verifier: ExecutorVerifierPort = { async verify(request) { return { passed: true, evidence: { digest: request.change_set_digest, passed: true } }; } };
const reviewer: ExecutorReviewerPort = { async review(request) { return { verdict: "APPROVE", evidence: { reviewer: request.reviewer, digest: request.change_set_digest } }; } };

test("P10-SVC-005 READY retry re-attests exact worktree digest instead of trusting stale success", async (t) => {
  const fixture = await createPhase9Fixture(); t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  const first = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer });
  assert.equal(first.state, "READY_FOR_PUBLISH");
  await fs.writeFile(path.join(fixture.repo, "app.txt"), "drift after ready\n");
  await assert.rejects(() => executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer }), (error: unknown) => error instanceof ExecutorError && (error.code === "EXECUTOR_POSTIMAGE_MISMATCH" || error.code === "EXECUTOR_UNREGISTERED_CHANGE"));
});

test("P10-SVC-006 a clean exact published commit remains attestable for Draft PR and result handoff", async (t) => {
  const fixture = await createPhase9Fixture(); t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registration = await registerWebImplementationPack({ runId: fixture.runId, stateDirectory: fixture.state, configPath: fixture.config, archivePath: archive });
  const receipt = await executeRegisteredWebPack({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config, verifier, reviewer });
  assert.equal(receipt.state, "READY_FOR_PUBLISH");
  await git(fixture.repo, "switch", "-c", "codex/task-p9");
  await git(fixture.repo, "add", "app.txt");
  await git(fixture.repo, "commit", "-m", "Apply verified task TASK-P9-001");
  const commit = (await git(fixture.repo, "rev-parse", "HEAD")).trim();
  const entry = (await git(fixture.repo, "ls-tree", commit, "--", "app.txt")).trim();
  const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\tapp\.txt$/.exec(entry);
  assert.ok(match);
  const snapshot = crypto.createHash("sha256");
  for (const value of ["app.txt", "\0", "file", "\0", match[1]!, "\0", match[2]!, "\0"]) snapshot.update(value);
  const publishPath = path.join(executorPaths(fixture.state, fixture.taskId, fixture.archiveSha, registration.artifact_sha256).directory, "publish", "git-publish.json");
  const common = { publish_version: "1.1" as const, run_id: fixture.runId, base_commit: fixture.baseCommit, branch_name: "codex/task-p9", remote_name: "origin", allowed_remote_url: "https://github.com/example/fixture.git", change_set_sha256: receipt.change_set_digest!, expected_paths: ["app.txt"], approved_snapshot_sha256: snapshot.digest("hex"), created_at: "2026-08-08T00:00:00.000Z" };
  await writeGitPublishReceipt(publishPath, { ...common, state: "READY_FOR_COMMIT", commit_sha: null, remote_branch_sha: null, updated_at: "2026-08-08T00:00:00.000Z", committed_at: null, pushed_at: null });
  const recoveredCandidate = await attestReadyExecutorSnapshot({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config });
  assert.equal(recoveredCandidate.changeSetDigest, receipt.change_set_digest, "an exact commit created just before a receipt-write crash remains recoverable");
  await writeGitPublishReceipt(publishPath, { ...common, state: "PUSHED", commit_sha: commit, remote_branch_sha: commit, updated_at: "2026-08-08T00:00:02.000Z", committed_at: "2026-08-08T00:00:01.000Z", pushed_at: "2026-08-08T00:00:02.000Z" });
  const attested = await attestReadyExecutorSnapshot({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config });
  assert.equal(attested.changeSetDigest, receipt.change_set_digest);
  await fs.writeFile(path.join(fixture.repo, "app.txt"), "post-publish drift\n");
  await assert.rejects(() => attestReadyExecutorSnapshot({ runId: fixture.runId, artifactSha256: registration.artifact_sha256, stateDirectory: fixture.state, configPath: fixture.config }), (error: unknown) => error instanceof ExecutorError && error.code === "EXECUTOR_UNREGISTERED_CHANGE");
});
