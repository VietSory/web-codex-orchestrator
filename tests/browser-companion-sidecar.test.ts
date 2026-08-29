import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Windows companion sidecar is byte-for-byte portable GNU sha256sum input", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-companion-sidecar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "wco-browser-companion-windows-x64.exe");
  const sidecar = path.join(root, "wco-browser-companion-windows-x64.exe.sha256");
  const bytes = Buffer.from([0, 1, 2, 3, 255]);
  await writeFile(executable, bytes);
  const digest = execFileSync(process.execPath, [path.resolve("scripts/write-companion-sha256.mjs"), executable, sidecar, path.basename(executable)], { encoding: "utf8" }).trim();
  const expected = `${createHash("sha256").update(bytes).digest("hex")}  wco-browser-companion-windows-x64.exe\n`;
  assert.equal(digest, expected.slice(0, 64));
  assert.deepEqual(await readFile(sidecar), Buffer.from(expected, "ascii"));
  assert.equal((await readFile(sidecar)).includes(0x0d), false, "portable sidecar must contain no CR");
  if (process.platform === "linux") assert.doesNotThrow(() => execFileSync("sha256sum", ["-c", path.basename(sidecar)], { cwd: root, encoding: "utf8" }));
});
