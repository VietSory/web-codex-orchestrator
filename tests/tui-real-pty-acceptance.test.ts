import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
const fixture = path.resolve("tests/fixtures/tui-real-pty-driver.ts");

const PYTHON_PTY_DRIVER = String.raw`
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

cmd = sys.argv[1:]
scenario = os.environ.get("WCO_PTY_SCENARIO", "interactive")
pid, fd = pty.fork()
if pid == 0:
    os.execv(cmd[0], cmd)

captured = bytearray()

def resize(columns, rows=40):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    try:
        os.kill(pid, signal.SIGWINCH)
    except ProcessLookupError:
        pass

resize(24)

def drain_once(timeout=0.05):
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return False
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        return False
    if chunk:
        captured.extend(chunk)
        return True
    return False


def wait_new(marker, start, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        index = bytes(captured).find(marker, start)
        if index >= 0:
            return index
        drain_once(0.05)
    raise RuntimeError("timeout waiting for %r; transcript=%r" % (marker, bytes(captured)[-1200:]))

try:
    first_prompt = wait_new(b"> ", 0)
    if scenario == "interactive":
        goal = b"Add a deliberately long goal that wraps across terminal width without losing any typed text"
        split = 33
        os.write(fd, goal[:split])
        time.sleep(0.12)
        resize(40)
        os.write(fd, goal[split:] + b"\r")

        accepted = b"accepted:" + goal
        accepted_at = wait_new(accepted, first_prompt)
        prompt_after_goal = wait_new(b"> ", accepted_at + len(accepted))

        os.write(fd, b"/st")
        time.sleep(1.15)
        bg_at = wait_new(b"BG_PROGRESS", prompt_after_goal)
        resize(60)
        os.write(fd, b"atus\r")
        status_at = wait_new(b"status: ok", bg_at)

        os.write(fd, b"/quit\r")
        wait_new(b"bye", status_at)
    elif scenario == "ctrlc":
        os.write(fd, b"\x03")
        cancelled_at = wait_new(b"Input cancelled.", first_prompt)
        prompt_after_cancel = wait_new(b"> ", cancelled_at + len(b"Input cancelled."))
        os.write(fd, b"\x04")
        wait_new(b"safe-exit", prompt_after_cancel)
    else:
        raise RuntimeError("unknown scenario: " + scenario)

    deadline = time.time() + 4.0
    exit_status = None
    while time.time() < deadline:
        drain_once(0.05)
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            exit_status = status
            break
    timed_out = exit_status is None
    if timed_out:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        _, exit_status = os.waitpid(pid, 0)

    for _ in range(10):
        if not drain_once(0.01):
            break

    print(json.dumps({
        "exit_code": os.waitstatus_to_exitcode(exit_status),
        "timed_out": timed_out,
        "transcript_base64": base64.b64encode(bytes(captured)).decode("ascii"),
    }))
finally:
    try:
        os.close(fd)
    except OSError:
        pass
`;

interface PtyResult {
  exit_code: number;
  timed_out: boolean;
  transcript_base64: string;
}

async function runPtyScenario(scenario: "interactive" | "ctrlc"): Promise<PtyResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", PYTHON_PTY_DRIVER, process.execPath, tsxCli, fixture], {
      cwd: process.cwd(),
      env: { ...process.env, WCO_PTY_SCENARIO: scenario },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`PTY harness failed with code ${String(code)}: ${err}\n${out}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as PtyResult);
      } catch (error) {
        reject(new Error(`PTY harness returned invalid JSON: ${out}\n${err}`, { cause: error }));
      }
    });
  });
}

function visibleTranscript(result: PtyResult): string {
  return Buffer.from(result.transcript_base64, "base64")
    .toString("utf8")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "");
}

test("real PTY preserves wrapped input across resize and redraws around background output", { skip: process.platform !== "linux" }, async () => {
  const result = await runPtyScenario("interactive");
  const transcript = visibleTranscript(result);
  const goal = "Add a deliberately long goal that wraps across terminal width without losing any typed text";

  assert.equal(result.timed_out, false, transcript);
  assert.equal(result.exit_code, 0, transcript);
  assert.match(transcript, new RegExp(`accepted:${goal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));

  const partial = transcript.lastIndexOf("/st", transcript.indexOf("BG_PROGRESS"));
  const background = transcript.indexOf("BG_PROGRESS");
  const status = transcript.indexOf("status: ok", background);
  assert.ok(partial >= 0 && background > partial, `background output did not interleave with active input:\n${transcript}`);
  assert.ok(status > background, `status command was lost or corrupted after redraw:\n${transcript}`);
  assert.match(transcript, /bye/);
});

test("real PTY Ctrl+C cancels input and Ctrl+D exits through the safe-exit handshake", { skip: process.platform !== "linux" }, async () => {
  const result = await runPtyScenario("ctrlc");
  const transcript = visibleTranscript(result);

  assert.equal(result.timed_out, false, transcript);
  assert.equal(result.exit_code, 0, transcript);
  const cancelled = transcript.indexOf("Input cancelled.");
  const safeExit = transcript.indexOf("safe-exit", cancelled + 1);
  assert.ok(cancelled >= 0, transcript);
  assert.ok(safeExit > cancelled, transcript);
});
