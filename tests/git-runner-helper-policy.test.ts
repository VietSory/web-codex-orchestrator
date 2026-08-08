import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitRunner } from "../src/git/git-runner.js";

async function expectGit(runner: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t: test.TestContext): Promise<{ root: string; repo: string; runtime: string; bootstrap: GitRunner }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wco-git-helper-policy-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const runtime = path.join(root, "runtime");
  await fs.mkdir(repo);
  await fs.mkdir(path.join(runtime, "empty-hooks"), { recursive: true });
  await fs.writeFile(path.join(runtime, "empty-config"), "", { mode: 0o600 });
  const bootstrap = new GitRunner(process.env);
  await expectGit(bootstrap, repo, ["init"]);
  await expectGit(bootstrap, repo, ["config", "user.name", "WCO Test"]);
  await expectGit(bootstrap, repo, ["config", "user.email", "wco@example.invalid"]);
  return { root, repo, runtime, bootstrap };
}

test("GIT-HELPER-001 blocks local clean/process filters before filter-aware check-in commands", async (t) => {
  const { root, repo, runtime, bootstrap } = await fixture(t);
  const marker = path.join(root, "FILTER_EXECUTED");
  await fs.writeFile(path.join(repo, "victim.txt"), "payload\n");
  await fs.writeFile(path.join(repo, ".gitattributes"), "victim.txt filter=wco-probe\n");
  await expectGit(bootstrap, repo, ["config", "filter.wco-probe.clean", `node -e \"require('fs').writeFileSync('${marker.replaceAll("\\", "\\\\")}', 'x')\"`]);

  const hardened = new GitRunner(process.env, runtime);
  for (const args of [
    ["hash-object", "--path=victim.txt", "--", "victim.txt"],
    ["--literal-pathspecs", "add", "-A", "--", "victim.txt"],
  ]) {
    const result = await hardened.run(args, repo);
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /WCO_GIT_UNSAFE_CONFIG/);
    assert.equal(await fs.lstat(marker).then(() => true, () => false), false);
  }
});

test("GIT-HELPER-002 blocks local credential and transport-program helpers before network transport", async (t) => {
  const { repo, runtime, bootstrap } = await fixture(t);
  await expectGit(bootstrap, repo, ["config", "credential.helper", "!definitely-must-not-run"]);
  const hardened = new GitRunner(process.env, runtime);
  const credentialResult = await hardened.run(["ls-remote", "--heads", "origin"], repo);
  assert.equal(credentialResult.exitCode, 3);
  assert.match(credentialResult.stderr, /WCO_GIT_UNSAFE_CONFIG/);
  assert.match(credentialResult.stderr, /credential\.helper/);

  await expectGit(bootstrap, repo, ["config", "--unset-all", "credential.helper"]);
  await expectGit(bootstrap, repo, ["config", "remote.origin.receivepack", "definitely-must-not-run"]);
  const receivePackResult = await hardened.run(["push", "origin", "HEAD:refs/heads/probe"], repo);
  assert.equal(receivePackResult.exitCode, 3);
  assert.match(receivePackResult.stderr, /WCO_GIT_UNSAFE_CONFIG/);
  assert.match(receivePackResult.stderr, /remote\.origin\.receivepack/);

  await expectGit(bootstrap, repo, ["config", "--unset-all", "remote.origin.receivepack"]);
  await expectGit(bootstrap, repo, ["config", "remote.origin.uploadpack", "definitely-must-not-run"]);
  const uploadPackResult = await hardened.run(["fetch", "origin"], repo);
  assert.equal(uploadPackResult.exitCode, 3);
  assert.match(uploadPackResult.stderr, /WCO_GIT_UNSAFE_CONFIG/);
  assert.match(uploadPackResult.stderr, /remote\.origin\.uploadpack/);
});
