export const WCO_CHATGPT_WEB_COMPANION_PROTOCOL = "wco-chatgpt-web-companion/v1";
export const WCO_CHATGPT_WEB_COMPANION_TRANSPORT = "miuuyy-browser-worker";
export const PINNED_MIUUYY_CHATGPT_WEB_SHA = "2569603f950de3a123e31bd26e7c8757566066f3";

export type ChatGptWebCompanionMode =
  | "instant"
  | "medium"
  | "high"
  | "extra-high"
  | "pro"
  | "luna";

export type ChatGptWebCompanionRole =
  | "implementer"
  | "internal_reviewer"
  | "final_reviewer";

export interface ChatGptWebCompanionProbeRequest {
  protocol: typeof WCO_CHATGPT_WEB_COMPANION_PROTOCOL;
  id: string;
  type: "probe";
  upstream_root: string;
  upstream_home?: string;
}

export interface ChatGptWebCompanionTurnRequest {
  protocol: typeof WCO_CHATGPT_WEB_COMPANION_PROTOCOL;
  id: string;
  type: "turn";
  upstream_root: string;
  upstream_home?: string;
  role: ChatGptWebCompanionRole;
  mode: ChatGptWebCompanionMode;
  prompt: string;
}

export type ChatGptWebCompanionRequest =
  | ChatGptWebCompanionProbeRequest
  | ChatGptWebCompanionTurnRequest;

export interface ChatGptWebCompanionSuccess {
  protocol: typeof WCO_CHATGPT_WEB_COMPANION_PROTOCOL;
  id: string;
  ok: true;
  provider: "chatgpt-web";
  transport: typeof WCO_CHATGPT_WEB_COMPANION_TRANSPORT;
  upstream_sha: typeof PINNED_MIUUYY_CHATGPT_WEB_SHA;
  temporary_chat: true;
  mode?: ChatGptWebCompanionMode;
  model_id?: string;
  answer?: string;
  sol_available?: boolean;
  pro_available?: boolean;
}

export interface ChatGptWebCompanionFailure {
  protocol: typeof WCO_CHATGPT_WEB_COMPANION_PROTOCOL;
  id: string;
  ok: false;
  code: string;
  error: string;
}

export type ChatGptWebCompanionResponse =
  | ChatGptWebCompanionSuccess
  | ChatGptWebCompanionFailure;
