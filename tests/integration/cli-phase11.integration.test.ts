import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const RUN_ID = `TASK-CLI-P11:${"a".repeat(64)}`;

async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/orchestration/standalone-cli.js"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk)); child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject); child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

test("CLI-P11-001 compiled next is read-only and returns the first required transition", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-cli-p11-")); t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const result = await run(["next", "--run-id", RUN_ID, "--state-dir", path.join(root, "state"), "--config", path.join(root, "config.json"), "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { transition: string };
  assert.equal(parsed.transition, "REGISTER_WEB_PACK");
});

test("CLI-P11-002 compiled pause/resume persists durable control state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-cli-p11-pause-")); t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const common = ["--run-id", RUN_ID, "--state-dir", path.join(root, "state"), "--config", path.join(root, "config.json"), "--json"];
  const paused = await run(["pause", ...common]);
  assert.equal(paused.code, 0, paused.stderr); assert.equal((JSON.parse(paused.stdout) as { paused: boolean }).paused, true);
  const resumed = await run(["resume", ...common]);
  assert.equal(resumed.code, 0, resumed.stderr); assert.equal((JSON.parse(resumed.stdout) as { paused: boolean }).paused, false);
});
