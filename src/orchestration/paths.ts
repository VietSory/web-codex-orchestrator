import path from "node:path";
import { OrchestrationError } from "./contracts.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function validate(taskId: string, taskBundleSha256: string): void {
  if (!SAFE_ID.test(taskId) || !SHA256.test(taskBundleSha256)) throw new OrchestrationError("ORCHESTRATION_RUN_ID_INVALID", "Task/run identity is unsafe for orchestration state paths.");
}

export function orchestrationPaths(stateDirectory: string, taskId: string, taskBundleSha256: string) {
  validate(taskId, taskBundleSha256);
  const root = path.resolve(stateDirectory);
  const directory = path.join(root, "orchestration", "runs", taskId, taskBundleSha256);
  return {
    root,
    directory,
    ledger: path.join(directory, "run-ledger.json"),
    lock: path.join(directory, "orchestrator.lock"),
    execution_lock: path.join(directory, "transition-execution.lock"),
  };
}
