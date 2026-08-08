import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.resolve("tests");
const FAILURE_LOG = path.resolve(".wco-ci-unit-failure.log");
const PER_FILE_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 5_000;
const MAX_FAILURE_STREAM_BYTES = 1024 * 1024;
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));

function boundedTail(current, chunk, maximumBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.byteLength <= maximumBytes
    ? combined
    : combined.subarray(combined.byteLength - maximumBytes);
}

const files = (await readdir(TEST_DIRECTORY, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

if (files.length === 0) {
  console.error("No unit test files were discovered under tests/*.test.ts.");
  process.exit(1);
}

await writeFile(FAILURE_LOG, "", { mode: 0o600 });

for (const file of files) {
  const testPath = path.join(TEST_DIRECTORY, file);
  process.stdout.write(`\n=== UNIT FILE: ${file} ===\n`);

  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [tsxCli, "--test", "--test-reporter=spec", testPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        shell: false,
      },
    );

    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      stdoutTail = boundedTail(stdoutTail, chunk, MAX_FAILURE_STREAM_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrTail = boundedTail(stderrTail, chunk, MAX_FAILURE_STREAM_BYTES);
    });

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
      resolve({ ok: false, message: `Cannot start ${file}: ${error.message}`, stdoutTail, stderrTail });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (timedOut) {
        resolve({ ok: false, message: `${file} timed out.`, stdoutTail, stderrTail });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, message: `${file} failed with code ${String(code)} signal ${String(signal)}.`, stdoutTail, stderrTail });
        return;
      }
      resolve({ ok: true, message: `${file} passed.`, stdoutTail, stderrTail });
    });
  });

  if (!result.ok) {
    const diagnostic = Buffer.concat([
      Buffer.from(`unit_file=${file}\nresult=${result.message}\n--- stdout tail ---\n`, "utf8"),
      result.stdoutTail,
      Buffer.from("\n--- stderr tail ---\n", "utf8"),
      result.stderrTail,
      Buffer.from("\n", "utf8"),
    ]);
    await writeFile(FAILURE_LOG, diagnostic, { mode: 0o600 });
    console.error(result.message);
    process.exit(1);
  }
}

console.log(`\nAll ${files.length} unit test files passed.`);
