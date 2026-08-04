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


import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, symlink, chmod, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";


test("P5A-020: GitRunner environment redacts output and scopes identity/token strictly", async () => {
  const security = {
    identity: { name: "Test User", email: "test@example.com" },
    auth: { mode: "https_token" as const, askpassScriptPath: "/askpass", askpassToken: "secret123" }
  };

  const tempBase = await mkdtemp(path.join(os.tmpdir(), "wco-test-fake-git-"));
  try {
    const fakeGitPath = path.join(tempBase, "git" + (os.platform() === "win32" ? ".cmd" : ""));
    if (os.platform() === "win32") {
      await import("node:fs/promises").then(fs => fs.writeFile(fakeGitPath, `@echo off\nnode -e "console.log(JSON.stringify({args: process.argv.slice(1), env: process.env}))" %*`));
    } else {
      await import("node:fs/promises").then(fs => fs.writeFile(fakeGitPath, `#!/usr/bin/env node\nconsole.log(JSON.stringify({args: process.argv.slice(2), env: process.env}));`));
      await import("node:fs/promises").then(fs => fs.chmod(fakeGitPath, 0o755));
    }

    const runnerEnv = { ...process.env, PATH: tempBase + path.delimiter + (process.env.PATH || "") };
    const runner = new GitRunner(runnerEnv, undefined, security);

    // Test 1: commit receives identity but NOT token
    const resCommit = await runner.run(["commit", "-m", "msg"], tempBase);
    if (resCommit.exitCode !== 0) throw new Error("Commit failed: " + resCommit.stderr + " | stdout: " + resCommit.stdout);
    const commitData = JSON.parse(resCommit.stdout);
    assert.equal(commitData.env.GIT_AUTHOR_NAME, "Test User");
    assert.equal(commitData.env.GIT_AUTHOR_EMAIL, "test@example.com");
    assert.equal(commitData.env.GIT_COMMITTER_NAME, "Test User");
    assert.equal(commitData.env.GIT_COMMITTER_EMAIL, "test@example.com");
    assert.equal(commitData.env.WCO_GIT_ASKPASS_TOKEN, undefined);

    // Test 2: push receives token but NOT identity
    const resPush = await runner.run(["push", "origin"], tempBase);
    const pushData = JSON.parse(resPush.stdout);
    assert.equal(pushData.env.GIT_AUTHOR_NAME, undefined);
    assert.equal(pushData.env.WCO_GIT_ASKPASS_TOKEN, "[REDACTED]");

    // Test 3: status/add/diff receives neither
    const resStatus = await runner.run(["status"], tempBase);
    const statusData = JSON.parse(resStatus.stdout);
    assert.equal(statusData.env.GIT_AUTHOR_NAME, undefined);
    assert.equal(statusData.env.WCO_GIT_ASKPASS_TOKEN, undefined);

    // var -l should not receive identity
    const resVar = await runner.run(["var", "-l"], tempBase);
    assert.doesNotMatch(resVar.stdout, /Test User/);

    // Test 4: stdout/stderr redaction
    if (os.platform() === "win32") {
      await import("node:fs/promises").then(fs => fs.writeFile(fakeGitPath, `@echo off\necho Leaking token secret123 and secret123!\n>&2 echo Error secret123 leak`));
    } else {
      await import("node:fs/promises").then(fs => fs.writeFile(fakeGitPath, `#!/usr/bin/env node\nconsole.log("Leaking token secret123 and secret123!");\nconsole.error("Error secret123 leak");`));
    }
    const resLeak = await runner.run(["push", "origin"], tempBase);
    assert.doesNotMatch(resLeak.stdout, /secret123/);
    assert.match(resLeak.stdout, /\[REDACTED\]/);
    assert.doesNotMatch(resLeak.stderr, /secret123/);
    assert.match(resLeak.stderr, /\[REDACTED\]/);

  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
});

test("P5A-024: preparePublishGitSecurity handles askpass symlink/permission checks safely", async () => {
  const config = {
    identity: { name: "Test", email: "test@example.com" },
    authentication: { mode: "https_token" as const, token_environment_key: "WCO_GIT_TEST_TOKEN" }
  };
  
  const tempBase = await mkdtemp(path.join(os.tmpdir(), "wco-test-"));
  const tempDir = path.join(tempBase, "real-dir");
  const symlinkDir = path.join(tempBase, "symlink-dir");
  const externalSentinel = path.join(tempBase, "sentinel.txt");
  
  try {
    await mkdir(tempDir, { recursive: true });
    await import("node:fs/promises").then(fs => fs.writeFile(externalSentinel, "untouched"));
    await symlink(tempDir, symlinkDir, "dir");

    // 1. Symlink directory should be rejected
    await assert.rejects(
      preparePublishGitSecurity(config, "https://github.com", symlinkDir, { WCO_GIT_TEST_TOKEN: "secret123" }),
      { code: "PUBLISH_AUTH_UNAVAILABLE", message: /symlink/i }
    );
    
    // verify sentinel unchanged
    assert.equal(await import("node:fs/promises").then(fs => fs.readFile(externalSentinel, "utf8")), "untouched");

    // 2. Real directory should pass and generate a script
    const security = await preparePublishGitSecurity(config, "https://github.com", tempDir, { WCO_GIT_TEST_TOKEN: "secret123" });
    
    // 3. Verify permissions (must be 0o700 for directories and the file)
    if (os.platform() !== "win32") {
      const { stat, lstat } = await import("node:fs/promises");
      const authDirStat = await stat(path.dirname(security.askpassScriptPath));
      assert.equal(authDirStat.mode & 0o777, 0o700);
      
      const fileStat = await stat(security.askpassScriptPath);
      assert.equal(fileStat.mode & 0o777, 0o700);
      
      const lStat = await lstat(security.askpassScriptPath);
      assert.ok(lStat.isFile(), "Helper must be a regular file, not a symlink");
    }
    
    // 4. Assert no token inside the source file
    const helperSource = await import("node:fs/promises").then(fs => fs.readFile(security.askpassScriptPath, "utf8"));
    assert.doesNotMatch(helperSource, /secret123/);
    
    // 5. Actually execute the script and check its output
    const resUsername = spawnSync(process.execPath, [security.askpassScriptPath, "Username for..."], {
      env: { ...process.env, WCO_GIT_ASKPASS_TOKEN: "secret123" }
    });
    assert.equal(resUsername.stdout.toString(), "x-access-token\n");
    assert.equal(resUsername.status, 0);

    const resPassword = spawnSync(process.execPath, [security.askpassScriptPath, "Password for..."], {
      env: { ...process.env, WCO_GIT_ASKPASS_TOKEN: "secret123" }
    });
    assert.equal(resPassword.stdout.toString(), "secret123\n");
    assert.equal(resPassword.status, 0);
    
    // 6. Unknown prompt must exit non-zero
    const resUnknown = spawnSync(process.execPath, [security.askpassScriptPath, "What is the matrix?"], {
      env: { ...process.env, WCO_GIT_ASKPASS_TOKEN: "secret123" }
    });
    assert.notEqual(resUnknown.status, 0);

  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
});
