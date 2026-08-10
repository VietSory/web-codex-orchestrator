import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const keep = process.env.WCO_KEEP_PACKED_USER_JOURNEY === "1";
const workspace = await mkdtemp(path.join(os.tmpdir(), "wco-packed-user-journey-"));
const npmCache = path.join(workspace, "npm-cache");
const prefix = path.join(workspace, "install");
const home = path.join(workspace, "home");
const wcoHome = path.join(home, "wco");
const fixtures = path.join(workspace, "fixtures");
const evidence = path.join(workspace, "evidence");
const browserBin = path.join(workspace, "browser-bin");
const browserLog = path.join(evidence, "browser-opened.log");
const managedGptUrl = "https://chatgpt.com/g/wco-packed-managed";
const results = [];
let tarball;
let managedRelayUrl = "";
let managedServer;
let managedRevocations = 0;
let managedJobs = 0;

function safeEnvironment(extra = {}) {
  return {
    ...process.env,
    HOME: home,
    WCO_HOME: wcoHome,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    npm_config_cache: npmCache,
    GH_PROMPT_DISABLED: "1",
    WCO_MANAGED_WEB_TEST_OVERRIDE: "1",
    WCO_MANAGED_WEB_RELAY_URL: managedRelayUrl,
    WCO_MANAGED_WEB_GPT_URL: managedGptUrl,
    ...extra,
  };
}

async function run(command, args, options = {}) {
  const stdout = [], stderr = [];
  const maximum = options.maximumOutputBytes ?? 4 * 1024 * 1024;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? safeEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let bytes = 0, timedOut = false, outputExceeded = false;
    const append = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > maximum) {
        outputExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 60_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        outputExceeded,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(options.input ?? "");
  });
}

