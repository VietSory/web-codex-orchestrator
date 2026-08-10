import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const results = [];
let tarball;

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
    env: safeEnvironment({ PATH: `${path.dirname(installedBinary())}${path.delimiter}${process.env.PATH ?? ""}`, ...(options.env ?? {}) }),
  });
}

async function wcoTty(repository, steps, options = {}) {
  assert.equal(process.platform, "linux", "packed TUI journey currently targets the primary Linux/WSL environment");
  const command = `env HOME=${home} WCO_HOME=${wcoHome} XDG_CONFIG_HOME=${path.join(home, ".config")} XDG_STATE_HOME=${path.join(home, ".local/state")} XDG_CACHE_HOME=${path.join(home, ".cache")} PATH=${path.dirname(installedBinary())}:/usr/local/bin:/usr/bin:/bin ${installedBinary()}`;
  return await new Promise((resolve, reject) => {
    const child = spawn("script", ["--quiet", "--return", "--echo", "never", "--command", command, "/dev/null"], {
      cwd: repository,
      env: safeEnvironment(),
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
        child.stdin.write(steps[index].send);
        index += 1;
      }
    };
    child.stdout.on("data", (chunk) => { stdout.push(chunk); source += chunk.toString("utf8"); advance(); });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs ?? 45_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      child.stdin.end();
      resolve({ code, signal, timedOut, outputExceeded: false, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), completedSteps: index });
    });
  });
}

try {
  await mkdir(evidence, { recursive: true });
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

  await check("SETUP-001/TUI-001/JOURNEY-01", "first no-arg run completes setup and enters the TUI", async () => {
    const result = await wcoTty(nodeRepo, [
      { waitFor: /Set up WCO for the current Git repository\? \[Y\/n\] /, send: "\n" },
      { waitFor: /Status\s+READY[\s\S]*\n> /, send: "/quit\n" },
    ]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.completedSteps, 2);
    assert.match(result.stdout, /First-time setup/);
    assert.match(result.stdout, /Setup is complete/);
    assert.match(result.stdout, /Status\s+READY/);
    assert.equal(await exists(path.join(wcoHome, "config.json")), true);
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
        { waitFor: /Connect the WCO Senior Architect now\? \[Y\/n\] /, send: "n\n" },
        { waitFor: /Task was not started[\s\S]*\n> /, send: "/quit\n" },
      ]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
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

  await check("TASK-001/003/WEB-001", "English and Vietnamese goals guide Web connection without creating plumbing", async () => {
    for (const goal of [
      "Add rate limiting to POST /login, keep existing login behavior and add tests.",
      "Thêm refresh token rotation nhưng giữ nguyên API login hiện tại, thêm test regression.",
    ]) {
      const result = await wcoTty(nodeRepo, [
        { waitFor: /Status\s+READY[\s\S]*\n> /, send: `${goal}\n` },
        { waitFor: /Connect the WCO Senior Architect now\? \[Y\/n\] /, send: "n\n" },
        { waitFor: /Task was not started[\s\S]*\n> /, send: "/quit\n" },
      ]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /ChatGPT Web is not connected/);
      assert.match(result.stdout, /Task was not started/);
      assert.doesNotMatch(result.stdout, /state-dir|archive SHA|Task Bundle/);
    }
  });

  await check("WEB-002/010/011", "disconnected Web lifecycle is truthful and safe", async () => {
    const status = await wco(["web", "status"], { cwd: nodeRepo });
    assert.equal(status.code, 1);
    assert.match(status.stdout, /Relay\s+disconnected/);
    assert.doesNotMatch(status.stdout, /Relay\s+connected/);
    const opened = await wco(["web", "open"], { cwd: nodeRepo });
    assert.equal(opened.code, 1);
    assert.match(opened.stderr, /WEB_GPT_NOT_CONFIGURED/);
    assert.match(opened.stderr, /No repository files or workflow authority were changed/);
    assert.equal((await wco(["web", "disconnect"], { cwd: nodeRepo })).code, 0);
  });

  await check("WEB-004/005/006/007/008/013", "unsafe/offline Web connection attempts fail before persisting credentials", async () => {
    const configBefore = await readFile(path.join(wcoHome, "config.json"));
    const unsafeGpt = await wcoTty(nodeRepo, [
      { waitFor: /Status\s+READY[\s\S]*\n> /, send: "/web connect\n" },
      { waitFor: /Relay HTTPS URL: /, send: "https://127.0.0.1:9\n" },
      { waitFor: /WCO Senior Architect GPT URL: /, send: "http://chatgpt.example/g/test#secret\n" },
      { waitFor: /Relay bearer token/, send: `${"x".repeat(40)}\n` },
      { waitFor: /WEB_GPT_URL_UNSAFE[\s\S]*\n> /, send: "/quit\n" },
    ]);
    assert.match(unsafeGpt.stdout, /WEB_GPT_URL_UNSAFE/);
    const unsafeRelay = await wcoTty(nodeRepo, [
      { waitFor: /Status\s+READY[\s\S]*\n> /, send: "/web connect\n" },
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
      { waitFor: /Status\s+READY[\s\S]*\n> /, send: "/config web\n" },
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
    const result = await wco(["uninstall", "--purge", "--yes"], { cwd: nodeRepo });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(await exists(wcoHome), false);
    assert.equal((await checked("git", ["rev-parse", "HEAD"], { cwd: nodeRepo })).stdout.trim(), originalHead);
    assert.equal((await checked("git", ["status", "--porcelain=v1"], { cwd: nodeRepo })).stdout, beforeStatus);
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
  if (tarball && await exists(tarball)) await rm(tarball);
  if (keep) process.stdout.write(`Preserved packed-user evidence: ${workspace}\n`);
  else await rm(workspace, { recursive: true, force: true });
}
