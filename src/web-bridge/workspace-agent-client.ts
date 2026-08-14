import { WebBridgeError } from "./contracts.js";
import type { NativeOpenAiCredential } from "./native-openai-credential.js";

const API = "https://api.chatgpt.com/v1/workspace_agents";
const RUN_ID = /^apirun_[A-Za-z0-9_-]{3,128}$/;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const PROVIDER_TIMEOUT_MS = 15_000;

export interface WorkspaceAgentTriggerReceipt {
  conversation_url: string;
  agent_trigger_run_id: string;
}

export interface WorkspaceAgentRunStatus {
  id: string;
  status: "queued" | "in_progress" | "suspended" | "completed" | "failed";
  conversation_url: string;
  error: { code?: string; message?: string } | null;
}

function cleanHttps(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 4096) throw new WebBridgeError("WEB_NATIVE_PROVIDER_RESPONSE_INVALID", `${label} is invalid.`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new WebBridgeError("WEB_NATIVE_PROVIDER_RESPONSE_INVALID", `${label} is unsafe.`);
  return url.href;
}

async function boundedBody(response: Response): Promise<Buffer> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROVIDER_RESPONSE_BYTES) throw new WebBridgeError("WEB_NATIVE_PROVIDER_RESPONSE_INVALID", "Workspace Agent response Content-Length is invalid or oversized.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      total += chunk.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WebBridgeError("WEB_NATIVE_PROVIDER_RESPONSE_INVALID", "Workspace Agent response exceeded its streaming byte bound.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function providerJson(response: Response): Promise<Record<string, unknown>> {
  const bytes = await boundedBody(response);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new WebBridgeError("WEB_NATIVE_PROVIDER_RESPONSE_INVALID", "Workspace Agent response is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_NATIVE_PROVIDER_RESPONSE_INVALID", "Workspace Agent response must be an object.");
  return value as Record<string, unknown>;
}

async function providerError(response: Response, operation: string): Promise<never> {
  let text = "";
  try { text = (await boundedBody(response)).toString("utf8").slice(0, 4096); } catch { /* status remains authoritative */ }
  if ([401, 403, 404, 409].includes(response.status)) {
    throw new WebBridgeError("OPENAI_CAPABILITY_BLOCKED", `${operation} is unavailable for this OpenAI workspace (${response.status}). Verify Workspace Agents/full MCP permissions in ChatGPT; WCO will not substitute third-party hosting automatically.`);
  }
  throw new WebBridgeError("WEB_NATIVE_PROVIDER_FAILED", `${operation} failed with HTTP ${response.status}${text ? `: ${text}` : ""}`);
}

async function fetchProvider(fetchImpl: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  try { return await fetchImpl(input, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }); }
  catch { throw new WebBridgeError("WEB_NATIVE_PROVIDER_FAILED", "Workspace Agent provider request failed or timed out."); }
}

export async function triggerWorkspaceAgent(options: {
  credential: NativeOpenAiCredential;
  input: string;
  conversationKey: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}): Promise<WorkspaceAgentTriggerReceipt> {
  if (!options.input || options.input.length > 65_536 || /\0/.test(options.input)) throw new WebBridgeError("WEB_NATIVE_TRIGGER_INVALID", "Workspace Agent trigger input is invalid.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.conversationKey) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.idempotencyKey)) throw new WebBridgeError("WEB_NATIVE_TRIGGER_INVALID", "Workspace Agent trigger identity is invalid.");
  const response = await fetchProvider(options.fetchImpl ?? fetch, `${API}/${encodeURIComponent(options.credential.workspace_agent_trigger_id)}/trigger`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.credential.workspace_agent_access_token}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "workspace_agent_runs=v1",
      "Idempotency-Key": options.idempotencyKey,
    },
    body: JSON.stringify({ conversation_key: options.conversationKey, input: options.input }),
  });
  if (response.status !== 202) return await providerError(response, "Workspace Agent trigger");
  const value = await providerJson(response);
  const runId = value.agent_trigger_run_id;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new WebBridgeError("WEB_NATIVE_PROVIDER_RESPONSE_INVALID", "Workspace Agent trigger did not return a valid run id.");
  return { conversation_url: cleanHttps(value.conversation_url, "conversation_url"), agent_trigger_run_id: runId };
}

export async function readWorkspaceAgentRun(options: {
  credential: NativeOpenAiCredential;
  runId: string;
  fetchImpl?: typeof fetch;
}): Promise<WorkspaceAgentRunStatus> {
  if (!RUN_ID.test(options.runId)) throw new WebBridgeError("WEB_NATIVE_TRIGGER_INVALID", "Workspace Agent run id is invalid.");
  const response = await fetchProvider(options.fetchImpl ?? fetch, `${API}/${encodeURIComponent(options.credential.workspace_agent_trigger_id)}/runs/${encodeURIComponent(options.runId)}`, {
    headers: { Authorization: `Bearer ${options.credential.workspace_agent_access_token}` },
  });
  if (!response.ok) return await providerError(response, "Workspace Agent run status");
  const value = await providerJson(response);
  const status = value.status;
  if (!RUN_ID.test(String(value.id)) || !["queued", "in_progress", "suspended", "completed", "failed"].includes(String(status))) throw new WebBridgeError("WEB_NATIVE_PROVIDER_RESPONSE_INVALID", "Workspace Agent run status payload is invalid.");
  const rawError = value.error;
  const error = rawError && typeof rawError === "object" && !Array.isArray(rawError) ? {
    ...(typeof (rawError as Record<string, unknown>).code === "string" ? { code: ((rawError as Record<string, unknown>).code as string).slice(0, 256) } : {}),
    ...(typeof (rawError as Record<string, unknown>).message === "string" ? { message: ((rawError as Record<string, unknown>).message as string).slice(0, 4096) } : {}),
  } : null;
  return { id: String(value.id), status: status as WorkspaceAgentRunStatus["status"], conversation_url: cleanHttps(value.conversation_url, "conversation_url"), error };
}
