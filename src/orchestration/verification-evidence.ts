import crypto from "node:crypto";
import path from "node:path";
import { readStableExecutorStateFile } from "../executor/state-io.js";
import type { ExecutorVerificationCommandEvidence } from "../executor/contracts.js";
import { OrchestrationError } from "./contracts.js";

const MAX_EXECUTOR_EVIDENCE_BYTES = 512 * 1024;

function invalid(message: string): never {
  throw new OrchestrationError("ORCHESTRATION_RESULT_AUTHORITY_DRIFT", message);
}

export async function readExactVerificationCommands(options: {
  executorDirectory: string;
  round: number;
  evidenceSha256: string | null;
  changeSetSha256: string;
  requiredCommandsPassed: boolean;
}): Promise<ExecutorVerificationCommandEvidence[]> {
  if (!Number.isSafeInteger(options.round) || options.round < 1 || !options.evidenceSha256) {
    invalid("Executor verification approval is missing its immutable evidence identity.");
  }
  const evidencePath = path.join(options.executorDirectory, "evidence", `verification-${options.round}-${options.evidenceSha256}.json`);
  const bytes = await readStableExecutorStateFile(evidencePath, MAX_EXECUTOR_EVIDENCE_BYTES);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== options.evidenceSha256) {
    invalid("Executor verification evidence changed after executor attestation.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { invalid("Executor verification evidence is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("Executor verification evidence must be an object.");
  const evidence = parsed as Record<string, unknown>;
  if (
    evidence.kind !== "harness-deterministic-verification" ||
    evidence.change_set_digest !== options.changeSetSha256 ||
    evidence.required_commands_passed !== options.requiredCommandsPassed ||
    !Array.isArray(evidence.commands) || evidence.commands.length > 512
  ) invalid("Executor verification evidence is not bound to the exact READY verification checkpoint.");

  return evidence.commands.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`Executor verification command ${index + 1} is invalid.`);
    const command = value as Record<string, unknown>;
    if (
      typeof command.command_id !== "string" || command.command_id.length < 1 || command.command_id.length > 128 ||
      typeof command.required !== "boolean" || !["PASS", "FAIL", "TIMEOUT", "DENIED", "MUTATED"].includes(String(command.status)) ||
      !(command.exit_code === null || Number.isSafeInteger(command.exit_code)) ||
      typeof command.timed_out !== "boolean" || !Number.isSafeInteger(command.duration_ms) || (command.duration_ms as number) < 0 ||
      typeof command.stdout_truncated !== "boolean" || typeof command.stderr_truncated !== "boolean" ||
      typeof command.stdout_tail !== "string" || typeof command.stderr_tail !== "string"
    ) invalid(`Executor verification command ${index + 1} has an invalid bounded evidence shape.`);
    return {
      command_id: command.command_id,
      required: command.required,
      status: command.status as ExecutorVerificationCommandEvidence["status"],
      exit_code: command.exit_code as number | null,
      timed_out: command.timed_out,
      duration_ms: command.duration_ms as number,
      stdout_truncated: command.stdout_truncated,
      stderr_truncated: command.stderr_truncated,
      stdout_tail: command.stdout_tail,
      stderr_tail: command.stderr_tail,
    };
  });
}
