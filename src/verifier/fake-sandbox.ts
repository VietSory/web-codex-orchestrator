import type { CommandRunOptions, SandboxRunResult, VerificationSandbox } from "./contracts.js";

export class FakeVerificationSandbox implements VerificationSandbox {
  readonly calls: Array<{ executable: string; args: string[]; options: CommandRunOptions }> = [];
  constructor(private readonly responses: Array<Partial<SandboxRunResult>> = []) {}
  async run(executable: string, args: readonly string[], options: CommandRunOptions): Promise<SandboxRunResult> {
    this.calls.push({ executable, args: [...args], options });
    const response = this.responses[Math.min(this.calls.length - 1, Math.max(0, this.responses.length - 1))] ?? {};
    return { exitCode: 0, signal: null, stdout: "", stderr: "", stdout_bytes: 0, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false, timed_out: false, duration_ms: 0, ...response };
  }
}
