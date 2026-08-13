import type { WebBridge } from "./web-bridge.js";

export interface PreparedRunAwareWebBridge extends WebBridge {
  bindPreparedRun(jobId: string, runId: string, idempotencyKey: string): Promise<void>;
}

export function isPreparedRunAwareWebBridge(value: WebBridge): value is PreparedRunAwareWebBridge {
  return typeof (value as Partial<PreparedRunAwareWebBridge>).bindPreparedRun === "function";
}
