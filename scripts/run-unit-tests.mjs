import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.resolve("tests");
const PER_FILE_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 5_000;
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));

const files = (await readdir(TEST_DIRECTORY, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

if (files.length === 0) {
  console.error("No unit test files were discovered under tests/*.test.ts.");
  process.exit(1);
}

for (const file of files) {
  const testPath = path.join(TEST_DIRECTORY, file);
  process.stdout.write(`\n=== UNIT FILE: ${file} ===\n`);

  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [tsxCli, "--test", "--test-reporter=spec", testPath],
      {
        stdio: "inherit",
        env: process.env,
        shell: false,
      },
    );

    let timedOut = false;
    let forceTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      process.stderr.write(`UNIT_FILE_TIMEOUT: ${file} exceeded ${PER_FILE_TIMEOUT_MS}ms.\n`);
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      forceTimer.unref();
    }, PER_FILE_TIMEOUT_MS);
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ ok: false, message: `Cannot start ${file}: ${error.message}` });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (timedOut) {
        resolve({ ok: false, message: `${file} timed out.` });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, message: `${file} failed with code ${String(code)} signal ${String(signal)}.` });
        return;
      }
      resolve({ ok: true, message: `${file} passed.` });
    });
  });

  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
}

console.log(`\nAll ${files.length} unit test files passed.`);
