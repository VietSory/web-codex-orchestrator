import type { StabilityObservation } from "./contracts.js";

export class StabilityTracker {
  constructor(private readonly observations = new Map<string, StabilityObservation>()) {}

  get map(): Map<string, StabilityObservation> { return this.observations; }

  observe(canonicalPath: string, size: number, mtimeMs: number, nowMs: number): StabilityObservation {
    const previous = this.observations.get(canonicalPath);
    const current: StabilityObservation = previous && previous.size === size && previous.mtime_ms === mtimeMs
      ? { ...previous, observed_at_ms: nowMs, observations: previous.observations + 1 }
      : { canonical_path: canonicalPath, size, mtime_ms: mtimeMs, observed_at_ms: nowMs, observations: 1 };
    this.observations.set(canonicalPath, current);
    return current;
  }

  forget(canonicalPath: string): void { this.observations.delete(canonicalPath); }
}
