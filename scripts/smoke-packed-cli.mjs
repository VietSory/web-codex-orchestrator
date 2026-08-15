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

function packedInteractivePtySmoke(bin, project, env) {
  if (process.platform !== "linux") return;
  const python = spawnSync("python3", ["--version"], { encoding: "utf8", stdio: "pipe" });
  if (python.error || python.status !== 0) return;

  const driver = String.raw`
import base64, fcntl, json, os, pty, select, signal, struct, sys, termios, time
bin_path = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execv(bin_path, [bin_path])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 80, 0, 0))
buf = bytearray()
def drain(timeout=0.05):
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready: return
    try: chunk = os.read(fd, 4096)
    except OSError: return
    if chunk: buf.extend(chunk)
def wait(marker, start=0, timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        pos = bytes(buf).find(marker, start)
        if pos >= 0: return pos
        drain()
    raise RuntimeError("timeout waiting for %r; transcript=%r" % (marker, bytes(buf)[-1600:]))
try:
    prompt = wait(b"> ")
    os.write(fd, b"/")
    palette = wait(b"/new", prompt)
    os.write(fd, b"quit\r")
    wait(b"bye", palette)
    deadline = time.time() + 5.0
    status = None
    while time.time() < deadline:
        drain()
        done, value = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            status = value
            break
    timed_out = status is None
    if timed_out:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        _, status = os.waitpid(pid, 0)
    print(json.dumps({
        "exit_code": os.waitstatus_to_exitcode(status),
        "timed_out": timed_out,
        "transcript": base64.b64encode(bytes(buf)).decode("ascii"),
    }))
finally:
    try: os.close(fd)
    except OSError: pass
`;
  const result = spawnSync("python3", ["-c", driver, bin], {
    cwd: project,
    env,
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packed interactive PTY smoke failed.\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`);
  let parsed;
  try { parsed = JSON.parse((result.stdout ?? "").trim()); }
  catch { throw new Error(`Packed interactive PTY smoke returned invalid JSON.\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`); }
  const transcript = Buffer.from(parsed.transcript ?? "", "base64").toString("utf8");
  assert(parsed.timed_out === false, `Packed interactive WCO did not exit cleanly.\n${transcript}`);
  assert(parsed.exit_code === 0, `Packed interactive WCO exited with ${String(parsed.exit_code)}.\n${transcript}`);
  assert(/\/new/.test(transcript), "Packed interactive WCO did not render the slash palette.");
  assert(/bye/.test(transcript), "Packed interactive WCO did not complete /quit cleanly.");
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
  assert(/local ChatGPT\/Codex/i.test(setup.stdout), "Packed setup did not select the local ChatGPT/Codex zero-config transport.");
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
  assert(/Per-task browser\s+not required/i.test(webStatus.stdout), "Packed zero-config status regressed to a per-task browser workflow.");
  assert(!/managed|MCP|relay URL|tunnel/i.test(webStatus.stdout), "Packed zero-config status leaked an advanced transport requirement.");

  // Exercise the installed compiled CLI through a real Linux PTY. This catches
  // package-only regressions in raw-mode ownership, slash discovery, and clean exit.
  packedInteractivePtySmoke(bin, project, isolatedEnv);

  console.log(`Packed CLI clean-install + zero-config first-run smoke PASS (${pkg.name}@${pkg.version}).`);
} finally {
  if (tarball) {
    try { unlinkSync(tarball); } catch {}
  }
  rmSync(temp, { recursive: true, force: true });
}
