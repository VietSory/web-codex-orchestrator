import { BoundedResourcePool } from "./resource-pool.js";

export type DoctorSeverity = "OK" | "WARN" | "FAIL";
export interface DoctorCheckResult { id: string; severity: DoctorSeverity; summary: string; duration_ms: number; details?: Record<string, unknown>; }
export interface DoctorProbe { id: string; run(): Promise<Omit<DoctorCheckResult, "id" | "duration_ms">>; }
export interface DoctorReport { status: DoctorSeverity; checks: DoctorCheckResult[]; generated_at: string; }

function worst(left: DoctorSeverity, right: DoctorSeverity): DoctorSeverity {
  const rank: Record<DoctorSeverity, number> = { OK: 0, WARN: 1, FAIL: 2 };
  return rank[right] > rank[left] ? right : left;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`probe exceeded ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function runDoctor(probes: DoctorProbe[], options: { maximum_concurrency?: number; probe_timeout_ms?: number; now?: () => Date } = {}): Promise<DoctorReport> {
  const maximum = options.maximum_concurrency ?? 4;
  const timeout = options.probe_timeout_ms ?? 2_000;
  const pool = new BoundedResourcePool(maximum, Math.max(0, probes.length));
  const checks = await Promise.all(probes.map((probe) => pool.run(async () => {
    const started = Date.now();
    try {
      const result = await withDeadline(probe.run(), timeout);
      return { id: probe.id, ...result, duration_ms: Math.max(0, Date.now() - started) } satisfies DoctorCheckResult;
    } catch (error) {
      return { id: probe.id, severity: "FAIL", summary: error instanceof Error ? error.message : String(error), duration_ms: Math.max(0, Date.now() - started) } satisfies DoctorCheckResult;
    }
  })));
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return { status: checks.reduce<DoctorSeverity>((status, check) => worst(status, check.severity), "OK"), checks, generated_at: (options.now ? options.now() : new Date()).toISOString() };
}
