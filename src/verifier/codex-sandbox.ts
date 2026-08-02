import { ExecutionError } from "../execution/errors.js";
import type { CommandRunOptions, SandboxRunResult, VerificationSandbox } from "./contracts.js";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";

/** Production must be wired to a supported Codex sandbox. Host execution is
 * never used as an implicit fallback. */
export class CodexVerificationSandbox implements VerificationSandbox {
  constructor(private readonly implementation?: VerificationSandbox) {}
  async checkAvailability(): Promise<void> {
    if (!this.implementation) throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "A supported verification sandbox is unavailable.");
    if (!this.implementation.checkAvailability) throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "The verification sandbox did not expose an enforceability preflight.");
    await this.implementation.checkAvailability();
  }
  async run(executable: string, args: readonly string[], options: CommandRunOptions): Promise<SandboxRunResult> {
    if (!this.implementation) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "A supported verification sandbox is unavailable.");
    if (!this.implementation.checkAvailability) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "The verification sandbox did not expose an enforceability preflight.");
    if (options.network_access !== false || !options.writable_root || !Array.isArray(options.credential_directories) || options.credential_directories.length !== 0) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Verification sandbox options are not restrictive enough.");
    const root = path.resolve(options.writable_root);
    const cwd = path.resolve(options.cwd);
    if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Verification cwd is outside the sandbox root.");
    const [rootInfo, cwdInfo, canonicalRoot, canonicalCwd] = await Promise.all([lstat(root).catch(() => undefined), lstat(cwd).catch(() => undefined), realpath(root).catch(() => ""), realpath(cwd).catch(() => "")]);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || !cwdInfo?.isDirectory() || cwdInfo.isSymbolicLink() || !canonicalRoot || !canonicalCwd || (canonicalCwd !== canonicalRoot && !canonicalCwd.startsWith(`${canonicalRoot}${path.sep}`))) throw new ExecutionError("VERIFIER_SANDBOX_UNAVAILABLE", "Verification root or cwd is not a canonical directory.");
    return this.implementation.run(executable, args, options);
  }
}
