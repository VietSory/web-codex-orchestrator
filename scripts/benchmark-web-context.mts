import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { ContentAddressedContextCache, emptyContextTransferMetrics, type ContextTransferMetrics } from "../src/web-bridge/context-cache.js";
import { ExactRepositoryReadService } from "../src/web-bridge/repo-read-service.js";
import { ReadCoverageStore } from "../src/web-bridge/read-coverage-store.js";

const run = promisify(execFile);
type Scenario = { name: string; mode: "PAIR" | "AUTOPILOT"; files: Record<string, string>; turns: string[][] };
const repeat = (label: string, bytes: number): string => `${label}\n${"x".repeat(Math.max(0, bytes - label.length - 1))}`;
const scenarios: Scenario[] = [
  { name: "small-one-file", mode: "PAIR", files: { "src/a.ts": repeat("a", 8_192) }, turns: [["src/a.ts"]] },
  { name: "multi-file-feature", mode: "PAIR", files: { "src/api.ts": repeat("api", 24_000), "src/service.ts": repeat("service", 32_000), "test/service.test.ts": repeat("test", 28_000), "README.md": repeat("docs", 12_000) }, turns: [["src/api.ts", "src/service.ts"], ["src/api.ts", "src/service.ts", "test/service.test.ts"], ["README.md", "src/service.ts"]] },
  { name: "surrounding-code-review", mode: "PAIR", files: { "src/change.ts": repeat("change", 30_000), "src/caller-a.ts": repeat("caller-a", 22_000), "src/caller-b.ts": repeat("caller-b", 26_000), "test/change.test.ts": repeat("test", 18_000) }, turns: [["src/change.ts"], ["src/change.ts", "src/caller-a.ts", "src/caller-b.ts"], ["src/change.ts", "test/change.test.ts"]] },
  { name: "model-revise-web-revise", mode: "AUTOPILOT", files: { "diff/g1.txt": repeat("g1", 36_000), "verify/g1.txt": repeat("v1", 12_000), "diff/g2.txt": repeat("g2", 40_000), "verify/g2.txt": repeat("v2", 12_000), "acceptance.txt": repeat("acceptance", 16_000) }, turns: [["acceptance.txt", "diff/g1.txt", "verify/g1.txt"], ["acceptance.txt", "diff/g1.txt", "verify/g1.txt"], ["acceptance.txt", "diff/g2.txt", "verify/g2.txt"], ["acceptance.txt", "diff/g2.txt", "verify/g2.txt"]] },
];

function addMetrics(target: ContextTransferMetrics, value: ContextTransferMetrics): void {
  for (const key of Object.keys(target) as Array<keyof ContextTransferMetrics>) target[key] += value[key];
}

async function measure(scenario: Scenario) {
  const root = await mkdtemp(path.join(os.tmpdir(), `wco-web-context-${scenario.name}-`));
  try {
    const repo = path.join(root, "repo");
    const cacheRoot = path.join(root, "cache");
    const coverageRoot = path.join(root, "coverage");
    await mkdir(repo, { recursive: true });
    await run("git", ["init", "-b", "main"], { cwd: repo });
    await run("git", ["config", "user.name", "WCO Context Benchmark"], { cwd: repo });
    await run("git", ["config", "user.email", "context-benchmark@example.invalid"], { cwd: repo });
    for (const [relative, content] of Object.entries(scenario.files)) {
      const target = path.join(repo, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "context benchmark fixture"], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
    });
    const base = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    const cache = new ContentAddressedContextCache(cacheRoot);
    const coverage = new ReadCoverageStore(coverageRoot);
    const service = new ExactRepositoryReadService(repo, { repository_id: `benchmark:${scenario.name}`, base_branch: "main", base_commit: base }, coverage, {}, cache);
    const knownContent: Record<string, string> = {};
    const metrics = emptyContextTransferMetrics();
    const started = performance.now();
    let naiveBytes = 0;
    for (let index = 0; index < scenario.turns.length; index += 1) {
      const requested = scenario.turns[index]!;
      naiveBytes += requested.reduce((sum, relative) => sum + Buffer.byteLength(scenario.files[relative]!, "utf8"), 0);
      const result = await service.read("benchmark-job", `turn-${index + 1}`, requested, () => new Date("2000-01-01T00:00:00.000Z"), knownContent);
      addMetrics(metrics, result.metrics);
      for (const file of result.files) knownContent[file.path] = file.content_sha256;
    }
    const elapsed = Number((performance.now() - started).toFixed(3));
    const reduction = naiveBytes === 0 ? 0 : Number(((naiveBytes - metrics.context_bytes_transmitted) / naiveBytes).toFixed(3));
    return {
      scenario: scenario.name,
      mode: scenario.mode,
      before: { context_bytes_transmitted_without_references: naiveBytes, repository_turns: scenario.turns.length },
      after: {
        context_bytes_prepared: metrics.context_bytes_prepared,
        context_bytes_transmitted: metrics.context_bytes_transmitted,
        repeated_bytes_avoided: metrics.repeated_bytes_avoided,
        local_cache_hits: metrics.cache_hits,
        local_cache_misses: metrics.cache_misses,
        files_considered: metrics.files_considered,
        regions_read: metrics.regions_read,
        known_content_references: Object.keys(knownContent).length,
        benchmark_wall_ms: elapsed,
      },
      transmitted_byte_reduction: reduction,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const scenario of scenarios) results.push(await measure(scenario));
const repeated = results.filter((item) => item.scenario !== "small-one-file");
if (repeated.some((item) => item.transmitted_byte_reduction < 0.25)) {
  throw new Error(`Production Web context benchmark failed transmitted-byte reduction guardrail: ${JSON.stringify(repeated)}`);
}
if (repeated.some((item) => item.after.repeated_bytes_avoided <= 0 || item.after.local_cache_hits <= 0)) {
  throw new Error(`Production Web context benchmark did not exercise both digest references and local cache hits: ${JSON.stringify(repeated)}`);
}
if (results.some((item) => item.after.context_bytes_prepared !== item.before.context_bytes_transmitted_without_references)) {
  throw new Error("Production Web context benchmark changed the exact prepared evidence surface while optimizing transport.");
}
console.log(JSON.stringify({
  benchmark_version: "2.0",
  kind: "production-exact-repository-context-delta",
  caveat: "Measures production exact-read/cache/reference transfer behavior only; provider token counts, model quality, and network latency require separate provider evaluation.",
  results,
}, null, 2));
