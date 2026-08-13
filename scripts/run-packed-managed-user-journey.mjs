import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function requireSuccess(result, label) {
  assert.equal(result.signal, null, `${label} terminated by signal ${result.signal}`);
  assert.equal(result.code, 0, `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

const root = await mkdtemp(path.join(os.tmpdir(), "wco-local-native-packed-"));
try {
  const packDir = path.join(root, "pack");
  const prefix = path.join(root, "prefix");
  const repo = path.join(root, "repo");
  const wcoHome = path.join(root, "wco-home");
  await Promise.all([mkdir(packDir), mkdir(prefix), mkdir(repo)]);

  const packed = await run("npm", ["pack", "--json", "--pack-destination", packDir]);
  requireSuccess(packed, "npm pack");
  const packReport = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(packReport) && typeof packReport[0]?.filename === "string", "npm pack report did not contain a filename");
  const tarball = path.join(packDir, packReport[0].filename);

  const installed = await run("npm", ["install", "--global", "--prefix", prefix, tarball]);
  requireSuccess(installed, "packed global install");
  const bin = process.platform === "win32" ? path.join(prefix, "wco.cmd") : path.join(prefix, "bin", "wco");
  const env = { ...process.env, WCO_HOME: wcoHome, PATH: `${path.dirname(bin)}${path.delimiter}${process.env.PATH ?? ""}` };

  requireSuccess(await run("git", ["init", "-b", "main"], { cwd: repo }), "git init");
  requireSuccess(await run("git", ["config", "user.name", "WCO Packed Test"], { cwd: repo }), "git user.name");
  requireSuccess(await run("git", ["config", "user.email", "wco-packed@example.invalid"], { cwd: repo }), "git user.email");
  await writeFile(path.join(repo, "README.md"), "# disposable WCO local-native packed journey\n", "utf8");
  requireSuccess(await run("git", ["add", "README.md"], { cwd: repo }), "git add");
  requireSuccess(await run("git", ["commit", "-m", "initial"], { cwd: repo }), "git commit");
  requireSuccess(await run("git", ["remote", "add", "origin", "https://github.com/example/wco-local-native-packed.git"], { cwd: repo }), "git remote");

  const setup = await run(bin, ["setup", "--yes"], { cwd: repo, env });
  requireSuccess(setup, "wco setup --yes");
  assert.match(setup.stdout, /local OpenAI Secure MCP/i);
  assert.match(setup.stdout, /WCO keeps repository state, mailbox, receipts, Harness and credentials local/i);
  assert.match(setup.stdout, /does not require a WCO server, Cloudflare, ngrok, VPS, domain, DNS, or public localhost/i);

  const config = JSON.parse(await readFile(path.join(wcoHome, "config.json"), "utf8"));
  assert.equal(config.web_bridge?.mode, "web_native_mcp");
  assert.equal(config.web_bridge?.relay_url, undefined);
  assert.equal(config.web_bridge?.gpt_url, undefined);

  // Before the one-time provider setup, WCO must fail closed toward the local
  // native setup command. It must never redirect a fresh user to hosted WCO,
  // Cloudflare, ngrok, a relay URL, or another public endpoint.
  const status = await run(bin, ["web", "status"], { cwd: repo, env });
  assert.equal(status.signal, null);
  assert.equal(status.code, 1, `unconfigured local-native status must fail closed\n${status.stdout}\n${status.stderr}`);
  const statusText = `${status.stdout}\n${status.stderr}`;
  assert.match(statusText, /WEB_NATIVE_SETUP_REQUIRED|not configured/i);
  assert.match(statusText, /Next: wco web connect/i);
  assert.doesNotMatch(statusText, /managed WCO Web service|Personal relay HTTPS URL|Cloudflare|ngrok|VPS|deploy.*relay/i);

  const contract = await readFile(path.join(prefix, "lib", "node_modules", "web-codex-orchestrator", "docs", "user-experience-contract.md"), "utf8");
  assert.match(contract, /normal path is `web_native_mcp`/i);
  assert.match(contract, /WCO-hosted services\s+= 0/i);
  assert.match(contract, /third-party relay\/cloud setup\s+= 0/i);
  assert.match(contract, /per-task browser interactions\s+= 0/i);
  assert.match(contract, /per-task tunnel\/key\/token inputs\s+= 0/i);

  console.log("Packed local-native normal-user contract: 1/1 PASS, 0 skipped");
} finally {
  await rm(root, { recursive: true, force: true });
}
