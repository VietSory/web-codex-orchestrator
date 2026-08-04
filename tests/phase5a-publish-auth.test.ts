import { strict as assert } from "node:assert";
import test from "node:test";
import { validateConfig } from "../src/config/config-validator.js";
import { preparePublishGitSecurity } from "../src/publish/publish-auth.js";
import { GitRunner } from "../src/git/git-runner.js";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

test("Publish Configuration Validation", () => {
  const baseConfig = {
    config_version: "1.0",
    inbox: { poll_interval_ms: 1000, stable_age_ms: 1000, stable_observations: 1, maximum_candidates_per_scan: 10 },
    repositories: { test: { path: "/test", remote: "origin", expected_remote_urls: ["https://example.com/repo"], fetch_policy: "never" } },
  };

  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "a@b.com" }, authentication: { mode: "none" } } }).ok, true);
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "", email: "a@b.com" }, authentication: { mode: "none" } } }).ok, false);
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "ab" }, authentication: { mode: "none" } } }).ok, false);
  
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "a@b.com" }, authentication: { mode: "https_token", token_environment_key: "WCO_GIT_TOKEN" } } }).ok, true);
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "a@b.com" }, authentication: { mode: "https_token", token_environment_key: "BAD TOKEN" } } }).ok, false);
  
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "a@b.com" }, authentication: { mode: "ssh_agent", socket_environment_key: "SSH_AUTH_SOCK" } } }).ok, true);
  assert.equal(validateConfig({ ...baseConfig, publish: { identity: { name: "A", email: "a@b.com" }, authentication: { mode: "ssh_agent", socket_environment_key: "WRONG_KEY" as any } } }).ok, false);
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
});

test("P5A-020: GitRunner environment scoping scopes vars based on subcommand", async () => {
  const security = {
    identity: { name: "Test User", email: "test@example.com" },
    auth: { askpassScriptPath: "/askpass", askpassToken: "secret123" }
  };

  const runner = new GitRunner({ PATH: "/bin" }, "/runtime", security);

  // Expose safeEnvironment for testing purposes via any cast
  const envForCommit = (runner as any).safeEnvironment("commit");
  assert.equal(envForCommit.GIT_AUTHOR_NAME, "Test User");
  assert.equal(envForCommit.GIT_AUTHOR_EMAIL, "test@example.com");
  assert.equal(envForCommit.GIT_ASKPASS, undefined);
  assert.equal(envForCommit.WCO_GIT_ASKPASS_TOKEN, undefined);

  const envForPush = (runner as any).safeEnvironment("push");
  assert.equal(envForPush.GIT_AUTHOR_NAME, undefined);
  assert.equal(envForPush.GIT_ASKPASS, "/askpass");
  assert.equal(envForPush.WCO_GIT_ASKPASS_TOKEN, "secret123");

  const envForStatus = (runner as any).safeEnvironment("status");
  assert.equal(envForStatus.GIT_AUTHOR_NAME, undefined);
  assert.equal(envForStatus.GIT_ASKPASS, undefined);
  
  // ensure identifySubcommand works
  assert.equal((runner as any).identifySubcommand(["-c", "foo=bar", "--literal-pathspecs", "commit", "-m", "msg"]), "commit");
  assert.equal((runner as any).identifySubcommand(["push", "origin", "main"]), "push");
  assert.equal((runner as any).identifySubcommand(["ls-remote", "origin"]), "ls-remote");
});
