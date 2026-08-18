import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "linux") {
  console.log("Packed real-user journey smoke skipped: normal deterministic workflow is Linux/WSL only.");
  process.exit(0);
}

const npm = "npm";
const git = "git";
const root = process.cwd();
const temp = mkdtempSync(path.join(os.tmpdir(), "wco-packed-user-journey-"));
let tarball;

function run(command, args, options = {}) {
  const expectedStatuses = options.expectedStatuses ?? [0];
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
    env: options.env ?? process.env,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
  if (result.error) throw result.error;
  if (!expectedStatuses.includes(result.status)) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${String(result.status)}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function initRepository(directory, remote, pushRemote = remote) {
  mkdirSync(directory, { recursive: true });
  run(git, ["init", "-b", "main"], { cwd: directory });
  run(git, ["config", "user.name", "WCO Real User"], { cwd: directory });
  run(git, ["config", "user.email", "wco-real-user@example.invalid"], { cwd: directory });
  writeFileSync(path.join(directory, "README.md"), "# real-user journey\n", "utf8");
  run(git, ["add", "README.md"], { cwd: directory });
  run(git, ["commit", "-m", "initial user fixture"], { cwd: directory });
  if (remote) {
    run(git, ["remote", "add", "origin", remote], { cwd: directory });
    if (pushRemote !== remote) run(git, ["remote", "set-url", "--push", "origin", pushRemote], { cwd: directory });
    if (pushRemote === remote) run(git, ["push", "-u", "origin", "main"], { cwd: directory });
  }
}

function isolatedEnv(home, wcoHome) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, WCO_HOME: wcoHome, CI: "true", TERM: "xterm-256color" };
  delete env.WCO_CONFIG;
  delete env.WCO_STATE_DIR;
  return env;
}

