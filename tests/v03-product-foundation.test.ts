import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalSlashCommand, commandPalette, parseInteractiveInput } from "../src/tui/slash-commands.js";
import { resolveWcoPaths } from "../src/setup/default-paths.js";
import { resolveGitHubToken } from "../src/setup/credential-provider.js";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";
import { purgeWcoHome } from "../src/uninstall/purge.js";

test("v0.3 slash palette supports idle goals, sealed safety, and /unitsall", () => {
  assert.match(commandPalette(), /\/new\s+Start a new task/);
  assert.equal(canonicalSlashCommand("/unitsall"), "/uninstall");
  assert.deepEqual(parseInteractiveInput("build it", { active: false, sealed: false }), { kind: "new", goal: "build it" });
  assert.equal(parseInteractiveInput("change scope", { active: true, sealed: true }).kind, "sealed_block");
});

test("v0.3 default paths honor explicit, env, WCO_HOME, and platform order", () => {
  const explicit = resolveWcoPaths({ configPath: "/tmp/a.json", stateDirectory: "/tmp/state", env: { WCO_HOME: "/tmp/home" }, platform: "linux", homeDirectory: "/home/u" });
  assert.equal(explicit.config, "/tmp/a.json"); assert.equal(explicit.state, "/tmp/state");
  const env = resolveWcoPaths({ env: { WCO_CONFIG: "/tmp/env.json", WCO_STATE_DIR: "/tmp/env-state", WCO_HOME: "/tmp/home" }, platform: "linux", homeDirectory: "/home/u" });
  assert.equal(env.config, "/tmp/env.json"); assert.equal(env.state, "/tmp/env-state");
  const home = resolveWcoPaths({ env: { WCO_HOME: "/tmp/wco" }, platform: "linux", homeDirectory: "/home/u" });
  assert.equal(home.bridge, "/tmp/wco/bridge");
});

test("gh_cli credential resolver verifies status and returns token only in process", async () => {
  const calls: string[][] = [];
  const token = await resolveGitHubToken({ mode: "gh_cli" }, {}, async (args) => { calls.push(args); return { exitCode: 0, signal: null, stdout: args[1] === "token" ? "secret-token\n" : "ok", stderr: "", stdoutBytes: 1, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false, durationMs: 1 }; });
  assert.equal(token, "secret-token"); assert.deepEqual(calls.map((item) => item.slice(0, 2)), [["auth", "status"], ["auth", "token"]]);
});

test("relay file store is idempotent, rejects conflicts, enforces TTL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-relay-test-")); let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new RelayFileStore(root, {}, () => now);
  const request = { owner: "user", repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) }, user_intent: "goal", ttl_seconds: 60 };
  const first = await store.create("authoring", "user", request, "same", 60); const second = await store.create("authoring", "user", request, "same", 60); assert.deepEqual(second, first);
  const event = await store.append(first.job_id, "user", "repository_command", { request_id: "r", command: { operation: "summary" } }, "event"); assert.equal((await store.append(first.job_id, "user", "repository_command", { request_id: "r", command: { operation: "summary" } }, "event")).sequence, event.sequence);
  await assert.rejects(store.append(first.job_id, "user", "repository_command", { different: true }, "event"), /CONFLICT|Conflicting/i);
  now = new Date("2026-01-01T00:02:00.000Z"); await assert.rejects(store.get(first.job_id, "user"), /expired/i); await assert.rejects(store.create("authoring", "user", request, "same", 60), /expired/i);
});

test("uninstall purge removes only canonical WCO home and preserves registered repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-uninstall-test-")); const home = path.join(root, "owned-home"), repo = path.join(root, "repo"); await mkdir(home); await mkdir(repo); await writeFile(path.join(home, "config.json"), "owned"); await writeFile(path.join(repo, "source.txt"), "keep");
  const config: any = { repositories: { repo: { path: repo } } };
  await purgeWcoHome({ home, config }); assert.equal(await readFile(path.join(repo, "source.txt"), "utf8"), "keep");
  const unsafeHome = path.join(root, "overlap"); await mkdir(unsafeHome); const nestedRepo = path.join(unsafeHome, "repo"); await mkdir(nestedRepo); await assert.rejects(purgeWcoHome({ home: unsafeHome, config: { repositories: { repo: { path: nestedRepo } } } as any }), /PROTECTED/);
});
