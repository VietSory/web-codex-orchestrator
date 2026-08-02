import type { GitRunner } from "./git-runner.js";
import { GitBoundaryError, type ResolvedRepository } from "./contracts.js";

export async function validateBranchPolicy(
  branchName: string,
  allowedPrefix: string,
  deniedBranches: string[],
  repository: ResolvedRepository,
  runner: GitRunner,
): Promise<void> {
  if (!branchName.startsWith(allowedPrefix) || deniedBranches.some((denied) => branchName === denied || branchName.startsWith(`${denied}/`))) throw new GitBoundaryError("BRANCH_POLICY_VIOLATION", "Branch violates the configured branch policy.");
  const checked = await runner.run(["check-ref-format", "--branch", branchName], repository.path);
  if (checked.exitCode !== 0) throw new GitBoundaryError("BRANCH_POLICY_VIOLATION", "Branch name failed git check-ref-format.", checked);
  const exists = await runner.run(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repository.path);
  if (exists.exitCode === 0) throw new GitBoundaryError("BRANCH_ALREADY_EXISTS", "Branch already exists.", exists);
}