function runPty(bin, cwd, env, mode) {
  const driver = String.raw`
import base64, fcntl, json, os, pty, select, signal, sys, time
bin_path, mode = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execv(bin_path, [bin_path])
fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
buf = bytearray()
def drain(timeout=0.05):
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready: return
    try: chunk = os.read(fd, 8192)
    except (BlockingIOError, OSError): return
    if chunk: buf.extend(chunk)
def wait(marker, timeout=12.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if marker in bytes(buf): return
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid: raise RuntimeError("child exited before marker %r; transcript=%r" % (marker, bytes(buf)[-3000:]))
        drain()
    raise RuntimeError("timeout waiting for %r; transcript=%r" % (marker, bytes(buf)[-3000:]))
def wait_exit(timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        drain()
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            drain(0.01)
            return status, False
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    _, status = os.waitpid(pid, 0)
    return status, True
try:
    if mode == "palette-quit":
        wait(b"> ")
        os.write(fd, b"/")
        wait(b"/new")
        os.write(fd, b"quit\r")
        wait(b"bye")
    elif mode == "interrupt-exit":
        wait(b"> ")
        os.write(fd, b"draft text that should be cancelled")
        os.write(fd, b"\x03")
        wait(b"Input cancelled.")
        wait(b"> ")
        os.write(fd, b"\x04")
        wait(b"Goodbye.")
    elif mode == "goal-auth-quit":
        wait(b"> ")
        os.write(fd, b"Change the README heading and add a regression test\r")
        wait(b"No task state was created.")
        os.write(fd, b"/quit\r")
        wait(b"Goodbye.")
    elif mode != "exit-only":
        raise RuntimeError("unknown mode " + mode)
    status, timed_out = wait_exit()
    print(json.dumps({"exit_code": os.waitstatus_to_exitcode(status), "timed_out": timed_out, "transcript": base64.b64encode(bytes(buf)).decode("ascii")}))
finally:
    try: os.close(fd)
    except OSError: pass
`;
  const result = spawnSync("python3", ["-c", driver, bin, mode], { cwd, env, encoding: "utf8", stdio: "pipe", shell: false, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PTY driver failed (${mode}).\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`);
  const parsed = JSON.parse((result.stdout ?? "").trim());
  const transcript = Buffer.from(parsed.transcript, "base64").toString("utf8");
  assert(parsed.timed_out === false, `Packed WCO timed out in ${mode}.\n${transcript}`);
  return { exitCode: parsed.exit_code, transcript };
}

function allTextBelow(directory) {
  if (!existsSync(directory)) return "";
  const chunks = [];
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const item = path.join(current, name);
      const stats = statSync(item);
      if (stats.isDirectory()) visit(item);
      else if (stats.isFile() && stats.size <= 1_048_576) {
        try { chunks.push(readFileSync(item, "utf8")); } catch {}
      }
    }
  };
  visit(directory);
  return chunks.join("\n");
}

function recordSmokeFailure(error) {
  const metricsPath = path.join(root, "artifacts", "packed-cli-process-metrics.json");
  let metrics = {};
  try { metrics = JSON.parse(readFileSync(metricsPath, "utf8")); } catch {}
  metrics.packed_user_journey_failure = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
  };
  mkdirSync(path.dirname(metricsPath), { recursive: true });
  writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

try {
  const packed = run(npm, ["pack", "--json"]);
  const parsed = JSON.parse(packed.stdout);
  tarball = path.resolve(root, parsed[0].filename);
  const installRoot = path.join(temp, "install");
  run(npm, ["install", "--prefix", installRoot, "--omit=dev", "--ignore-scripts", tarball]);
  const bin = path.join(installRoot, "node_modules", ".bin", "wco");

  const remote = path.join(temp, "remote.git");
  run(git, ["init", "--bare", remote], { cwd: temp });
  const project = path.join(temp, "project");
  initRepository(project, remote);
  const userHome = path.join(temp, "user-home");
  const wcoHome = path.join(temp, "wco-home");
  mkdirSync(userHome, { recursive: true });
  const env = isolatedEnv(userHome, wcoHome);

  // Real fresh-user path: install tarball, cd project, type only `wco`.
  const first = runPty(bin, project, env, "palette-quit");
  assert(first.exitCode === 0, `fresh bare wco exited ${first.exitCode}.\n${first.transcript}`);
  assert(/Welcome to WCO/.test(first.transcript), "Fresh packed `wco` did not show the first-run welcome.");
  assert(/Checking this project for the normal Linux\/WSL workflow/.test(first.transcript), "Fresh packed `wco` did not preflight the supported execution host.");
  assert(/Checking this Git repository and initial WCO setup/.test(first.transcript), "Fresh packed `wco` did not auto-run local setup.");
  assert(/Execution host\s+Linux\/WSL verification supported/.test(first.transcript), "Fresh packed `wco` did not report Linux/WSL support.");
  assert(/Setup is complete/.test(first.transcript), "Fresh packed `wco` did not complete setup before opening the prompt.");
  assert(/local ChatGPT\/Codex/i.test(first.transcript), "Fresh packed `wco` did not select zero-config local ChatGPT/Codex.");
  assert(/\/new/.test(first.transcript), "Fresh packed `wco` did not expose the normal slash palette.");
  assert(/No API key, relay, tunnel, domain, or cloud setup is required/i.test(first.transcript), "Fresh packed `wco` did not reassure the user that hosted/API infrastructure is unnecessary.");
  assert(!/(?:API key|relay endpoint|tunnel ID|public host|domain setup)\s*(?:is\s+)?(?:required|needed|:|=)|(?:enter|provide|configure)\s+(?:an?\s+)?(?:API key|relay endpoint|tunnel ID|public host|domain)/i.test(first.transcript), "Fresh normal path requested advanced infrastructure instead of remaining zero-config.");

  const configPath = path.join(wcoHome, "config.json");
  const firstConfig = readFileSync(configPath, "utf8");
  const config = JSON.parse(firstConfig);
  assert(config.web_bridge === undefined, "Fresh bare `wco` persisted an advanced Web transport.");
  assert(config.runtime?.source === "bundled", "Fresh bare `wco` did not pin the bundled Codex runtime.");

  // Returning user: same command, no repeated setup and byte-identical trusted config.
  const second = runPty(bin, project, env, "palette-quit");
  assert(second.exitCode === 0, `returning bare wco exited ${second.exitCode}.\n${second.transcript}`);
  assert(!/Welcome to WCO/.test(second.transcript), "Returning packed `wco` repeated first-run welcome.");
  assert(!/Checking this Git repository and initial WCO setup/.test(second.transcript), "Returning packed `wco` repeated setup.");
  assert(readFileSync(configPath, "utf8") === firstConfig, "Returning packed `wco` rewrote trusted config without a user change.");

  // Real packed terminal controls: cancel draft input without exiting, then safe-exit from an empty prompt.
  const controls = runPty(bin, project, env, "interrupt-exit");
  assert(controls.exitCode === 0, `packed Ctrl+C/Ctrl+D flow exited ${controls.exitCode}.\n${controls.transcript}`);
  assert(/Input cancelled\./.test(controls.transcript), "Packed Ctrl+C did not cancel only the current input buffer.");
  assert(/Goodbye\./.test(controls.transcript), "Packed Ctrl+D did not complete the safe-exit handshake.");

  // Break the auth/readiness boundary as a user would: type a real goal while CI has no ChatGPT authorization.
  const beforeGoalState = allTextBelow(wcoHome);
  const blockedGoal = runPty(bin, project, env, "goal-auth-quit");
  assert(blockedGoal.exitCode === 0, `auth-blocked user flow did not recover to the prompt.\n${blockedGoal.transcript}`);
  assert(/ChatGPT authorization is not ready/.test(blockedGoal.transcript), "Missing ChatGPT auth did not produce direct recovery guidance.");
  assert(/No task state was created/.test(blockedGoal.transcript), "Missing ChatGPT auth did not state the no-side-effect guarantee.");
  const afterGoalState = allTextBelow(wcoHome);
  assert(!afterGoalState.includes("Change the README heading and add a regression test"), "Auth-blocked real goal leaked into durable task state.");
  assert(afterGoalState.length >= beforeGoalState.length, "Unexpected WCO state truncation after auth-blocked goal.");

  // Break first-run prerequisites through the packed binary, not imported test helpers.
  const outside = path.join(temp, "outside-git");
  mkdirSync(outside, { recursive: true });
  const outsideHome = path.join(temp, "outside-home");
  mkdirSync(outsideHome, { recursive: true });
  const outsideWco = path.join(temp, "outside-wco");
  const notRepo = runPty(bin, outside, isolatedEnv(outsideHome, outsideWco), "exit-only");
  assert(notRepo.exitCode !== 0, "Bare packed `wco` unexpectedly succeeded outside a Git repository.");
  assert(/inside a Git repository/.test(notRepo.transcript), "Outside-repo failure did not give direct `cd` recovery guidance.");
  assert(/project files and remote repository were not changed/i.test(notRepo.transcript), "Outside-repo failure did not state the side-effect boundary.");
  assert(!existsSync(path.join(outsideWco, "config.json")), "Outside-repo failure created trusted config.");

  const noRemoteProject = path.join(temp, "no-remote-project");
  initRepository(noRemoteProject, null);
  const noRemoteHome = path.join(temp, "no-remote-home");
  mkdirSync(noRemoteHome, { recursive: true });
  const noRemoteWco = path.join(temp, "no-remote-wco");
  const noRemote = runPty(bin, noRemoteProject, isolatedEnv(noRemoteHome, noRemoteWco), "exit-only");
  assert(noRemote.exitCode !== 0, "Bare packed `wco` unexpectedly accepted a repository with no remote.");
  assert(/no remote yet/.test(noRemote.transcript), "Missing-remote failure did not tell the user to add a remote.");
  assert(/git remote -v/.test(noRemote.transcript), "Missing-remote recovery did not give a concrete verification command.");
  assert(!existsSync(path.join(noRemoteWco, "config.json")), "Missing-remote failure created trusted config.");

  const fetchRemote = path.join(temp, "fetch.git");
  const pushRemote = path.join(temp, "push.git");
  run(git, ["init", "--bare", fetchRemote], { cwd: temp });
  run(git, ["init", "--bare", pushRemote], { cwd: temp });
  const splitRemoteProject = path.join(temp, "split-remote-project");
  initRepository(splitRemoteProject, fetchRemote, pushRemote);
  const splitHome = path.join(temp, "split-home");
  mkdirSync(splitHome, { recursive: true });
  const splitWco = path.join(temp, "split-wco");
  const split = runPty(bin, splitRemoteProject, isolatedEnv(splitHome, splitWco), "exit-only");
  assert(split.exitCode !== 0, "Bare packed `wco` unexpectedly accepted mismatched fetch/push URLs.");
  assert(/different fetch and push URLs/.test(split.transcript), "Remote-identity block did not explain why setup stopped.");
  assert(/Align the Git remote/.test(split.transcript), "Remote-identity block did not give a concrete recovery action.");
  assert(!existsSync(path.join(splitWco, "config.json")), "Remote-identity failure created trusted config.");

  console.log("Packed real-user journey + blocked-prerequisite + terminal-control smoke PASS.");
} catch (error) {
  recordSmokeFailure(error);
  throw error;
} finally {
  if (tarball) { try { unlinkSync(tarball); } catch {} }
  rmSync(temp, { recursive: true, force: true });
}
