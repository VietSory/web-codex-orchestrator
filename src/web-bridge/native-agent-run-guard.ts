import { WebBridgeError } from "./contracts.js";
import type { NativeOpenAiCredential } from "./native-openai-credential.js";
import { readWorkspaceAgentRun, type WorkspaceAgentRunStatus } from "./workspace-agent-client.js";

export class NativeAgentRunGuard {
  constructor(
    private readonly credential: NativeOpenAiCredential,
    readonly run_id: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async status(): Promise<WorkspaceAgentRunStatus> {
    return await readWorkspaceAgentRun({ credential: this.credential, runId: this.run_id, fetchImpl: this.fetchImpl });
  }

  /**
   * Fail closed if the official Workspace Agent can no longer deliver the
   * semantic envelope WCO is waiting for. A suspended write confirmation is a
   * one-time ChatGPT Agent/App configuration issue, not permission for WCO to
   * silently fall back to an external relay or browser automation.
   */
  async assertCanStillComplete(): Promise<"running" | "completed"> {
    const value = await this.status();
    if (value.status === "queued" || value.status === "in_progress") return "running";
    if (value.status === "completed") return "completed";
    if (value.status === "suspended") {
      throw new WebBridgeError(
        "WEB_NATIVE_INTERACTION_REQUIRED",
        "The official Workspace Agent run is suspended waiting for ChatGPT interaction. In the one-time WCO Agent/App setup, allow WCO's non-destructive semantic submit tools without per-run confirmation when your workspace policy permits it, then retry. WCO did not enable a third-party relay or mutate the repository.",
      );
    }
    throw new WebBridgeError(
      "WEB_NATIVE_AGENT_FAILED",
      `The official Workspace Agent run failed${value.error?.code ? ` (${value.error.code})` : ""}${value.error?.message ? `: ${value.error.message}` : "."}`,
    );
  }
}
