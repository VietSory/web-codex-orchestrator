import { contentDigest, WebBridgeError } from "./contracts.js";
import type { NativeOpenAiCredential } from "./native-openai-credential.js";

const API = "https://api.chatgpt.com/v1/workspace_agents";

export interface WorkspaceAgentTriggerReceipt {
  accepted: true;
  /**
   * Local deterministic receipt identity. OpenAI's current Workspace Agent
   * trigger API intentionally returns 202 with no response body and no run id.
   */
  agent_trigger_run_id: string;
  /** ChatGPT does not currently return a conversation URL from the trigger API. */
  conversation_url: string;
  request_sha256: string;
}

async function providerError(response: Response, operation: string): Promise<never> {
  const text = (await response.text()).slice(0, 4096);
  if ([401, 403, 404, 409].includes(response.status)) {
    throw new WebBridgeError(
      "OPENAI_CAPABILITY_BLOCKED",
      `${operation} is unavailable for this OpenAI workspace (${response.status}). Verify Workspace Agents/full MCP permissions in ChatGPT; WCO will not substitute third-party hosting automatically.`,
    );
  }
  throw new WebBridgeError("WEB_NATIVE_PROVIDER_FAILED", `${operation} failed with HTTP ${response.status}${text ? `: ${text}` : ""}`);
}

export async function triggerWorkspaceAgent(options: {
  credential: NativeOpenAiCredential;
  input: string;
  conversationKey: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}): Promise<WorkspaceAgentTriggerReceipt> {
  if (!options.input || options.input.length > 65_536 || /\0/.test(options.input)) {
    throw new WebBridgeError("WEB_NATIVE_TRIGGER_INVALID", "Workspace Agent trigger input is invalid.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.conversationKey) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.idempotencyKey)) {
    throw new WebBridgeError("WEB_NATIVE_TRIGGER_INVALID", "Workspace Agent trigger identity is invalid.");
  }

  const body = { conversation_key: options.conversationKey, input: options.input };
  const requestSha256 = contentDigest({
    trigger_id: options.credential.workspace_agent_trigger_id,
    idempotency_key: options.idempotencyKey,
    ...body,
  });
  const response = await (options.fetchImpl ?? fetch)(`${API}/${encodeURIComponent(options.credential.workspace_agent_trigger_id)}/trigger`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.credential.workspace_agent_access_token}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "workspace_agent_runs=v1",
      "Idempotency-Key": options.idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 202) return await providerError(response, "Workspace Agent trigger");

  // Current official contract: 202 Accepted, no response body, no provider run
  // id and no API-readable agent result. The authoritative completion signal is
  // therefore the exact semantic envelope submitted through WCO's local MCP
  // tools/mailbox. Keep a deterministic local trigger receipt only for retry
  // identity and evidence; never invent provider state.
  return {
    accepted: true,
    agent_trigger_run_id: `accepted_${requestSha256.slice(0, 48)}`,
    conversation_url: "https://chatgpt.com/",
    request_sha256: requestSha256,
  };
}
