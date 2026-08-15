import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateConfig } from "../src/config/config-validator.js";
import { productionDoctorProbes, parseControlArgs } from "../src/orchestration/control-cli.js";
import { runDoctor } from "../src/orchestration/doctor.js";
import { writeTrustedConfigAtomic } from "../src/setup/config-writer.js";
import { ContentAddressedContextCache } from "../src/web-bridge/context-cache.js";
import { materializePersonalActionAssets } from "../src/web-bridge/personal-setup.js";
import { ReadCoverageStore } from "../src/web-bridge/read-coverage-store.js";
import { ExactRepositoryReadService } from "../src/web-bridge/repo-read-service.js";
import { PersonalBearerAuthenticator } from "../src/web-bridge/relay/auth.js";
import { RelayFileStore } from "../src/web-bridge/relay/file-store.js";
import { createRelayServer } from "../src/web-bridge/relay/server.js";
import { writeRelayToken } from "../src/web-bridge/relay-credential.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
function base(mode: string, extra: Record<string, unknown> = {}) {
  return { config_version: "1.0", inbox: { poll_interval_ms: 1, stable_age_ms: 1, stable_observations: 1, maximum_candidates_per_scan: 1 }, repositories: { repo: { path: "/tmp/repo", remote: "origin", expected_remote_urls: ["https://github.com/example/repo.git"], fetch_policy: "never" } }, web_bridge: { mode, poll_interval_ms: 1_000, job_ttl_seconds: 86_400, ...extra } };
}

test("personal, managed, legacy relay, and manual Web profiles validate without silent reinterpretation", () => {
  assert.equal(validateConfig(base("personal_actions")).ok, true);
  assert.equal(validateConfig(base("personal_actions", { relay_url: "https://personal.example.test" })).ok, true);
  assert.equal(validateConfig(base("managed_actions")).ok, true);
  assert.equal(validateConfig(base("actions_relay", { relay_url: "https://legacy.example.test", gpt_url: "https://chatgpt.com/g/legacy" })).ok, true);
  assert.equal(validateConfig(base("manual_file")).ok, true);
  assert.equal(validateConfig(base("managed_actions", { relay_url: "https://wrong.example.test" })).ok, false);
});

test("personal GPT Action assets are exact, API-key based, secret-free, and managed metadata free", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-personal-assets-")); t.after(() => rm(root, { recursive: true, force: true }));
  const assets = await materializePersonalActionAssets(root, "https://relay-personal.example.test");
  const schema = await readFile(assets.openapi_path, "utf8"), manifest = await readFile(assets.manifest_path, "utf8");
  assert.match(schema, /wcoApiKey/); assert.match(schema, /type: apiKey/); assert.match(schema, /https:\/\/relay-personal\.example\.test/);
  const parsedManifest = JSON.parse(manifest); assert.equal(parsedManifest.files["openapi.yaml"].sha256, crypto.createHash("sha256").update(schema).digest("hex"));
  assert.doesNotMatch(schema, /oauth|authorizationUrl|tokenUrl|deployment-required\.invalid/i);
  assert.doesNotMatch(`${schema}${manifest}`, /wco_[A-Za-z0-9_-]{20,}|bearer\s+[A-Za-z0-9_-]{20,}/i);
});

