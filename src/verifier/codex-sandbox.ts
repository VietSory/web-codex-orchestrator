import { ExecutionError } from "../execution/errors.js";
import type { CommandRunOptions, SandboxRunResult, VerificationSandbox } from "./contracts.js";

/** Production must be wired to a supported Codex sandbox. Host execution is
 * never used as an implicit fallback. */
export class CodexVerificationSandbox implements VerificationSandbox {
  constructor(private readonly implementation?: VerificationSandbox) {}
  async run(executable: string, args: readonly string[], options: CommandRunOptions): Promise<SandboxRunResult> {
    if (!this.implementation) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "A supported verification sandbox is unavailable.");
    return this.implementation.run(executable, args, options);
  }
}
