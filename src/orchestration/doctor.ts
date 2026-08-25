import { BoundedResourcePool } from "./resource-pool.js";

export type DoctorSeverity = "OK" | "WARN" | "FAIL";
export interface DoctorCheckResult { id: string; severity: DoctorSeverity; summary: string; duration_ms: number; details?: Record<string, unknown>; }
/** A probe must honor the supplied signal so a Doctor deadline cancels the
 * underlying work rather than merely abandoning its Promise. A production
 * probe may request a larger minimum timeout when its external dependency has a
 * documented bounded readiness budget. */
export interface DoctorProbe { id: string; timeout_ms?: number; run(signal?: AbortSignal): Promise<Omit<DoctorCheckResult, "id" | "duration_ms">>; }
export interface DoctorReport { status: DoctorSeverity; checks: DoctorCheckResult[]; generated_at: string; }

// The installed ChatGPT Web launcher may need to hydrate a real Temporary Chat
// and inspect account/model controls before it can prove readiness. Its 3.0.3
// launcher contract budgets up to 120s for capability inspection. Production's
// chatgpt-web probe therefore requests this scoped minimum; the generic Doctor
// runner itself remains caller-configurable so focused tests and other callers
// can use short cancellation deadlines without being silently widened by an ID.
export const CHATGPT_WEB_DOCTOR_PROBE_TIMEOUT_MS = 130_000;

export function doctorProbeTimeoutMs(probeId: string, configuredTimeoutMs: number): number {
  return probeId === "chatgpt-web"
    ? Math.max(configuredTimeoutMs, CHATGPT_WEB_DOCTOR_PROBE_TIMEOUT_MS)
    : configuredTimeoutMs;
}

function worst(left: DoctorSeverity, right: DoctorSeverity): DoctorSeverity {
  const rank: Record<DoctorSeverity, number> = { OK: 0, WARN: 1, FAIL: 2 };
  return rank[right] > rank[left] ? right : left;
}

// These checks describe capabilities required by whichever Web profile is
// actually selected. A selected transport that is offline, unlinked, or not
// operator-ready is not a cosmetic warning: WCO cannot safely deliver the
// semantic author/review turn. Profile-specific probes already return OK when a
// capability is intentionally not required (manual/native/personal modes), so
// promoting only their WARN result is fail-closed without making optional
// profiles globally mandatory.
const REQUIRED_WEB_READINESS_CHECKS = new Set([
  "wco-relay-service",
  "wco-device-account",
  "chatgpt-web",
  "senior-architect-gpt",
]);

function normalizeReadiness(id: string, result: Omit<DoctorCheckResult, "id" | "duration_ms">): Omit<DoctorCheckResult, "id" | "duration_ms"> {
  if (result.severity === "WARN" && REQUIRED_WEB_READINESS_CHECKS.has(id)) return { ...result, severity: "FAIL" };
  return result;
}

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`probe exceeded ${timeoutMs}ms`));
          reject(new Error(`probe exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function runDoctor(probes: DoctorProbe[], options: { maximum_concurrency?: number; probe_timeout_ms?: number; now?: () => Date } = {}): Promise<DoctorReport> {
  const maximum = options.maximum_concurrency ?? 4;
  const timeout = options.probe_timeout_ms ?? 2_000;
  const pool = new BoundedResourcePool(maximum, Math.max(0, probes.length));
  const checks = await Promise.all(probes.map((probe) => pool.run(async () => {
    const started = Date.now();
    const probeTimeout = probe.timeout_ms === undefined ? timeout : Math.max(timeout, probe.timeout_ms);
    try {
      const result = normalizeReadiness(probe.id, await withDeadline((signal) => probe.run(signal), probeTimeout));
      return { id: probe.id, ...result, duration_ms: Math.max(0, Date.now() - started) } satisfies DoctorCheckResult;
    } catch (error) {
      return { id: probe.id, severity: "FAIL", summary: error instanceof Error ? error.message : String(error), duration_ms: Math.max(0, Date.now() - started) } satisfies DoctorCheckResult;
    }
  })));
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return { status: checks.reduce<DoctorSeverity>((status, check) => worst(status, check.severity), "OK"), checks, generated_at: (options.now ? options.now() : new Date()).toISOString() };
}
