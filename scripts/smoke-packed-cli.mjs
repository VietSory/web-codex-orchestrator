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
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
  if (result.error) throw result.error;
  if (!expectedStatuses.includes(result.status)) {
    const details = options.capture ? `\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${String(result.status)}${details}`);
  }
  return result;
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}
function measureCommand(command, args, options = {}, samples = 5) {
  const elapsedMs = [];
  let result;
  for (let index = 0; index < samples; index += 1) {
    const started = process.hrtime.bigint();
    result = run(command, args, options);
    elapsedMs.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  return { result, first_ms: Number(elapsedMs[0].toFixed(1)), median_ms: Number(median(elapsedMs).toFixed(1)), max_ms: Number(Math.max(...elapsedMs).toFixed(1)) };
}

function packedInteractivePtySmoke(bin, project, env) {
  if (process.platform !== "linux") return null;
  const python = spawnSync("python3", ["--version"], { encoding: "utf8", stdio: "pipe" });
  if (python.error || python.status !== 0) return null;
  const driver = String.raw`
import base64, fcntl, json, os, pty, select, signal, struct, sys, termios, time
bin_path = sys.argv[1]
started = time.monotonic()
pid, fd = pty.fork()
if pid == 0: os.execv(bin_path, [bin_path])
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
def rss_kb():
    try:
        with open("/proc/%d/status" % pid, "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"): return int(line.split()[1])
    except (FileNotFoundError, ProcessLookupError, ValueError): pass
    return None
try:
    prompt = wait(b"> ")
    prompt_ms = (time.monotonic() - started) * 1000.0
    idle_rss_kb = rss_kb()
    os.write(fd, b"/")
    palette = wait(b"/new", prompt)
    quit_started = time.monotonic()
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
    print(json.dumps({"exit_code": os.waitstatus_to_exitcode(status), "timed_out": timed_out, "prompt_ms": round(prompt_ms, 1), "idle_rss_kb": idle_rss_kb, "quit_ms": round((time.monotonic() - quit_started) * 1000.0, 1), "total_ms": round((time.monotonic() - started) * 1000.0, 1), "transcript": base64.b64encode(bytes(buf)).decode("ascii")}))
finally:
    try: os.close(fd)
    except OSError: pass
`;
  const result = spawnSync("python3", ["-c", driver, bin], { cwd: project, env, encoding: "utf8", stdio: "pipe", shell: false, timeout: 20_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packed interactive PTY smoke failed.\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`);
  const parsed = JSON.parse((result.stdout ?? "").trim());
  const transcript = Buffer.from(parsed.transcript ?? "", "base64").toString("utf8");
  assert(parsed.timed_out === false, `Packed interactive WCO did not exit cleanly.\n${transcript}`);
  assert(parsed.exit_code === 0, `Packed interactive WCO exited with ${String(parsed.exit_code)}.\n${transcript}`);
  assert(Number.isFinite(parsed.prompt_ms) && parsed.prompt_ms >= 0, "Packed interactive WCO did not report prompt startup latency.");
  assert(parsed.idle_rss_kb === null || Number.isSafeInteger(parsed.idle_rss_kb) && parsed.idle_rss_kb > 0, "Packed interactive WCO reported invalid idle RSS.");
  assert(Number.isFinite(parsed.quit_ms) && parsed.quit_ms >= 0, "Packed interactive WCO did not report clean-exit latency.");
  assert(/\/new/.test(transcript), "Packed interactive WCO did not render the slash palette.");
  assert(/bye/.test(transcript), "Packed interactive WCO did not complete /quit cleanly.");
  return { prompt_ms: parsed.prompt_ms, idle_rss_kb: parsed.idle_rss_kb, quit_ms: parsed.quit_ms, total_ms: parsed.total_ms };
}

try {
  const packed = run(npm, ["pack", "--json"], { capture: true });
  const parsed = JSON.parse(packed.stdout);
  tarball = path.resolve(root, parsed[0].filename);
  run(npm, ["install", "--prefix", temp, "--omit=dev", "--ignore-scripts", tarball]);
  const bin = process.platform === "win32" ? path.join(temp, "node_modules", ".bin", "wco.cmd") : path.join(temp, "node_modules", ".bin", "wco");

  const versionTiming = measureCommand(bin, ["--version"], { cwd: temp, capture: true });
  const version = versionTiming.result.stdout.trim();
  if (version !== pkg.version) throw new Error(`Packed CLI version '${version}' != package version '${pkg.version}'.`);
  const helpTiming = measureCommand(bin, ["--help"], { cwd: temp, capture: true });

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
  assert(/ChatGPT Web is now the saved PAIR provider/i.test(setup.stdout), "Packed setup did not select ChatGPT Web as the default saved PAIR provider.");
  assert(!/tunnel ID|API key|MCP connector|relay endpoint/i.test(setup.stderr), "Packed normal setup unexpectedly requested advanced transport infrastructure.");
  const configPath = path.join(wcoHome, "config.json");
  const preferencesPath = path.join(wcoHome, "preferences.json");
  const firstConfigBytes = readFileSync(configPath, "utf8");
  const firstPreferencesBytes = readFileSync(preferencesPath, "utf8");
  const config = JSON.parse(firstConfigBytes);
  const preferences = JSON.parse(firstPreferencesBytes);
  assert(config.web_bridge === undefined, "Packed fresh config must leave web_bridge absent for the local zero-config transport.");
  assert(config.runtime?.source === "bundled", "Packed fresh config must pin the bundled official Codex runtime.");
  assert(preferences.schema_version === "1.0" && preferences.provider === "chatgpt-web", "Packed fresh setup must persist the ChatGPT Web provider preference.");
  assert(!firstConfigBytes.includes("relay_url") && !firstConfigBytes.includes("gpt_url"), "Packed fresh config must not persist relay/GPT endpoints.");
  run(bin, ["setup", "--yes"], { cwd: project, capture: true, env: isolatedEnv });
  assert(readFileSync(configPath, "utf8") === firstConfigBytes, "Packed repeated setup changed trusted config for an already registered repository.");
  assert(readFileSync(preferencesPath, "utf8") === firstPreferencesBytes, "Packed repeated setup changed the saved provider preference for an already registered repository.");
  const webStatus = run(bin, ["web", "status"], { cwd: project, capture: true, env: isolatedEnv, expectedStatuses: [1] });
  assert(/Mode\s+ChatGPT Web browser PAIR/i.test(webStatus.stdout), "Packed web status did not report the saved ChatGPT Web browser provider.");
  assert(/ChatGPT Web session\s+not ready/i.test(webStatus.stdout), "Packed web status did not fail closed on missing local browser readiness.");
  assert(/Codex provider quota\s+not required for PAIR/i.test(webStatus.stdout), "Packed web status implied Codex provider quota is required for browser PAIR.");
  assert(/Browser readiness\s+CI probe disabled; run locally/i.test(webStatus.stdout), "Packed CI status did not disable the real browser readiness probe.");
  assert(!/Mode\s+local ChatGPT\/Codex/i.test(webStatus.stdout), "Packed web status regressed to the legacy provider UX.");
  assert(!/managed|MCP|relay URL|tunnel/i.test(webStatus.stdout), "Packed zero-config status leaked an advanced transport requirement.");

  const interactiveTiming = packedInteractivePtySmoke(bin, project, isolatedEnv);

  if (process.platform === "linux") {
    const ptyEnv = { ...isolatedEnv, TERM: "xterm-256color" };
    const continuePty = run("script", ["-qec", `${bin} --continue`, "/dev/null"], { cwd: project, capture: true, env: ptyEnv, input: "\x04", timeoutMs: 10_000 });
    const continueOutput = `${continuePty.stdout ?? ""}\n${continuePty.stderr ?? ""}`;
    assert(/no current saved task to continue/i.test(continueOutput), "Packed `wco --continue` did not enter the interactive continuation path inside a PTY.");
    assert(!/require(?:s|d) a TTY/i.test(continueOutput), "Packed `wco --continue` incorrectly rejected a real PTY.");
    const resumePty = run("script", ["-qec", `${bin} --resume`, "/dev/null"], { cwd: project, capture: true, env: ptyEnv, input: "\x04", timeoutMs: 10_000 });
    const resumeOutput = `${resumePty.stdout ?? ""}\n${resumePty.stderr ?? ""}`;
    assert(/no saved tasks are available to resume/i.test(resumeOutput), "Packed `wco --resume` did not enter the interactive resume path inside a PTY.");
    assert(!/require(?:s|d) a TTY/i.test(resumeOutput), "Packed `wco --resume` incorrectly rejected a real PTY.");
  }

  console.log(`Packed CLI clean-install + zero-config first-run smoke PASS (${pkg.name}@${pkg.version}).`);
  console.log(`Packed CLI process metrics ${JSON.stringify({ version: { first_ms: versionTiming.first_ms, median_ms: versionTiming.median_ms, max_ms: versionTiming.max_ms }, help: { first_ms: helpTiming.first_ms, median_ms: helpTiming.median_ms, max_ms: helpTiming.max_ms }, interactive: interactiveTiming })}`);
} finally {
  if (tarball) { try { unlinkSync(tarball); } catch {} }
  rmSync(temp, { recursive: true, force: true });
}
