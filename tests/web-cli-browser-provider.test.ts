import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TrustedConfig } from "../src/config/contracts.js";
import { writeTrustedConfigAtomic } from "../src/setup/config-writer.js";
import { resolveWcoPaths } from "../src/setup/default-paths.js";
import { writeProviderPreferences } from "../src/setup/provider-preferences.js";
import { runWebCommand, type WebCommandIo } from "../src/web-bridge/web-cli.js";

function config(repositoryPath: string): TrustedConfig {
  return {
    config_version: "1.0",
    inbox: { poll_interval_ms: 100, stable_age_ms: 100, stable_observations: 2, maximum_candidates_per_scan: 10 },
    repositories: {
      fixture: { path: repositoryPath, remote: "origin", expected_remote_urls: ["https://github.com/example/fixture.git"], fetch_policy: "never" },
    },
  };
}

function captureIo(): { io: WebCommandIo; writes: string[]; errors: string[] } {
  const writes: string[] = [], errors: string[] = [];
  return {
    writes,
    errors,
    io: {
      write(value) { writes.push(value); },
      error(value) { errors.push(value); },
    },
  };
}

test("browser-provider web connect never reports ready when real browser readiness is unproven", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-web-connect-browser-"));
  const previousHome = process.env.WCO_HOME;
  const previousCi = process.env.CI;
  process.env.WCO_HOME = root;
  process.env.CI = "true";
  t.after(async () => {
    if (previousHome === undefined) delete process.env.WCO_HOME; else process.env.WCO_HOME = previousHome;
    if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi;
    await rm(root, { recursive: true, force: true });
  });

  const paths = resolveWcoPaths({});
  const repository = path.join(root, "repo");
  await mkdir(repository, { recursive: true });
  await writeTrustedConfigAtomic(paths.config, config(repository));
  await writeProviderPreferences(paths.state, "chatgpt-web");

  const captured = captureIo();
  const code = await runWebCommand(["connect"], captured.io);

  assert.equal(code, 1);
  assert.equal(captured.writes.length, 0);
  assert.match(captured.errors.join(""), /CHATGPT_WEB_NOT_READY/);
  assert.match(captured.errors.join(""), /readiness probe is disabled in CI/i);
  assert.doesNotMatch(captured.errors.join(""), /CODEX_AUTH_UNAVAILABLE/);
});

test("browser-provider open and disconnect UX never claims local Codex ownership", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-web-ux-browser-"));
  const previousHome = process.env.WCO_HOME;
  process.env.WCO_HOME = root;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.WCO_HOME; else process.env.WCO_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  const paths = resolveWcoPaths({});
  const repository = path.join(root, "repo");
  await mkdir(repository, { recursive: true });
  await writeTrustedConfigAtomic(paths.config, config(repository));
  await writeProviderPreferences(paths.state, "chatgpt-web");

  const open = captureIo();
  assert.equal(await runWebCommand(["open"], open.io), 0);
  assert.match(open.writes.join(""), /ChatGPT Web browser PAIR/);
  assert.doesNotMatch(open.writes.join(""), /local ChatGPT\/Codex/i);

  const disconnect = captureIo();
  assert.equal(await runWebCommand(["disconnect"], disconnect.io), 0);
  assert.match(disconnect.writes.join(""), /no copied ChatGPT Web credential/i);
  assert.doesNotMatch(disconnect.writes.join(""), /bundled official Codex runtime/i);
});
