import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { publishedResumeDigestIsAllowed } from "../src/executor/resume-source.js";

/**
 * Regression lock for post-publish repair crash windows. Keep the immutable
 * publication identity checks visible, but assert change-set generation policy
 * behaviorally rather than pinning an obsolete implementation expression.
 */
test("post-publish Harness resume is receipt-bound and accepts only exact current/source generations", async () => {
  const source = await readFile(new URL("../src/executor/resume-source.ts", import.meta.url), "utf8");
  assert.match(source, /readGitPublishReceipt/);
  assert.match(source, /publish\.state !== "PUSHED"/);
  assert.match(source, /publish\.run_id !== options\.runId/);
  assert.match(source, /publish\.base_commit !== options\.baseCommit/);
  assert.match(source, /publish\.branch_name !== options\.branchName/);
  assert.match(source, /publish\.remote_name !== options\.remoteName/);
  assert.match(source, /publish\.allowed_remote_url !== options\.remoteUrl/);
  assert.match(source, /publish\.remote_branch_sha !== publish\.commit_sha/);
  assert.doesNotMatch(source, /expectedWorktreeHead\s*=\s*head/);

  const sourceDigest = "1".repeat(64);
  const currentDigest = "2".repeat(64);
  const unrelatedDigest = "3".repeat(64);
  assert.equal(publishedResumeDigestIsAllowed(currentDigest, undefined, currentDigest), true);
  assert.equal(publishedResumeDigestIsAllowed(currentDigest, undefined, sourceDigest), false);
  assert.equal(publishedResumeDigestIsAllowed(currentDigest, sourceDigest, sourceDigest), true, "repair-before-republish may still bind the exact source generation");
  assert.equal(publishedResumeDigestIsAllowed(currentDigest, sourceDigest, currentDigest), true, "after republish the exact repaired/current generation is authoritative");
  assert.equal(publishedResumeDigestIsAllowed(currentDigest, sourceDigest, unrelatedDigest), false, "a third generation can never authorize resume");
});
