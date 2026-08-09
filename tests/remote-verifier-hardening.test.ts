import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitRunner } from "../src/git/git-runner.js";
import { GitBoundaryError, type ResolvedRepository } from "../src/git/contracts.js";
import { verifyRemote } from "../src/git/remote-verifier.js";

async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-remote-verify-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  const runner = new GitRunner(process.env);
  const init = await runner.run(["init"], repo);
  assert.equal(init.exitCode, 0, init.stderr);
  const trusted = "https://github.com/owner/trusted.git";
  const add = await runner.run(["remote", "add", "origin", trusted], repo);
  assert.equal(add.exitCode, 0, add.stderr);
  const repository: ResolvedRepository = {
    id: "fixture",
    configured_path: repo,
    path: repo,
    remote: "origin",
    expected_remote_urls: [trusted],
    fetch_policy: "never",
  };
  return { repo, runner, trusted, repository };
}

test("REMOTE-HARDEN-001 rejects an untrusted pushurl even when fetch URL is trusted", async (t) => {
  const f = await fixture(t);
  const configured = await f.runner.run(["remote", "set-url", "--push", "origin", "https://github.com/attacker/sink.git"], f.repo);
  assert.equal(configured.exitCode, 0, configured.stderr);
  await assert.rejects(
    () => verifyRemote(f.repository, f.runner),
    (error: unknown) => error instanceof GitBoundaryError && error.code === "REMOTE_URL_MISMATCH",
  );
});

test("REMOTE-HARDEN-002 rejects any extra untrusted fetch URL", async (t) => {
  const f = await fixture(t);
  const configured = await f.runner.run(["remote", "set-url", "--add", "origin", "https://github.com/attacker/mirror.git"], f.repo);
  assert.equal(configured.exitCode, 0, configured.stderr);
  await assert.rejects(
    () => verifyRemote(f.repository, f.runner),
    (error: unknown) => error instanceof GitBoundaryError && error.code === "REMOTE_URL_MISMATCH",
  );
});

test("REMOTE-HARDEN-003 accepts only trusted effective fetch and push URLs", async (t) => {
  const f = await fixture(t);
  const verified = await verifyRemote(f.repository, f.runner);
  assert.equal(verified.matched_url, f.trusted);
  assert.deepEqual(verified.urls, [f.trusted]);
});
