// Public evidence DTO projection for Phase 6
// Converts internal receipts to sanitized public DTOs.
// Never includes: absolute paths, thread IDs, prompts, tokens, auth data, raw env values.
import type { PublicExecutionEvidence, PublicGitPublishEvidence, PublicDraftPrEvidence } from "./contracts.js";

/** Project execution receipt to public evidence DTO */
export function projectExecutionEvidence(receipt: Record<string, unknown>): PublicExecutionEvidence {
  const runId = String(receipt.run_id ?? "");
  const sep = runId.lastIndexOf(":");
  const taskId = sep > 0 ? runId.slice(0, sep) : "";

  const implementer = receipt.implementer as Record<string, unknown> | undefined ?? {};
  const internalReviewer = receipt.internal_reviewer as Record<string, unknown> | undefined ?? {};
  const finalReviewer = receipt.final_reviewer as Record<string, unknown> | undefined ?? {};
  const verification = receipt.verification as Record<string, unknown> | undefined ?? {};
  const usage = receipt.usage as Record<string, unknown> | undefined ?? {};

  return {
    run_id: runId,
    task_id: taskId,
    state: String(receipt.state ?? ""),
    change_set_sha256: String(receipt.change_set_sha256 ?? ""),
    base_commit: String(receipt.base_commit ?? ""),
    branch_name: String(receipt.branch_name ?? ""),
    implementer: {
      model: String(implementer.model ?? ""),
      reasoning_effort: String(implementer.reasoning_effort ?? ""),
      iterations: Number(implementer.iterations ?? 0),
    },
    internal_reviewer: {
      model: String(internalReviewer.model ?? ""),
      reasoning_effort: String(internalReviewer.reasoning_effort ?? ""),
      rounds: Number(internalReviewer.rounds ?? 0),
      verdict: internalReviewer.verdict != null ? String(internalReviewer.verdict) : null,
      reviewed_change_set_sha256: internalReviewer.reviewed_change_set_sha256 != null
        ? String(internalReviewer.reviewed_change_set_sha256) : null,
    },
    final_reviewer: {
      model: String(finalReviewer.model ?? ""),
      reasoning_effort: String(finalReviewer.reasoning_effort ?? ""),
      rounds: Number(finalReviewer.rounds ?? 0),
      verdict: finalReviewer.verdict != null ? String(finalReviewer.verdict) : null,
      reviewed_change_set_sha256: finalReviewer.reviewed_change_set_sha256 != null
        ? String(finalReviewer.reviewed_change_set_sha256) : null,
    },
    verification: {
      rounds: Number(verification.rounds ?? 0),
      required_commands_passed: Boolean(verification.required_commands_passed),
      verified_change_set_sha256: verification.verified_change_set_sha256 != null
        ? String(verification.verified_change_set_sha256) : null,
    },
    usage: {
      input_tokens: Number(usage.input_tokens ?? 0),
      cached_input_tokens: Number(usage.cached_input_tokens ?? 0),
      output_tokens: Number(usage.output_tokens ?? 0),
    },
    created_at: String(receipt.created_at ?? ""),
    updated_at: String(receipt.updated_at ?? ""),
  };
}

/** Project git publish receipt to public evidence DTO */
export function projectGitPublishEvidence(receipt: Record<string, unknown>): PublicGitPublishEvidence {
  const expectedPaths = Array.isArray(receipt.expected_paths)
    ? (receipt.expected_paths as unknown[]).map(String)
    : [];

  return {
    run_id: String(receipt.run_id ?? ""),
    state: String(receipt.state ?? ""),
    base_commit: String(receipt.base_commit ?? ""),
    branch_name: String(receipt.branch_name ?? ""),
    remote_name: String(receipt.remote_name ?? ""),
    change_set_sha256: String(receipt.change_set_sha256 ?? ""),
    expected_paths: expectedPaths,
    commit_sha: String(receipt.commit_sha ?? ""),
    remote_branch_sha: String(receipt.remote_branch_sha ?? ""),
    created_at: String(receipt.created_at ?? ""),
    pushed_at: receipt.pushed_at != null ? String(receipt.pushed_at) : null,
  };
}

/** Project draft PR receipt to public evidence DTO */
export function projectDraftPrEvidence(
  receipt: Record<string, unknown>,
  gitPublishReceiptSha256: string,
  changeSetSha256: string
): PublicDraftPrEvidence {
  const prNumber = Number(receipt.pull_number ?? 0);
  const prUrl = String(receipt.pull_url ?? "");

  return {
    run_id: String(receipt.run_id ?? ""),
    state: String(receipt.state ?? ""),
    pull_request_number: prNumber,
    pull_request_url: prUrl,
    change_set_sha256: changeSetSha256,
    git_publish_receipt_sha256: gitPublishReceiptSha256,
    created_at: String(receipt.created_at ?? ""),
    opened_at: receipt.opened_at != null ? String(receipt.opened_at) : null,
  };
}

/** Bound and redact verification command output */
export function redactVerificationOutput(
  output: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  const encoded = Buffer.from(output, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return { text: output, truncated: false };
  }
  // Truncate at byte boundary
  const slice = encoded.subarray(0, maxBytes);
  return {
    text: slice.toString("utf8").replace(/\uFFFD/g, "") + "\n[output truncated]",
    truncated: true,
  };
}

/** Project verification evidence to public DTO */
export function projectVerificationEvidence(
  receipt: Record<string, unknown>,
  maxOutputBytes: number
): object {
  const commands = Array.isArray(receipt.commands)
    ? (receipt.commands as Record<string, unknown>[]).map((cmd) => {
        const rawStdout = String(cmd.stdout ?? cmd.output ?? "");
        const rawStderr = String(cmd.stderr ?? "");
        const { text: stdout, truncated: stdoutTruncated } = redactVerificationOutput(rawStdout, maxOutputBytes);
        const { text: stderr, truncated: stderrTruncated } = redactVerificationOutput(rawStderr, maxOutputBytes);
        return {
          executable: cmd.executable,
          args: cmd.args,
          exit_code: cmd.exit_code,
          status: cmd.status,
          duration_ms: cmd.duration_ms,
          stdout_bytes: Buffer.byteLength(rawStdout, "utf8"),
          stderr_bytes: Buffer.byteLength(rawStderr, "utf8"),
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated,
          stdout,
          stderr,
          generated_paths: cmd.generated_paths ?? [],
        };
      })
    : [];

  return {
    rounds: Number(receipt.rounds ?? 0),
    required_commands_passed: Boolean(receipt.required_commands_passed),
    verified_change_set_sha256: receipt.verified_change_set_sha256 ?? null,
    commands,
  };
}
