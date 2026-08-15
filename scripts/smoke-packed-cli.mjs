import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const git = process.platform === "win32" ? "git.exe" : "git";
const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const temp = mkdtempSync(path.join(os.tmpdir(), "wco-packed-smoke-"));
let tarball;

function run(command, args, options = {}) {
  const expectedStatuses = options.expectedStatuses ?? [0];
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (!expectedStatuses.includes(result.status)) {
    const details = options.capture ? `\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${String(result.status)}${details}`);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const packed = run(npm, ["pack", "--json"], { capture: true });
  const parsed = JSON.parse(packed.stdout);
  tarball = path.resolve(root, parsed[0].filename);

  run(npm, ["install", "--prefix", temp, "--omit=dev", "--ignore-scripts", tarball]);

  const bin = process.platform === "win32"
    ? path.join(temp, "node_modules", ".bin", "wco.cmd")
    : path.join(temp, "node_modules", ".bin", "wco");

  const version = run(bin, ["--version"], { cwd: temp, capture: true }).stdout.trim();
  if (version !== pkg.version) throw new Error(`Packed CLI version '${version}' != package version '${pkg.version}'.`);
  run(bin, ["--help"], { cwd: temp, capture: true });

  // Exercise the actual packed first-run path without network or provider auth.
  // A local bare Git remote is enough to seal repository identity while keeping
  // this acceptance deterministic and independent from GitHub credentials.
  const project = path.join(temp, "project");
  const remote = path.join(temp, "remote.git");
  const wcoHome = path.join(temp, "wco-home");
  const userHome = path.join(temp, "user-home");
  mkdirSync(project, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  run(git, ["init", "--bare", remote], { cwd: temp, capture: true });
  run(git, ["init", "-b", "main"], { cwd: project, capture: true });
  run(git, ["config", "user.name", "WCO Packed Smoke"], { cwd: project, capture: true });
  run(git, ["config", "user.email", "wco-packed-smoke@example.invalid"], { cwd: project, capture: true });
  writeFileSync(path.join(project, "README.md"), "# packed smoke\n", "utf8");
  run(git, ["add", "README.md"], { cwd: project, capture: true });
  run(git, ["commit", "-m", "initial packed smoke fixture"], { cwd: project, capture: true });
  run(git, ["remote", "add", "origin", remote], { cwd: project, capture: true });
  run(git, ["push", "-u", "origin", "main"], { cwd: project, capture: true });

  const isolatedEnv = { ...process.env, HOME: userHome, USERPROFILE: userHome, WCO_HOME: wcoHome, CI: "true" };
  delete isolatedEnv.WCO_CONFIG;
  delete isolatedEnv.WCO_STATE_DIR;

  const setup = run(bin, ["setup", "--yes"], { cwd: project, capture: true, env: isolatedEnv });
  assert(/local ChatGPT\/Codex \(zero-config default\)/i.test(setup.stdout), "Packed setup did not select the local ChatGPT/Codex zero-config transport.");
  assert(!/tunnel ID|API key|MCP connector|relay endpoint/i.test(setup.stderr), "Packed normal setup unexpectedly requested advanced transport infrastructure.");

  const configPath = path.join(wcoHome, "config.json");
  const firstConfigBytes = readFileSync(configPath, "utf8");
  const config = JSON.parse(firstConfigBytes);
  assert(config.web_bridge === undefined, "Packed fresh config must leave web_bridge absent for the local zero-config transport.");
  assert(config.runtime?.source === "bundled", "Packed fresh config must pin the bundled official Codex runtime.");
  assert(!firstConfigBytes.includes("relay_url") && !firstConfigBytes.includes("gpt_url"), "Packed fresh config must not persist relay/GPT endpoints.");

  // Returning setup is idempotent: no transport migration or extra setup data.
  run(bin, ["setup", "--yes"], { cwd: project, capture: true, env: isolatedEnv });
  const secondConfigBytes = readFileSync(configPath, "utf8");
  assert(secondConfigBytes === firstConfigBytes, "Packed repeated setup changed trusted config for an already registered repository.");

  // CI is intentionally unauthenticated. Status must fail closed as auth-required
  // while still identifying the correct local transport and zero per-task browser path.
  const webStatus = run(bin, ["web", "status"], { cwd: project, capture: true, env: isolatedEnv, expectedStatuses: [1] });
  assert(/Mode\s+local ChatGPT\/Codex/i.test(webStatus.stdout), "Packed web status did not report the local ChatGPT/Codex transport.");
  assert(/ChatGPT authorization\s+required/i.test(webStatus.stdout), "Packed web status did not fail closed on missing ChatGPT authorization.");
  assert(/Per-task browser\s+not required/i.test(webStatus.stdout), "Packed web status regressed to a per-task browser workflow.");
  assert(!/managed|MCP|relay URL|tunnel/i.test(webStatus.stdout), "Packed zero-config status leaked an advanced transport requirement.");

  console.log(`Packed CLI clean-install + zero-config first-run smoke PASS (${pkg.name}@${pkg.version}).`);
} finally {
  if (tarball) {
    try { unlinkSync(tarball); } catch {}
  }
  rmSync(temp, { recursive: true, force: true });
}
