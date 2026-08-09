export type ContextBenchmarkArm = "baseline" | "smart";

export interface ContextBenchmarkUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export interface ContextBenchmarkSample {
  arm: ContextBenchmarkArm;
  sequence: number;
  elapsed_ms: number;
  verdict: string;
  reviewed_change_set_sha256: string;
  exact_digest_approved: boolean;
  usage: ContextBenchmarkUsage;
}

export interface ContextBenchmarkArmSummary {
  samples: number;
  exact_digest_approvals: number;
  exact_digest_approval_rate: number;
  input_tokens: { mean: number; median: number };
  cached_input_tokens: { mean: number; median: number };
  output_tokens: { mean: number; median: number };
  elapsed_ms: { mean: number; median: number };
}

export interface ContextBenchmarkReport {
  schema_version: "1.0";
  kind: "native-context-ab";
  repetitions: number;
  expected_change_set_sha256: string;
  order: ContextBenchmarkArm[];
  samples: ContextBenchmarkSample[];
  baseline: ContextBenchmarkArmSummary;
  smart: ContextBenchmarkArmSummary;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number.`);
  return value;
}

function safeToken(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

export function benchmarkOrder(repetitions: number): ContextBenchmarkArm[] {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("Benchmark repetitions must be 1..5.");
  const order: ContextBenchmarkArm[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    order.push(...(index % 2 === 0 ? ["baseline", "smart"] as const : ["smart", "baseline"] as const));
  }
  return order;
}

export function sameOrderedPaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle]!;
  return (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function metric(values: number[]): { mean: number; median: number } {
  if (values.length === 0) throw new Error("Benchmark arm has no samples.");
  return { mean: rounded(mean(values)), median: rounded(median(values)) };
}

export function summarizeContextBenchmarkArm(samples: ContextBenchmarkSample[]): ContextBenchmarkArmSummary {
  if (samples.length === 0) throw new Error("Benchmark arm has no samples.");
  const approvals = samples.filter((sample) => sample.exact_digest_approved).length;
  return {
    samples: samples.length,
    exact_digest_approvals: approvals,
    exact_digest_approval_rate: rounded(approvals / samples.length),
    input_tokens: metric(samples.map((sample) => sample.usage.input_tokens)),
    cached_input_tokens: metric(samples.map((sample) => sample.usage.cached_input_tokens)),
    output_tokens: metric(samples.map((sample) => sample.usage.output_tokens)),
    elapsed_ms: metric(samples.map((sample) => sample.elapsed_ms)),
  };
}

export async function runContextAbBenchmark(options: {
  repetitions: number;
  expectedChangeSetSha256: string;
  sampleTimeoutMs?: number;
  beforeSample?: (arm: ContextBenchmarkArm, sequence: number) => Promise<void>;
  runSample: (arm: ContextBenchmarkArm, sequence: number, signal: AbortSignal) => Promise<{
    elapsed_ms: number;
    verdict: string;
    reviewed_change_set_sha256: string;
    usage: ContextBenchmarkUsage;
  }>;
}): Promise<ContextBenchmarkReport> {
  if (!/^[a-f0-9]{64}$/.test(options.expectedChangeSetSha256)) throw new Error("Benchmark expected change-set SHA-256 is invalid.");
  if (options.sampleTimeoutMs !== undefined && (!Number.isSafeInteger(options.sampleTimeoutMs) || options.sampleTimeoutMs < 1)) {
    throw new Error("Benchmark sample timeout must be a positive safe integer in milliseconds.");
  }
  const order = benchmarkOrder(options.repetitions);
  const samples: ContextBenchmarkSample[] = [];
  for (let index = 0; index < order.length; index += 1) {
    const arm = order[index]!;
    const sequence = index + 1;
    await options.beforeSample?.(arm, sequence);
    const signal = options.sampleTimeoutMs === undefined
      ? new AbortController().signal
      : AbortSignal.timeout(options.sampleTimeoutMs);
    const result = await options.runSample(arm, sequence, signal);
    const usage = {
      input_tokens: safeToken(result.usage.input_tokens, "input_tokens"),
      cached_input_tokens: safeToken(result.usage.cached_input_tokens, "cached_input_tokens"),
      output_tokens: safeToken(result.usage.output_tokens, "output_tokens"),
    };
    const elapsed_ms = finiteNonNegative(result.elapsed_ms, "elapsed_ms");
    samples.push({
      arm,
      sequence,
      elapsed_ms,
      verdict: result.verdict,
      reviewed_change_set_sha256: result.reviewed_change_set_sha256,
      exact_digest_approved: result.verdict === "APPROVE" && result.reviewed_change_set_sha256 === options.expectedChangeSetSha256,
      usage,
    });
  }
  const baselineSamples = samples.filter((sample) => sample.arm === "baseline");
  const smartSamples = samples.filter((sample) => sample.arm === "smart");
  return {
    schema_version: "1.0",
    kind: "native-context-ab",
    repetitions: options.repetitions,
    expected_change_set_sha256: options.expectedChangeSetSha256,
    order,
    samples,
    baseline: summarizeContextBenchmarkArm(baselineSamples),
    smart: summarizeContextBenchmarkArm(smartSamples),
  };
}
