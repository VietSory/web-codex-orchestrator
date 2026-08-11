import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Regression lock for the post-publish repair crash window. Full executor
 * behavior is exercised by the Phase 10 integration suite; these assertions
 * make the authority choice explicit so a later cleanup cannot silently fall
 * back to trusting observed HEAD or the repaired-but-unpublished digest.
 */
test("post-publish Harness resume is receipt-bound and repair-source aware", async () => {
  const source = await readFile(new URL("../src/executor/resume-source.ts", import.meta.url), "utf8");
  assert.match(source, /readGitPublishReceipt/);
  assert.match(source, /publish\.state !== "PUSHED"/);
  assert.match(source, /publish\.run_id !== options\.runId/);
  assert.match(source, /publish\.base_commit !== options\.baseCommit/);
  assert.match(source, /publish\.branch_name !== options\.branchName/);
  assert.match(source, /publish\.remote_name !== options\.remoteName/);
  assert.match(source, /publish\.allowed_remote_url !== options\.remoteUrl/);
  assert.match(source, /publish\.remote_branch_sha !== publish\.commit_sha/);
  assert.match(source, /executor\.repair\?\.source_change_set_digest \?\? executor\.change_set_digest/);
  assert.doesNotMatch(source, /expectedWorktreeHead\s*=\s*head/);
});
