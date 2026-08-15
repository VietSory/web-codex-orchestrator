export type JobMode = "PAIR" | "AUTOPILOT";

export const DEFAULT_JOB_MODE: JobMode = "PAIR";

export function parseJobMode(value: string | undefined | null): JobMode {
  if (!value) return DEFAULT_JOB_MODE;
  const normalized = value.trim().toUpperCase();
  if (normalized === "PAIR" || normalized === "AUTOPILOT") return normalized;
  throw new Error(`JOB_MODE_INVALID: unsupported job mode '${value}'.`);
}

export function isAutopilotMode(value: JobMode): boolean {
  return value === "AUTOPILOT";
}
