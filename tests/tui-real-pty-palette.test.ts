import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
const fixture = path.resolve("tests/fixtures/tui-real-pty-driver.ts");

const PYTHON = String.raw`
import base64, fcntl, json, os, pty, select, struct, sys, termios, time
cmd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 60, 0, 0))
buf = bytearray()
def drain(timeout=0.05):
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready: return
    try: chunk = os.read(fd, 4096)
    except OSError: return
    if chunk: buf.extend(chunk)
def wait(marker, start=0, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        pos = bytes(buf).find(marker, start)
        if pos >= 0: return pos
        drain()
    raise RuntimeError("timeout waiting for %r; transcript=%r" % (marker, bytes(buf)[-1200:]))
first = wait(b"> ")
os.write(fd, b"/")
palette = wait(b"/new", first)
mark = len(buf)
os.write(fd, b"new\r")
argument_prompt = wait(b"> /new ", mark)
mark = len(buf)
os.write(fd, b"PTY exact command goal\r")
accepted = wait(b"accepted:PTY exact command goal", mark)
prompt2 = wait(b"> ", accepted + 1)
mark = len(buf)
os.write(fd, b"/st\t")
completed = wait(b"> /status", mark)
os.write(fd, b"\r")
status1 = wait(b"status: ok", completed)
prompt3 = wait(b"> ", status1 + 1)
mark = len(buf)
os.write(fd, b"\x1b[A\r")
status2 = wait(b"status: ok", max(mark, status1 + len(b"status: ok")))
os.write(fd, b"/quit\r")
wait(b"bye", status2)
exit_status = None
deadline = time.time() + 4.0
while time.time() < deadline:
    drain()
    done, status = os.waitpid(pid, os.WNOHANG)
    if done == pid:
        exit_status = status
        break
timed_out = exit_status is None
if timed_out:
    os.kill(pid, 9)
    _, exit_status = os.waitpid(pid, 0)
print(json.dumps({"exit_code": os.waitstatus_to_exitcode(exit_status), "timed_out": timed_out, "transcript": base64.b64encode(bytes(buf)).decode("ascii")}))
`;

async function run(): Promise<{ exit_code: number; timed_out: boolean; transcript: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", PYTHON, process.execPath, tsxCli, fixture], {
      cwd: process.cwd(),
      env: { ...process.env, WCO_PTY_SCENARIO: "palette" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8").trim();
      if (code !== 0) return reject(new Error(Buffer.concat(err).toString("utf8") || stdout));
      resolve(JSON.parse(stdout));
    });
  });
}

function visible(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "").replace(/\r/gu, "");
}

test("real PTY exposes slash palette immediately and preserves completion plus command history", { skip: process.platform !== "linux" }, async () => {
  const result = await run();
  const transcript = visible(result.transcript);
  assert.equal(result.timed_out, false, transcript);
  assert.equal(result.exit_code, 0, transcript);
  assert.match(transcript, /\/new\s+PAIR: collaborate on a task/);
  assert.match(transcript, /> \/new /);
  assert.match(transcript, /accepted:PTY exact command goal/);
  assert.match(transcript, /> \/status/);
  assert.equal((transcript.match(/status: ok/g) ?? []).length, 2, transcript);
  assert.match(transcript, /bye/);
});
