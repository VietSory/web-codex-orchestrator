import test from "node:test";
import assert from "node:assert/strict";
import { parseGitHubRepositoryRemote } from "../src/pull-request/github-remote.js";
import { DraftPullRequestError } from "../src/pull-request/contracts.js";

test("P5B-004: GitHub HTTPS remote parsing", () => {
  const valid = [
    "https://github.com/foo/bar",
    "https://github.com/foo-123/bar.git",
    "https://github.com/A-B/C_D.git"
  ];
  for (const v of valid) {
    const res = parseGitHubRepositoryRemote(v);
    assert.ok(res.owner);
    assert.ok(res.repository);
  }

  const invalid = [
    "http://github.com/a/b",
    "git@github.com:a/b.git",
    "https://user:pass@github.com/a/b",
    "https://github.com/a/b:443",
    "https://github.com/a/b?token=123",
    "https://github.com/a/b#123",
    "https://github.com/a/b/c",
    "https://github.com/a",
    "https://github.com/a/b.git/c"
  ];
  for (const inv of invalid) {
    assert.throws(
      () => parseGitHubRepositoryRemote(inv),
      (err) => err instanceof DraftPullRequestError && err.code === "PR_REMOTE_UNSUPPORTED",
      `Expected ${inv} to fail`
    );
  }
});
