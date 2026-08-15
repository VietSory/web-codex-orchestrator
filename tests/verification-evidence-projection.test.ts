import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readExactVerificationCommands } from "../src/orchestration/verification-evidence.js";

test("Result packaging projects exact immutable Harness command evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wco-verification-evidence-"));
  await fs.mkdir(path.join(root, "evidence"));
  const changeSetSha256 = "a".repeat(64);
  const evidence = {
    kind: "harness-deterministic-verification",
    change_set_digest: changeSetSha256,
    required_commands_passed: true,
    commands: [{
      command_id: "VERIFY-1", required: true, status: "PASS", exit_code: 0, timed_out: false,
      duration_ms: 42, stdout_truncated: false, stderr_truncated: false,
      stdout_tail: "2 tests passed", stderr_tail: "",
    }],
  };
  const bytes = Buffer.from(JSON.stringify(evidence), "utf8");
  const evidenceSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path.join(root, "evidence", `verification-1-${evidenceSha256}.json`), bytes);

  const commands = await readExactVerificationCommands({ executorDirectory: root, round: 1, evidenceSha256, changeSetSha256, requiredCommandsPassed: true });
  assert.deepEqual(commands, evidence.commands);
  await assert.rejects(
    readExactVerificationCommands({ executorDirectory: root, round: 1, evidenceSha256, changeSetSha256: "b".repeat(64), requiredCommandsPassed: true }),
    (error: any) => error?.code === "ORCHESTRATION_RESULT_AUTHORITY_DRIFT",
  );
});