async function checked(command, args, options = {}) {
  const result = await run(command, args, options);
  assert.equal(result.timedOut, false, `${command} timed out`);
  assert.equal(result.outputExceeded, false, `${command} exceeded the output bound`);
  assert.equal(result.code, 0, `${command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

async function check(id, description, action) {
  try {
    await action();
    results.push({ id, status: "PASS", description });
    process.stdout.write(`PASS ${id} ${description}\n`);
  } catch (error) {
    results.push({ id, status: "FAIL", description, error: error instanceof Error ? error.message : String(error) });
    process.stderr.write(`FAIL ${id} ${description}\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    throw error;
  }
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function createRepository(name, options = {}) {
  const repository = path.join(fixtures, name);
  await mkdir(path.join(repository, "src"), { recursive: true });
  if (options.node !== false) {
    await writeFile(path.join(repository, "package.json"), `${JSON.stringify({ name, version: "1.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
    await writeFile(path.join(repository, "src", "app.js"), "export const value = 1;\n");
  } else {
    await writeFile(path.join(repository, "README.md"), `# ${name}\n`);
  }
  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    const target = path.join(repository, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await checked("git", ["init", "-b", "main"], { cwd: repository });
  await checked("git", ["config", "user.name", "WCO Packed Journey"], { cwd: repository });
  await checked("git", ["config", "user.email", "wco-packed@example.invalid"], { cwd: repository });
  await checked("git", ["add", "."], { cwd: repository });
  await checked("git", ["commit", "-m", "fixture baseline"], { cwd: repository });
  if (options.remote !== false) {
    await checked("git", ["remote", "add", "origin", `https://github.com/example/${name}.git`], { cwd: repository });
  }
  return repository;
}

function installedBinary() {
  return process.platform === "win32" ? path.join(prefix, "wco.cmd") : path.join(prefix, "bin", "wco");
}

async function wco(args, options = {}) {
  return await run(installedBinary(), args, {
    ...options,
    env: safeEnvironment({ PATH: `${browserBin}${path.delimiter}${path.dirname(installedBinary())}${path.delimiter}${process.env.PATH ?? ""}`, ...(options.env ?? {}) }),
  });
}

async function wcoTty(repository, steps, options = {}) {
  assert.equal(process.platform, "linux", "packed TUI journey currently targets the primary Linux/WSL environment");
  const journeyHome = options.home ?? home;
  const journeyWcoHome = options.wcoHome ?? (journeyHome === home ? wcoHome : path.join(journeyHome, "wco"));
  const command = `env HOME=${journeyHome} WCO_HOME=${journeyWcoHome} XDG_CONFIG_HOME=${path.join(journeyHome, ".config")} XDG_STATE_HOME=${path.join(journeyHome, ".local/state")} XDG_CACHE_HOME=${path.join(journeyHome, ".cache")} WCO_MANAGED_WEB_TEST_OVERRIDE=1 WCO_MANAGED_WEB_RELAY_URL=${managedRelayUrl} WCO_MANAGED_WEB_GPT_URL=${managedGptUrl} PATH=${browserBin}:${path.dirname(installedBinary())}:/usr/local/bin:/usr/bin:/bin ${installedBinary()}`;
  return await new Promise((resolve, reject) => {
    const child = spawn("script", ["--quiet", "--return", "--echo", "never", "--command", command, "/dev/null"], {
      cwd: repository,
      env: safeEnvironment(),
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [], stderr = [];
    let source = "", cursor = 0, index = 0, timedOut = false;
    const advance = () => {
      while (index < steps.length) {
        const pattern = steps[index].waitFor;
        const available = source.slice(cursor);
        const match = typeof pattern === "string" ? (() => { const at = available.indexOf(pattern); return at < 0 ? null : { index: at, 0: pattern }; })() : pattern.exec(available);
        if (!match) return;
        cursor += match.index + match[0].length;
        const step = steps[index];
        index += 1;
        if (step.stop) { try { process.kill(-child.pid, "SIGINT"); } catch { child.kill("SIGINT"); } return; }
        child.stdin.write(step.send);
      }
    };
    child.stdout.on("data", (chunk) => { stdout.push(chunk); source += chunk.toString("utf8"); advance(); });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }, options.timeoutMs ?? 45_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      child.stdin.end();
      resolve({ code, signal, timedOut, outputExceeded: false, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), completedSteps: index });
    });
  });
}

try {
  await mkdir(evidence, { recursive: true });
  await mkdir(browserBin, { recursive: true });
  await writeFile(path.join(browserBin, "xdg-open"), `#!/usr/bin/env bash
printf '%s\n' "$1" >> '${browserLog}'
exit 0
`);
  await chmod(path.join(browserBin, "xdg-open"), 0o755);
  const devices = new Map();
  managedServer = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (status, value) => { const bytes = Buffer.from(JSON.stringify(value)); response.writeHead(status, { "Content-Type": "application/json", "Content-Length": bytes.length, "Cache-Control": "no-store" }); response.end(bytes); };
    const url = new URL(request.url ?? "/", "http://managed.invalid");
    if (request.method === "GET" && url.pathname === "/v1/managed/service/status") { send(200, { protocol_version: "wco-web-bridge-v1", available: true, chatgpt_oauth_configured: true, senior_architect_gpt_configured: true }); return; }
    if (request.method === "POST" && url.pathname === "/v1/managed/device/registrations") { const registration = `registration-${devices.size + 1}`; devices.set(registration, body.device_id); send(201, { registration_id: registration, device_code: `device-code-${devices.size}`, verification_uri_complete: managedGptUrl, expires_in: 600, interval: 1 }); return; }
    if (request.method === "POST" && url.pathname === "/v1/managed/device/token") { const expected = devices.get(body.registration_id); if (!expected || expected !== body.device_id) { send(400, { error: "expired_token" }); return; } devices.delete(body.registration_id); send(200, { token_type: "Bearer", access_token: "packed-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", refresh_token: "packed-refresh-token-rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr", expires_in: 3_600, account_id: "packed-account", device_id: body.device_id, scope: "wco.relay" }); return; }
    if (request.method === "POST" && url.pathname === "/v1/managed/token/refresh") { send(200, { token_type: "Bearer", access_token: "packed-refreshed-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", refresh_token: "packed-rotated-token-ssssssssssssssssssssssssssssssss", expires_in: 3_600, account_id: "packed-account", device_id: body.device_id, scope: "wco.relay" }); return; }
    if (request.method === "POST" && url.pathname === "/v1/managed/device/revoke") { managedRevocations += 1; send(200, { revoked: true }); return; }
    if (request.headers.authorization?.startsWith("Bearer ") !== true) { send(401, { error: "unauthorized" }); return; }
    if (request.method === "GET" && url.pathname === "/v1/status") { send(200, { configured: true, connected: true, pending_author_job: null, pending_final_review: null }); return; }
    if (request.method === "POST" && url.pathname === "/v1/authoring/jobs") { managedJobs += 1; const created = new Date().toISOString(); send(201, { protocol_version: "wco-web-bridge-v1", job_id: `job-packed-${managedJobs}`, owner: "packed-account", created_at: created, expires_at: new Date(Date.now() + 3_600_000).toISOString(), content_sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") }); return; }
    if (request.method === "GET" && /^\/v1\/jobs\/[^/]+\/local-events$/.test(url.pathname)) { send(200, { event: null }); return; }
    send(404, { error: "not_found" });
  });
  await new Promise((resolve, reject) => { managedServer.once("error", reject); managedServer.listen(0, "127.0.0.1", resolve); });
  const managedAddress = managedServer.address();
  assert.ok(managedAddress && typeof managedAddress === "object");
  managedRelayUrl = `http://127.0.0.1:${managedAddress.port}`;
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  tarball = path.join(root, `${pkg.name}-${pkg.version}.tgz`);

  await check("PACKED-001", "build and pack the exact distributable", async () => {
    await checked(npm, ["pack", "--json"], { env: safeEnvironment(), timeoutMs: 120_000 });
    assert.equal(await exists(tarball), true);
    const bytes = await readFile(tarball);
    await writeFile(path.join(evidence, "candidate.sha256"), `${createHash("sha256").update(bytes).digest("hex")}  ${path.basename(tarball)}\n`);
  });

  await check("INSTALL-012", "package surface contains runtime assets without development leakage", async () => {
    const listing = await checked("tar", ["-tzf", tarball], { cwd: workspace });
    for (const directory of ["dist", "docs", "examples", "schemas", "templates", "web"]) assert.match(listing.stdout, new RegExp(`^package/${directory}/`, "m"));
    assert.doesNotMatch(listing.stdout, /^package\/(?:src|tests|scratch)\//m);
  });

  await check("INSTALL-001/005", "clean global-prefix production-only install", async () => {
    await checked(npm, ["install", "--global", "--prefix", prefix, "--omit=dev", "--ignore-scripts", tarball], { cwd: workspace, timeoutMs: 120_000 });
    assert.equal(await exists(installedBinary()), true);
  });

  await check("INSTALL-002/003/004/009", "installed binary owns version/help/PATH outside checkout", async () => {
    const version = await wco(["--version"], { cwd: workspace });
    assert.equal(version.code, 0);
    assert.equal(version.stdout.trim(), pkg.version);
    const help = await wco(["--help"], { cwd: workspace });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Interactive UI/);
    assert.doesNotMatch(help.stderr, /ERR_MODULE_NOT_FOUND|node_modules\/web-codex-orchestrator\/src/);
    const pathResult = await checked("bash", ["-c", "command -v wco"], { cwd: workspace, env: safeEnvironment({ PATH: `${path.dirname(installedBinary())}:/usr/bin:/bin` }) });
    assert.equal(pathResult.stdout.trim(), installedBinary());
  });

  await check("INSTALL-006", "same-version reinstall is idempotent", async () => {
    await checked(npm, ["install", "--global", "--prefix", prefix, "--omit=dev", "--ignore-scripts", tarball], { cwd: workspace, timeoutMs: 120_000 });
    assert.equal((await wco(["--version"], { cwd: workspace })).stdout.trim(), pkg.version);
  });

  await check("INSTALL-011", "failed npm install never creates a ready WCO binary", async () => {
    const failedPrefix = path.join(workspace, "failed-install");
    const result = await run(npm, ["install", "--global", "--prefix", failedPrefix, path.join(workspace, "missing.tgz")], { cwd: workspace });
    assert.notEqual(result.code, 0);
    assert.equal(await exists(path.join(failedPrefix, "bin", "wco")), false);
  });

  const nodeRepo = await createRepository("fixture-node-api");
  const devopsRepo = await createRepository("fixture-devops", {
    node: false,
    files: {
      "Dockerfile": "FROM scratch\n",
      ".github/workflows/ci.yml": "name: fixture\non: [push]\njobs: {}\n",
      "infra/main.tf": "terraform { required_version = \">= 1.6.0\" }\n",
      "k8s/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: fixture\n",
    },
  });
  const monorepoRepo = await createRepository("fixture-monorepo", {
    files: {
      "packages/api/package.json": "{\"name\":\"fixture-api\",\"private\":true}\n",
      "packages/api/src/server.js": "export const service = 'api';\n",
      "packages/web/package.json": "{\"name\":\"fixture-web\",\"private\":true}\n",
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    },
  });
  const genericRepo = await createRepository("fixture-generic", { node: false });
  const noRemoteRepo = await createRepository("fixture-no-remote", { remote: false });
  const originalHead = (await checked("git", ["rev-parse", "HEAD"], { cwd: nodeRepo })).stdout.trim();

  await check("SETUP-001/TUI-001/MANAGED-001/JOURNEY-01", "first installed no-arg run completes setup, managed authorization, and enters the TUI", async () => {
    const result = await wcoTty(nodeRepo, [
      { waitFor: /Set up WCO for the current Git repository\? \[Y\/n\] /, send: "\n" },
      { waitFor: /Connect ChatGPT Web\? \[Y\/n\] /, send: "\n" },
      { waitFor: /Status\s+READY[\s\S]*\n> /, send: "/quit\n" },
    ]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.completedSteps, 3);
    assert.match(result.stdout, /Welcome to WCO/);
    assert.match(result.stdout, /WCO Relay\s+available/);
    assert.match(result.stdout, /ChatGPT Web\s+linked/);
    assert.match(result.stdout, /Status\s+READY/);
    assert.equal(await exists(path.join(wcoHome, "config.json")), true);
    const saved = JSON.parse(await readFile(path.join(wcoHome, "config.json"), "utf8"));
    assert.equal(saved.web_bridge.mode, "managed_actions");
    assert.equal(saved.web_bridge.relay_url, undefined); assert.equal(saved.web_bridge.gpt_url, undefined);
    const credential = path.join(wcoHome, "credentials", "managed-device.json");
    assert.equal(await exists(credential), true);
    if (process.platform !== "win32") assert.equal((await stat(credential)).mode & 0o777, 0o600);
    assert.doesNotMatch(result.stdout + result.stderr, /Relay HTTPS URL|GPT URL|bearer token|cloudflared|OpenAPI YAML/);
    assert.match(await readFile(browserLog, "utf8"), /https:\/\/chatgpt\.com\/g\/wco-packed-managed/);
  });

  await check("MANAGED-002", "returning installed user enters directly without repeated Web configuration", async () => {
    const result = await wcoTty(nodeRepo, [{ waitFor: /Status\s+READY[\s\S]*\n> /, send: "/quit\n" }]);
    assert.equal(result.code, 0, result.stdout + result.stderr); assert.equal(result.completedSteps, 1);
    assert.doesNotMatch(result.stdout, /Connect ChatGPT Web\?|Relay HTTPS URL|GPT URL|bearer token/);
  });

  await check("MANAGED-003", "declining managed Web on a separate first run still leaves the TUI usable", async () => {
    const declineHome = path.join(workspace, "decline-home"), declineWco = path.join(declineHome, "wco"), declineRepo = await createRepository("fixture-decline");
    const result = await wcoTty(declineRepo, [
      { waitFor: /Set up WCO for the current Git repository\? \[Y\/n\] /, send: "\n" },
      { waitFor: /Connect ChatGPT Web\? \[Y\/n\] /, send: "n\n" },
      { waitFor: /Status\s+READY[\s\S]*\n> /, send: "/quit\n" },
    ], { home: declineHome, wcoHome: declineWco });
    assert.equal(result.code, 0, result.stdout + result.stderr); assert.equal(result.completedSteps, 3);
    assert.match(result.stdout, /not connected.*TUI remains available/i);
    assert.equal(await exists(path.join(declineWco, "credentials", "managed-device.json")), false);
  });

  await check("SETUP-002/014/015", "setup is idempotent and safely registers another repository", async () => {
    assert.equal((await wco(["setup", "--yes"], { cwd: nodeRepo })).code, 0);
    assert.equal((await wco(["setup", "--yes"], { cwd: genericRepo })).code, 0);
    assert.equal((await wco(["setup", "--yes"], { cwd: devopsRepo })).code, 0);
    assert.equal((await wco(["setup", "--yes"], { cwd: monorepoRepo })).code, 0);
    const config = JSON.parse(await readFile(path.join(wcoHome, "config.json"), "utf8"));
    assert.deepEqual(Object.keys(config.repositories).sort(), ["fixture-devops", "fixture-generic", "fixture-monorepo", "fixture-node-api"]);
  });

  await check("WORK-006/007/008/009/010/011/JOURNEY-09", "DevOps, monorepo, and generic goals remain scoped without deployment side effects", async () => {
    const journeys = [
      [devopsRepo, "Update the Terraform, Kubernetes deployment, Dockerfile, and GitHub Actions checks without applying or deploying anything."],
      [monorepoRepo, "Refactor only the backend API package and preserve the web package behavior."],
      [genericRepo, "Improve these repository notes without assuming a package manager."],
    ];
    for (const [repository, goal] of journeys) {
      const before = (await checked("git", ["status", "--porcelain=v1"], { cwd: repository })).stdout;
      const result = await wcoTty(repository, [
        { waitFor: /Status\s+READY[\s\S]*\n> /, send: `${goal}\n` },
        { waitFor: /Waiting for ChatGPT Web/, stop: true },
      ]);
      assert.ok(result.code === 0 || result.code === 130 || result.signal === "SIGINT", result.stdout + result.stderr);
      assert.equal(result.completedSteps, 2);
      assert.match(result.stdout, /Task sent securely to WCO Web/);
      assert.equal((await checked("git", ["status", "--porcelain=v1"], { cwd: repository })).stdout, before);
      assert.doesNotMatch(result.stdout + result.stderr, /(?:terraform|kubectl)\s+(?:apply|destroy)|docker\s+(?:push|run)/i);
      assert.doesNotMatch(result.stdout, /state-dir|archive SHA|Task Bundle/);
    }
  });

  await check("SETUP-003/013", "subdirectory setup detects root without modifying dirty user work", async () => {
    await writeFile(path.join(nodeRepo, "user-uncommitted.txt"), "preserve me\n");
    const before = (await checked("git", ["status", "--porcelain=v1"], { cwd: nodeRepo })).stdout;
    const result = await wco(["setup", "--yes"], { cwd: path.join(nodeRepo, "src") });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const after = (await checked("git", ["status", "--porcelain=v1"], { cwd: nodeRepo })).stdout;
    assert.equal(after, before);
  });

  await check("SETUP-004/011", "outside-repo and no-remote setup errors are actionable and safe", async () => {
    const outside = await wco(["setup", "--yes"], { cwd: workspace });
    assert.notEqual(outside.code, 0);
    assert.match(outside.stderr, /REPOSITORY_DETECTION_FAILED/);
    assert.doesNotMatch(outside.stderr, /\n\s+at\s/);
    const noRemote = await wco(["setup", "--yes"], { cwd: noRemoteRepo });
    assert.notEqual(noRemote.code, 0);
    assert.match(noRemote.stderr, /no Git remote is configured/);
  });

  await check("SETUP-005/006/007/DOCTOR-004", "packed setup supports authenticated legacy GitHub CLI without leaking its token", async () => {
    const legacyBin = path.join(workspace, "legacy-gh", "bin");
    const legacyHome = path.join(workspace, "legacy-gh", "home");
    const legacyWcoHome = path.join(legacyHome, "wco");
    const legacyGh = path.join(legacyBin, "gh");
    await mkdir(legacyBin, { recursive: true });
    await writeFile(legacyGh, `#!/usr/bin/env bash
if [[ "$1 $2" == "auth status" ]]; then exit 0; fi
if [[ "$1 $2" == "auth token" ]]; then exit 1; fi
if [[ "$1 $2 $3" == "config get oauth_token" ]]; then printf '%s\\n' 'legacy-packed-secret-token'; exit 0; fi
exit 1
`);
    await chmod(legacyGh, 0o755);
    const result = await wco(["setup", "--yes"], {
      cwd: genericRepo,
      env: {
        HOME: legacyHome,
        WCO_HOME: legacyWcoHome,
        XDG_CONFIG_HOME: path.join(legacyHome, ".config"),
        PATH: `${legacyBin}${path.delimiter}${path.dirname(installedBinary())}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /✓ GitHub\s+gh authenticated/);
    assert.doesNotMatch(result.stdout + result.stderr, /legacy-packed-secret-token/);
  });

  await check("SETUP-016/ERR-001/003/004", "corrupt trusted config fails closed without overwrite or stack trace", async () => {
    const configPath = path.join(wcoHome, "config.json");
    const valid = await readFile(configPath);
    await writeFile(configPath, "{ corrupt\n");
    const result = await wco(["setup", "--yes"], { cwd: nodeRepo });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /CONFIG_INVALID|valid JSON/);
    assert.doesNotMatch(result.stderr, /\n\s+at\s/);
    assert.equal((await readFile(configPath, "utf8")), "{ corrupt\n");
    await writeFile(configPath, valid);
  });

  await check("TUI-002/003/004/005/012/N", "installed slash palette and no-active-task paths match implementation", async () => {
    const result = await wcoTty(nodeRepo, [
      { waitFor: /Status\s+READY[\s\S]*\n> /, send: "\n" },
      { waitFor: /\n> /, send: "/\n" },
      { waitFor: /\n> /, send: "/help\n" },
      { waitFor: /\n> /, send: "/foo\n" },
      { waitFor: /\n> /, send: "/status\n" },
      { waitFor: /\n> /, send: "/task\n" },
      { waitFor: /\n> /, send: "/history\n" },
      { waitFor: /\n> /, send: "/config\n" },
      { waitFor: /\n> /, send: "/review\n" },
      { waitFor: /\n> /, send: "/pause\n" },
      { waitFor: /\n> /, send: "/resume\n" },
      { waitFor: /\n> /, send: "/run\n" },
      { waitFor: /\n> /, send: "/quit\n" },
    ], { timeoutMs: 60_000 });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.completedSteps, 13);
    for (const command of ["/new", "/web status", "/web connect", "/web open", "/web disconnect", "/config web", "/unitsall", "/uninstall"]) assert.match(result.stdout, new RegExp(command.replace("/", "\\/")));
    assert.match(result.stdout, /Unknown command '\/foo'. Type \/ for the command palette/);
    assert.match(result.stdout, /No active run/);
    assert.match(result.stdout, /No active task/);
    assert.match(result.stdout, /No task history/);
    assert.match(result.stdout, /No prepared run to pause\/resume/);
    assert.match(result.stdout, /Enter a task goal first/);
  });

  await check("TASK-001/003/WEB-001/MANAGED-004", "returning users submit English and Vietnamese free-text tasks without Web configuration", async () => {
    const journeys = [
      [await createRepository("fixture-task-english"), "Add rate limiting to POST /login, keep existing login behavior and add tests."],
      [await createRepository("fixture-task-vietnamese"), "Thêm refresh token rotation nhưng giữ nguyên API login hiện tại, thêm test regression."],
    ];
    for (const [repository, goal] of journeys) {
      assert.equal((await wco(["setup", "--yes"], { cwd: repository })).code, 0);
      const result = await wcoTty(repository, [
        { waitFor: /Status\s+READY[\s\S]*\n> /, send: `${goal}\n` },
        { waitFor: /Waiting for ChatGPT Web/, stop: true },
      ]);
      assert.ok(result.code === 0 || result.code === 130 || result.signal === "SIGINT", result.stdout + result.stderr);
      assert.equal(result.completedSteps, 2); assert.match(result.stdout, /Task sent securely to WCO Web/);
      assert.doesNotMatch(result.stdout, /Connect ChatGPT Web|Relay HTTPS URL|GPT URL|bearer token|job-[A-Za-z0-9]|state-dir|archive SHA|Task Bundle/);
    }
  });

  await check("WEB-002/010/011/MANAGED-005", "managed status, fixed GPT open, disconnect, and reconnect are truthful", async () => {
    const status = await wco(["web", "status"], { cwd: nodeRepo });
    assert.equal(status.code, 0);
    assert.match(status.stdout, /WCO Relay\s+connected/);
    const opened = await wco(["web", "open"], { cwd: nodeRepo });
    assert.equal(opened.code, 0); assert.match(opened.stdout, /Opened the configured WCO Senior Architect GPT/);
    assert.equal((await wco(["web", "disconnect"], { cwd: nodeRepo })).code, 0);
    const disconnected = await wco(["web", "status"], { cwd: nodeRepo }); assert.equal(disconnected.code, 1); assert.match(disconnected.stderr, /RECONNECT_REQUIRED|not linked/);
    const reconnected = await wco(["web", "connect"], { cwd: nodeRepo }); assert.equal(reconnected.code, 0, reconnected.stdout + reconnected.stderr);
    assert.match(reconnected.stdout, /ChatGPT Web\s+linked/);
  });

  await check("MANAGED-006", "missing desktop opener prints the fixed GPT URL without crashing", async () => {
    const noBrowserBin = path.join(workspace, "no-browser-bin"); await mkdir(noBrowserBin, { recursive: true });
    await writeFile(path.join(noBrowserBin, "node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`); await chmod(path.join(noBrowserBin, "node"), 0o755);
    const opened = await wco(["web", "open"], { cwd: nodeRepo, env: { PATH: `${path.dirname(installedBinary())}:${noBrowserBin}` } });
    assert.equal(opened.code, 0, opened.stdout + opened.stderr);
    assert.match(opened.stdout, /Could not open a desktop browser automatically/);
    assert.match(opened.stdout, /https:\/\/chatgpt\.com\/g\/wco-packed-managed/);
    assert.doesNotMatch(opened.stderr, /\n\s+at\s/);
  });

  await check("WEB-004/005/006/007/008/013", "unsafe/offline Web connection attempts fail before persisting credentials", async () => {
    const configBefore = await readFile(path.join(wcoHome, "config.json"));
    const unsafeGpt = await wcoTty(nodeRepo, [
      { waitFor: /Status\s+READY[\s\S]*\n> /, send: "/web connect --self-hosted\n" },
      { waitFor: /Relay HTTPS URL: /, send: "https://127.0.0.1:9\n" },
      { waitFor: /WCO Senior Architect GPT URL: /, send: "http://chatgpt.example/g/test#secret\n" },
      { waitFor: /Relay bearer token/, send: `${"x".repeat(40)}\n` },
      { waitFor: /WEB_GPT_URL_UNSAFE[\s\S]*\n> /, send: "/quit\n" },
    ]);
    assert.match(unsafeGpt.stdout, /WEB_GPT_URL_UNSAFE/);
    const unsafeRelay = await wcoTty(nodeRepo, [
      { waitFor: /Status\s+READY[\s\S]*\n> /, send: "/web connect --self-hosted\n" },
      { waitFor: /Relay HTTPS URL: /, send: "http://example.com/relay\n" },
      { waitFor: /WCO Senior Architect GPT URL: /, send: "https://chatgpt.com/g/test\n" },
      { waitFor: /Relay bearer token/, send: `${"x".repeat(40)}\n` },
      { waitFor: /WEB_RELAY_URL_UNSAFE[\s\S]*\n> /, send: "/quit\n" },
    ]);
    assert.match(unsafeRelay.stdout, /WEB_RELAY_URL_UNSAFE/);
    assert.deepEqual(await readFile(path.join(wcoHome, "config.json")), configBefore);
    assert.equal(await exists(path.join(wcoHome, "credentials", "relay-token")), false);
    assert.doesNotMatch(`${unsafeGpt.stdout}${unsafeRelay.stdout}`, new RegExp("x{16,}"));
  });

  await check("TUI-007/ERR-001", "Ctrl+C during nested Web setup exits cleanly", async () => {
    const result = await wcoTty(nodeRepo, [
      { waitFor: /Status\s+READY[\s\S]*\n> /, send: "/web connect --self-hosted\n" },
      { waitFor: /Relay HTTPS URL: /, send: "\u0003" },
    ]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Aborted with Ctrl\+C/);
    assert.doesNotMatch(result.stdout + result.stderr, /readline was closed|\n\s+at\s/);
  });

  await check("DOCTOR-002/003/004/005/007", "doctor discovers saved defaults and reports exact failed subsystems", async () => {
    const result = await wco(["doctor"], { cwd: nodeRepo, timeoutMs: 30_000 });
    assert.ok(result.code === 0 || result.code === 2, result.stdout + result.stderr);
    assert.match(result.stdout, /WCO Doctor/);
    assert.match(result.stdout, /config:/);
    assert.match(result.stdout, /wco-relay-service: PASS/);
    assert.match(result.stdout, /wco-device-account: PASS/);
    assert.match(result.stdout, /chatgpt-web: linked/);
    assert.match(result.stdout, /senior-architect-gpt: configured/);
    assert.doesNotMatch(result.stderr, /Missing '--config'|Missing '--state-dir'/);
  });

  await check("UNINSTALL-001/006", "interactive uninstall and typo alias cancel without deleting state", async () => {
    for (const command of ["/uninstall", "/unitsall"]) {
      const result = await wcoTty(nodeRepo, [
        { waitFor: /Status\s+READY[\s\S]*\n> /, send: `${command}\n` },
        { waitFor: /Your repositories\/branches\/PRs will be preserved\. \[y\/N\] /, send: "n\n" },
        { waitFor: /Uninstall cancelled[\s\S]*\n> /, send: "/quit\n" },
      ]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Uninstall cancelled/);
      assert.equal(await exists(path.join(wcoHome, "config.json")), true);
    }
  });

  await check("UNINSTALL-002/003/005/009/JOURNEY-10", "confirmed uninstall scopes data/package, preserves repo, then reinstalls", async () => {
    const beforeStatus = (await checked("git", ["status", "--porcelain=v1"], { cwd: nodeRepo })).stdout;
    const revocationsBefore = managedRevocations;
    const result = await wco(["uninstall", "--purge", "--yes"], { cwd: nodeRepo });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(await exists(wcoHome), false);
    assert.equal((await checked("git", ["rev-parse", "HEAD"], { cwd: nodeRepo })).stdout.trim(), originalHead);
    assert.equal((await checked("git", ["status", "--porcelain=v1"], { cwd: nodeRepo })).stdout, beforeStatus);
    assert.equal(managedRevocations, revocationsBefore + 1, "uninstall did not request managed device revocation");
    for (let attempt = 0; attempt < 100 && await exists(installedBinary()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await exists(installedBinary()), false, "scoped npm self-uninstall did not remove the packed binary");
    await checked(npm, ["install", "--global", "--prefix", prefix, "--omit=dev", "--ignore-scripts", tarball], { cwd: workspace, timeoutMs: 120_000 });
    assert.equal((await wco(["--version"], { cwd: workspace })).stdout.trim(), pkg.version);
  });

  const report = {
    schema_version: "1.0",
    package: `${pkg.name}@${pkg.version}`,
    tarball: path.basename(tarball),
    total: results.length,
    pass: results.filter((item) => item.status === "PASS").length,
    fail: results.filter((item) => item.status === "FAIL").length,
    skipped: 0,
    results,
  };
  await writeFile(path.join(evidence, "packed-user-journeys.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nPacked user journeys PASS: ${report.pass}/${report.total}; skipped: 0\n`);
} finally {
  if (managedServer) await new Promise((resolve) => managedServer.close(() => resolve()));
  if (tarball && await exists(tarball)) await rm(tarball);
  if (keep) process.stdout.write(`Preserved packed-user evidence: ${workspace}\n`);
  else await rm(workspace, { recursive: true, force: true });
}
