import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["scripts/smoke-packed-cli.mjs"], {
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
if (!line) throw new Error("pack smoke passed without emitting packed CLI process metrics");

let metrics;
try { metrics = JSON.parse(line.slice(marker.length)); }
catch (error) { throw new Error("pack smoke emitted malformed packed CLI process metrics", { cause: error }); }

// These are intentionally broad production guardrails, not microbenchmark targets.
// They leave ample runner variance while catching accidental multi-second startup,
// runaway idle memory, or a terminal shutdown regression.
if (process.env.CI === "true" && process.platform === "linux") {
  const failures = [];
  if (metrics.version?.median_ms > 1_200) failures.push(`--version median ${metrics.version.median_ms}ms > 1200ms`);
  if (metrics.help?.median_ms > 1_200) failures.push(`--help median ${metrics.help.median_ms}ms > 1200ms`);
  if (metrics.interactive?.prompt_ms > 2_000) failures.push(`time-to-prompt ${metrics.interactive.prompt_ms}ms > 2000ms`);
  if (metrics.interactive?.idle_rss_kb > 262_144) failures.push(`idle RSS ${metrics.interactive.idle_rss_kb}KiB > 262144KiB`);
  if (metrics.interactive?.quit_ms > 1_000) failures.push(`/quit latency ${metrics.interactive.quit_ms}ms > 1000ms`);
  if (failures.length) throw new Error(`Packed CLI responsiveness regression:\n- ${failures.join("\n- ")}`);
}

const outputDirectory = path.resolve("artifacts");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(path.join(outputDirectory, "packed-cli-process-metrics.json"), `${JSON.stringify({
  schema_version: "1.0",
  measured_at: new Date().toISOString(),
  runner: { platform: process.platform, arch: process.arch, node: process.version },
  metrics,
}, null, 2)}\n`, "utf8");
