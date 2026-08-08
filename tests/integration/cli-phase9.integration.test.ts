import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createPhase9Fixture, buildPhase9Pack } from "../helpers/phase9-fixture.js";

const execFile = promisify(execFileCallback);

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFile(process.execPath, [path.resolve("dist/web-authority/standalone-cli.js"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("CLI-P9-001 compiled register-web-pack and status use the immutable registry", async (t) => {
  const fixture = await createPhase9Fixture();
  t.after(async () => fs.rm(fixture.root, { recursive: true, force: true }));
  const archive = await buildPhase9Pack(fixture);
  const registered = await run([
    "register-web-pack",
    "--run-id", fixture.runId,
    "--state-dir", fixture.state,
    "--config", fixture.config,
    "--pack", archive,
    "--json",
  ]);
  assert.equal(registered.stderr, "");
  const registration = JSON.parse(registered.stdout) as { artifact_sha256: string; run_id: string };
  assert.equal(registration.run_id, fixture.runId);
  assert.match(registration.artifact_sha256, /^[a-f0-9]{64}$/);

  const status = await run([
    "web-pack-status",
    "--run-id", fixture.runId,
    "--state-dir", fixture.state,
    "--artifact-sha256", registration.artifact_sha256,
    "--json",
  ]);
  const parsed = JSON.parse(status.stdout) as { state: string; registration: { artifact_sha256: string } };
  assert.equal(parsed.state, "REGISTERED");
  assert.equal(parsed.registration.artifact_sha256, registration.artifact_sha256);
});
