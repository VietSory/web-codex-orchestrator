import { strict as assert } from "node:assert";
import test from "node:test";
import { validateConfig } from "../src/config/config-validator.js";
import { preparePublishGitSecurity } from "../src/publish/publish-auth.js";
import { GitRunner } from "../src/git/git-runner.js";

test("Publish Configuration Validation", () => {
  const baseConfig = {
    config_version: "1.0",
    inbox: { poll_interval_ms: 1000, stable_age_ms: 1000, stable_observations: 1, maximum_candidates_per_scan: 10 },
    repositories: { test: { path: "/test", remote: "origin", expected_remote_urls: ["https://example.com/repo"], fetch_policy: "never" } },
  };

  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "a@b.com" }, authentication: { mode: "none" } } }).ok, true);
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: " A ", email: "a@b.com" }, authentication: { mode: "none" } } }).ok, false);
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "", email: "a@b.com" }, authentication: { mode: "none" } } }).ok, false);
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "ab" }, authentication: { mode: "none" } } }).ok, false);
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "a@b.com" }, authentication: { mode: "none", token_environment_key: "WCO_GIT_TOKEN" } as any } }).ok, false);
  
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "a@b.com" }, authentication: { mode: "https_token", token_environment_key: "WCO_GIT_TOKEN" } } }).ok, true);
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "a@b.com" }, authentication: { mode: "https_token", token_environment_key: "BAD TOKEN" } } }).ok, false);
  
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "a@b.com" }, authentication: { mode: "ssh_agent" as any, socket_environment_key: "SSH_AUTH_SOCK" } as any } }).ok, false);
});

test("P5A-018: preparePublishGitSecurity throws PUBLISH_AUTH_UNAVAILABLE if config is missing", async () => {
  await assert.rejects(
    preparePublishGitSecurity(undefined, "https://github.com", "/tmp", {}),
    { code: "PUBLISH_AUTH_UNAVAILABLE" }
  );
});

test("P5A-019: missing HTTPS token throws PUBLISH_AUTH_UNAVAILABLE", async () => {
  const config = {
    identity: { name: "Test", email: "test@example.com" },
    authentication: { mode: "https_token" as const, token_environment_key: "WCO_GIT_TEST_TOKEN" }
  };
  await assert.rejects(
    preparePublishGitSecurity(config, "https://github.com", "/tmp", {}),
    { code: "PUBLISH_AUTH_UNAVAILABLE" }
  );
  await assert.rejects(
    preparePublishGitSecurity(config, "https://github.com", "/tmp", { WCO_GIT_TEST_TOKEN: "tok\nen" }),
    { code: "PUBLISH_AUTH_UNAVAILABLE" }
  );
  await assert.rejects(
    preparePublishGitSecurity(config, "https://github.com", "/tmp", { WCO_GIT_TEST_TOKEN: " tok en " }),
    { code: "PUBLISH_AUTH_UNAVAILABLE" }
  );
});

test("P5A-020: GitRunner environment scoping scopes vars based on subcommand", async () => {
  const security = {
    identity: { name: "Test User", email: "test@example.com" },
    auth: { mode: "https_token" as const, askpassScriptPath: "/askpass", askpassToken: "secret123" }
  };

  const runner = new GitRunner({ PATH: "/bin" }, "/runtime", security);

  const envForCommit = (runner as any).safeEnvironment("commit", undefined);
  assert.equal(envForCommit.GIT_AUTHOR_NAME, "Test User");
  assert.equal(envForCommit.GIT_AUTHOR_EMAIL, "test@example.com");
  assert.equal(envForCommit.GIT_ASKPASS, undefined);
  assert.equal(envForCommit.WCO_GIT_ASKPASS_TOKEN, undefined);

  const envForVarIdent = (runner as any).safeEnvironment("var", "GIT_AUTHOR_IDENT");
  assert.equal(envForVarIdent.GIT_AUTHOR_NAME, "Test User");
  
  const envForVarOther = (runner as any).safeEnvironment("var", "-l");
  assert.equal(envForVarOther.GIT_AUTHOR_NAME, undefined);

  const envForPush = (runner as any).safeEnvironment("push", undefined);
  assert.equal(envForPush.GIT_AUTHOR_NAME, undefined);
  assert.equal(envForPush.GIT_ASKPASS, "/askpass");
  assert.equal(envForPush.WCO_GIT_ASKPASS_TOKEN, "secret123");

  const envForStatus = (runner as any).safeEnvironment("status", undefined);
  assert.equal(envForStatus.GIT_AUTHOR_NAME, undefined);
  assert.equal(envForStatus.GIT_ASKPASS, undefined);
  
  assert.deepEqual((runner as any).getCommandTarget(["-c", "foo=bar", "--literal-pathspecs", "commit", "-m", "msg"]), { subcommand: "commit", varTarget: "-m" });
  assert.deepEqual((runner as any).getCommandTarget(["push", "origin", "main"]), { subcommand: "push", varTarget: "origin" });
  assert.deepEqual((runner as any).getCommandTarget(["ls-remote", "origin"]), { subcommand: "ls-remote", varTarget: "origin" });
});

import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

test("P5A-024: preparePublishGitSecurity handles askpass symlink/permission checks safely", async () => {
  const config = {
    identity: { name: "Test", email: "test@example.com" },
    authentication: { mode: "https_token" as const, token_environment_key: "WCO_GIT_TEST_TOKEN" }
  };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wco-test-"));
  try {
    const security = await preparePublishGitSecurity(config, "https://github.com", tempDir, { WCO_GIT_TEST_TOKEN: "secret123" });
    assert.equal(security.mode, "https_token");
    if (security.mode === "https_token") {
      assert.equal(security.askpassToken, "secret123");
      assert.ok(security.askpassScriptPath.startsWith(tempDir));
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

