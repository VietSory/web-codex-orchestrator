import type { ChangeSet } from "../execution/contracts.js";
import { ExecutionError } from "../execution/errors.js";
import { matches } from "../execution/change-set.js";

export function assertVerifierDidNotMutateSource(before: ChangeSet, after: ChangeSet, allowedGeneratedPaths: readonly string[] = []): void {
  const beforeSource = before.entries.filter((entry) => !allowedGeneratedPaths.some((pattern) => matches(pattern, entry.path)));
  const afterSource = after.entries.filter((entry) => !allowedGeneratedPaths.some((pattern) => matches(pattern, entry.path)));
  if (JSON.stringify(beforeSource) !== JSON.stringify(afterSource)) throw new ExecutionError("VERIFIER_MUTATED_SOURCE", "Verifier changed tracked source or an unapproved path.");
}
