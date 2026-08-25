export const WCO_BROWSER_COMPANION_PROTOCOL_VERSION = 1 as const;
export const WCO_BROWSER_COMPANION_KIND = "wco-browser-companion" as const;

export const WCO_BROWSER_COMPANION_MODES = [
  "instant",
  "medium",
  "high",
  "extra-high",
  "pro",
  "luna",
] as const;

export type WcoBrowserCompanionMode = typeof WCO_BROWSER_COMPANION_MODES[number];

interface BaseRequest {
  protocol_version: typeof WCO_BROWSER_COMPANION_PROTOCOL_VERSION;
  id: string;
}

export interface WcoBrowserCompanionInspectRequest extends BaseRequest {
  type: "inspect";
  detect_capabilities: boolean;
}

export interface WcoBrowserCompanionRunRequest extends BaseRequest {
  type: "run";
  mode: WcoBrowserCompanionMode;
  prompt: string;
}

export interface WcoBrowserCompanionAbortRequest extends BaseRequest {
  type: "abort";
  target_id: string;
}

export interface WcoBrowserCompanionShutdownRequest extends BaseRequest {
  type: "shutdown";
}

export type WcoBrowserCompanionRequest =
  | WcoBrowserCompanionInspectRequest
  | WcoBrowserCompanionRunRequest
  | WcoBrowserCompanionAbortRequest
  | WcoBrowserCompanionShutdownRequest;

export interface WcoBrowserCompanionReadyMessage {
  type: "ready";
  protocol_version: typeof WCO_BROWSER_COMPANION_PROTOCOL_VERSION;
  kind: typeof WCO_BROWSER_COMPANION_KIND;
  pid: number;
}

export interface WcoBrowserCompanionEventMessage {
  type: "event";
  id: string;
  event: string;
  detail?: string;
}

export interface WcoBrowserCompanionResultMessage {
  type: "result";
  id: string;
  text?: string;
  value?: unknown;
}

export interface WcoBrowserCompanionErrorMessage {
  type: "error";
  id: string;
  code: string;
  message: string;
}

export type WcoBrowserCompanionMessage =
  | WcoBrowserCompanionReadyMessage
  | WcoBrowserCompanionEventMessage
  | WcoBrowserCompanionResultMessage
  | WcoBrowserCompanionErrorMessage;

const MAX_ID_BYTES = 256;
const MAX_PROMPT_BYTES = 512 * 1024;

function protocolError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "WCO_BROWSER_COMPANION_PROTOCOL_INVALID" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw protocolError(`Browser companion request contains unsupported field(s): ${unexpected.join(", ")}.`);
  }
}

function requiredId(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES || value.includes("\u0000")) {
    throw protocolError(`Browser companion request ${label} is missing or invalid.`);
  }
  return value;
}

function requestBase(value: Record<string, unknown>): { id: string } {
  if (value.protocol_version !== WCO_BROWSER_COMPANION_PROTOCOL_VERSION) {
    throw protocolError(`Unsupported browser companion protocol version '${String(value.protocol_version)}'.`);
  }
  return { id: requiredId(value.id) };
}

function requestMode(value: unknown): WcoBrowserCompanionMode {
  if (typeof value !== "string" || !(WCO_BROWSER_COMPANION_MODES as readonly string[]).includes(value)) {
    throw protocolError(`Unsupported browser companion mode '${String(value)}'.`);
  }
  return value as WcoBrowserCompanionMode;
}

/**
 * Parse the only authority crossing from WSL into the native Windows browser companion.
 *
 * The allowlists are intentionally exact. Repository/workspace/bundle paths, tool commands,
 * environment maps, cookies, tokens, and arbitrary browser/CDP parameters are not part of this
 * protocol. WCO builds all bounded repository context in WSL and sends only prepared prompt text.
 */
export function parseWcoBrowserCompanionRequest(value: unknown): WcoBrowserCompanionRequest {
  if (!isRecord(value)) throw protocolError("Browser companion request must be a JSON object.");
  const type = value.type;

  if (type === "inspect") {
    exactKeys(value, ["protocol_version", "type", "id", "detect_capabilities"]);
    const { id } = requestBase(value);
    if (typeof value.detect_capabilities !== "boolean") {
      throw protocolError("Browser companion inspect detect_capabilities must be a boolean.");
    }
    return {
      protocol_version: WCO_BROWSER_COMPANION_PROTOCOL_VERSION,
      type,
      id,
      detect_capabilities: value.detect_capabilities,
    };
  }

  if (type === "run") {
    exactKeys(value, ["protocol_version", "type", "id", "mode", "prompt"]);
    const { id } = requestBase(value);
    if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.includes("\u0000")) {
      throw protocolError("Browser companion run prompt is missing or invalid.");
    }
    if (Buffer.byteLength(value.prompt, "utf8") > MAX_PROMPT_BYTES) {
      throw protocolError(`Browser companion run prompt exceeds ${MAX_PROMPT_BYTES} bytes.`);
    }
    return {
      protocol_version: WCO_BROWSER_COMPANION_PROTOCOL_VERSION,
      type,
      id,
      mode: requestMode(value.mode),
      prompt: value.prompt,
    };
  }

  if (type === "abort") {
    exactKeys(value, ["protocol_version", "type", "id", "target_id"]);
    const { id } = requestBase(value);
    return {
      protocol_version: WCO_BROWSER_COMPANION_PROTOCOL_VERSION,
      type,
      id,
      target_id: requiredId(value.target_id, "target_id"),
    };
  }

  if (type === "shutdown") {
    exactKeys(value, ["protocol_version", "type", "id"]);
    const { id } = requestBase(value);
    return {
      protocol_version: WCO_BROWSER_COMPANION_PROTOCOL_VERSION,
      type,
      id,
    };
  }

  throw protocolError(`Unsupported browser companion request type '${String(type)}'.`);
}
