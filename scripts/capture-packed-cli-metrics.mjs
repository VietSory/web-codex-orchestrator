import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "pack:smoke"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: "pipe",
  shell: false,
  env: process.env,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const marker = "Packed CLI process metrics ";
const line = (result.stdout ?? "").split(/\r?\n/u).find((value) => value.startsWith(marker));
if (!line) throw new Error("pack:smoke passed without emitting packed CLI process metrics");

let metrics;
try { metrics = JSON.parse(line.slice(marker.length)); }
catch (error) { throw new Error("pack:smoke emitted malformed packed CLI process metrics", { cause: error }); }

const outputDirectory = path.resolve("artifacts");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(path.join(outputDirectory, "packed-cli-process-metrics.json"), `${JSON.stringify({
  schema_version: "1.0",
  measured_at: new Date().toISOString(),
  runner: { platform: process.platform, arch: process.arch, node: process.version },
  metrics,
}, null, 2)}\n`, "utf8");