test("content-addressed cache avoids repeated bytes but never replaces exact Git/read authority", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-context-cache-")); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"); await exec("git", ["init", "-b", "main", repo]); await exec("git", ["config", "user.name", "Test"], { cwd: repo }); await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, "app.txt"), "exact committed content\n"); await exec("git", ["add", "app.txt"], { cwd: repo }); await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(), receipts = new ReadCoverageStore(path.join(root, "receipts")), cache = new ContentAddressedContextCache(path.join(root, "cache"));
  const reader = new ExactRepositoryReadService(repo, { repository_id: "repo", base_branch: "main", base_commit: baseCommit }, receipts, {}, cache);
  const first = await reader.read("job", "one", ["app.txt"]), sha = first.files[0]!.content_sha256;
  const second = await reader.read("job", "two", ["app.txt"], () => new Date(), { "app.txt": sha });
  assert.equal(first.metrics.cache_misses, 1); assert.equal(second.metrics.cache_hits, 1); assert.equal(second.metrics.context_bytes_transmitted, 0); assert.equal(second.files[0]!.content_ref, `sha256:${sha}`);
  assert.equal((await receipts.list("job")).length, 2, "cache references still require exact read receipts");
  await writeFile(path.join(repo, "app.txt"), "untrusted working tree change\n");
  const third = await reader.read("job", "three", ["app.txt"]); assert.equal(Buffer.from(third.files[0]!.content_base64, "base64").toString(), "exact committed content\n");
  const partial = await reader.execute("job", "four", { operation: "read", regions: [{ path: "app.txt", start_byte: 6, end_byte_exclusive: 15 }] }) as any;
  assert.equal(Buffer.from(partial.files[0].content_base64, "base64").toString(), "committed");
  assert.deepEqual([partial.files[0].start_byte, partial.files[0].end_byte_exclusive, partial.files[0].total_bytes], [6, 15, 24]);
  assert.equal((await receipts.list("job")).find((receipt) => receipt.request_id === "four")?.start_byte, 6);
  await assert.rejects(() => reader.execute("job", "bad", { operation: "read", paths: ["app.txt"], regions: [{ path: "app.txt", start_byte: 0, end_byte_exclusive: 1 }] }), /exactly one/i);
  const blobSha = first.files[0]!.blob_sha, cacheKey = `${baseCommit}\0${blobSha}\0full`, cacheFile = path.join(root, "cache", `${crypto.createHash("sha256").update(cacheKey).digest("hex")}.json`);
  await writeFile(cacheFile, '{"schema_version":"1.0","content_base64":"tampered"}');
  const rebuilt = await reader.read("job", "five", ["app.txt"]);
  assert.equal(rebuilt.metrics.cache_misses, 1); assert.equal(Buffer.from(rebuilt.files[0]!.content_base64, "base64").toString(), "exact committed content\n");
});

test("doctor personal profile probes bearer relay without OAuth/device/account and manual profile is offline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-profile-doctor-")); t.after(() => rm(root, { recursive: true, force: true }));
  const token = `token-${"x".repeat(40)}`, store = new RelayFileStore(path.join(root, "relay"));
  const server = createRelayServer({ store, authenticator: new PersonalBearerAuthenticator([{ owner: "personal", token }]) }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const configPath = path.join(root, "config.json"), state = path.join(root, "state"), credentials = path.join(root, "credentials");
  await writeTrustedConfigAtomic(configPath, base("personal_actions", { relay_url: `http://127.0.0.1:${address.port}` }) as any); await writeRelayToken(credentials, token);
  const old = process.env.WCO_HOME; process.env.WCO_HOME = root;
  try {
    const args = parseControlArgs("doctor", ["--state-dir", state, "--config", configPath, "--mode", "PAIR"]), report = await runDoctor(productionDoctorProbes(args), { maximum_concurrency: 1 });
    assert.match(report.checks.find((item) => item.id === "wco-relay-service")?.summary ?? "", /personal bearer relay reachable/);
    assert.match(report.checks.find((item) => item.id === "wco-device-account")?.summary ?? "", /no managed device\/account requirement/);
    const manualPath = path.join(root, "manual.json"); await writeTrustedConfigAtomic(manualPath, base("manual_file") as any);
    const manual = await runDoctor(productionDoctorProbes(parseControlArgs("doctor", ["--state-dir", state, "--config", manualPath, "--mode", "PAIR"])), { maximum_concurrency: 1 });
    assert.match(manual.checks.find((item) => item.id === "wco-relay-service")?.summary ?? "", /no relay probe required/);
  } finally { if (old === undefined) delete process.env.WCO_HOME; else process.env.WCO_HOME = old; }
});

test("personal bearer rotation accepts bounded overlap without cross-mailbox routing", () => {
  const oldToken = `old-${crypto.randomBytes(32).toString("base64url")}`, newToken = `new-${crypto.randomBytes(32).toString("base64url")}`;
  const auth = new PersonalBearerAuthenticator([{ owner: "personal", token: oldToken }, { owner: "personal", token: newToken }]);
  assert.deepEqual(auth.authenticate(`Bearer ${oldToken}`), { owner: "personal" }); assert.deepEqual(auth.authenticate(`Bearer ${newToken}`), { owner: "personal" });
  assert.throws(() => auth.authenticate(`Bearer ${crypto.randomBytes(32).toString("base64url")}`), /failed/i);
});
