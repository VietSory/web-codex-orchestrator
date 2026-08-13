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

const root = await mkdtemp(path.join(os.tmpdir(), "wco-managed-packed-"));
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
  await writeFile(path.join(repo, "README.md"), "# disposable WCO managed packed journey\n", "utf8");
  requireSuccess(await run("git", ["add", "README.md"], { cwd: repo }), "git add");
  requireSuccess(await run("git", ["commit", "-m", "initial"], { cwd: repo }), "git commit");
  requireSuccess(await run("git", ["remote", "add", "origin", "https://github.com/example/wco-managed-packed.git"], { cwd: repo }), "git remote");

  const setup = await run(bin, ["setup", "--yes"], { cwd: repo, env });
  requireSuccess(setup, "wco setup --yes");
  assert.match(setup.stdout, /WCO managed Web \(one-link authorization\)/i);
  assert.match(setup.stdout, /one maintainer-operated HTTPS authorization link/i);
  assert.match(setup.stdout, /do not enter relay URLs, tunnel IDs, API keys, Workspace Agent tokens/i);

  const config = JSON.parse(await readFile(path.join(wcoHome, "config.json"), "utf8"));
  assert.equal(config.web_bridge?.mode, "managed_actions");
  assert.equal(config.web_bridge?.relay_url, undefined);
  assert.equal(config.web_bridge?.gpt_url, undefined);

  // Before the single authorization decision, status must require only the
  // one-link managed connect flow. It must not expose any operator/provider
  // provisioning controls to this end user.
  const status = await run(bin, ["web", "status"], { cwd: repo, env });
  assert.equal(status.signal, null);
  assert.equal(status.code, 1, `unlinked managed status must fail closed\n${status.stdout}\n${status.stderr}`);
  const statusText = `${status.stdout}\n${status.stderr}`;
  assert.match(statusText, /WEB_MANAGED_RECONNECT_REQUIRED|not linked/i);
  assert.match(statusText, /Next: wco web connect/i);
  assert.doesNotMatch(statusText, /Personal relay HTTPS URL|tunnel ID|runtime API key|Workspace Agent access token|Cloudflare|ngrok|VPS/i);

  // This source candidate deliberately ships no real production managed URL.
  // Trying to connect must therefore identify an OPERATOR/RELEASE deployment
  // boundary, not ask the end user to provision anything themselves.
  const connect = await run(bin, ["web", "connect"], { cwd: repo, env });
  assert.equal(connect.signal, null);
  assert.equal(connect.code, 1, `undeployed managed service must fail closed\n${connect.stdout}\n${connect.stderr}`);
  const connectText = `${connect.stdout}\n${connect.stderr}`;
  assert.match(connectText, /WEB_MANAGED_DEPLOYMENT_REQUIRED|managed WCO Web service|service owner/i);
  assert.doesNotMatch(connectText, /Personal relay HTTPS URL|tunnel ID|runtime API key|Workspace Agent access token|Cloudflare|ngrok|VPS/i);

  const contract = await readFile(path.join(prefix, "lib", "node_modules", "web-codex-orchestrator", "docs", "user-experience-contract.md"), "utf8");
  assert.match(contract, /exactly one HTTPS authorization link/i);
  assert.match(contract, /per-task browser interactions\s+= 0/i);
  assert.match(contract, /manual tunnel IDs\s+= 0/i);
  assert.match(contract, /manual API keys\s+= 0/i);

  console.log("Packed managed one-link normal-user contract: 1/1 PASS, 0 skipped");
} finally {
  await rm(root, { recursive: true, force: true });
}
