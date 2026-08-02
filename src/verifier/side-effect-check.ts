import type { ChangeSet } from "../execution/contracts.js";
import { ExecutionError } from "../execution/errors.js";
import { matches } from "../execution/change-set.js";

export function assertVerifierDidNotMutateSource(before: ChangeSet, after: ChangeSet, allowedGeneratedPaths: readonly string[] = []): string[] {
  if (before.refs_sha256 !== undefined && after.refs_sha256 !== undefined && before.refs_sha256 !== after.refs_sha256) throw new ExecutionError("VERIFIER_MUTATED_SOURCE", "Verifier changed Git refs or repository metadata.");
  const beforeSource = before.entries.filter((entry) => !allowedGeneratedPaths.some((pattern) => matches(pattern, entry.path)));
  const afterSource = after.entries.filter((entry) => !allowedGeneratedPaths.some((pattern) => matches(pattern, entry.path)));
  if (JSON.stringify(beforeSource) !== JSON.stringify(afterSource)) throw new ExecutionError("VERIFIER_MUTATED_SOURCE", "Verifier changed tracked source or an unapproved path.");
  const generated = after.entries.filter((entry) => allowedGeneratedPaths.some((pattern) => matches(pattern, entry.path)));
  for (const entry of generated) {
    if (entry.mode === "120000") throw new ExecutionError("VERIFIER_MUTATED_SOURCE", `Verifier created a generated symbolic link: ${entry.path}`);
    if (entry.special) throw new ExecutionError("VERIFIER_MUTATED_SOURCE", `Verifier created an unsafe generated object: ${entry.path}`);
  }
  return generated.map((entry) => entry.path).sort();
}
