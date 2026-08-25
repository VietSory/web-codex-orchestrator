import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  WCO_BROWSER_COMPANION_KIND,
  WCO_BROWSER_COMPANION_PROTOCOL_VERSION,
  parseWcoBrowserCompanionRequest,
  type WcoBrowserCompanionErrorMessage,
  type WcoBrowserCompanionMessage,
  type WcoBrowserCompanionRequest,
} from "../agent/wco-browser-companion-protocol.js";

function writeMessage(output: Writable, message: WcoBrowserCompanionMessage): void {
  output.write(`${JSON.stringify(message)}\n`);
}

function requestError(id: string, code: string, message: string): WcoBrowserCompanionErrorMessage {
  return { type: "error", id, code, message };
}

/**
 * Native Windows boundary for ChatGPT Web model transport.
 *
 * This process intentionally has no repository/workspace API. Its stdin protocol accepts only
 * prepared prompt text plus bounded browser-model metadata. Browser control is implemented here,
 * on the same OS as the browser, so WSL never needs a CDP/network bridge.
 */
export async function runWcoWindowsBrowserCompanion(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  if (process.platform !== "win32") {
    throw Object.assign(new Error("WCO browser companion must run as a native Windows process."), {
      code: "WCO_BROWSER_COMPANION_WINDOWS_REQUIRED",
    });
  }

  writeMessage(output, {
    type: "ready",
    protocol_version: WCO_BROWSER_COMPANION_PROTOCOL_VERSION,
    kind: WCO_BROWSER_COMPANION_KIND,
    pid: process.pid,
  });

  const lines = createInterface({ input, crlfDelay: Infinity });
  let shutdown = false;

  for await (const line of lines) {
    if (shutdown || !line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      writeMessage(output, requestError(
        "unknown",
        "WCO_BROWSER_COMPANION_PROTOCOL_INVALID",
        `Invalid JSON request: ${error instanceof Error ? error.message : String(error)}`,
      ));
      continue;
    }

    let request: WcoBrowserCompanionRequest;
    try {
      request = parseWcoBrowserCompanionRequest(parsed);
    } catch (error) {
      const candidateId = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && typeof (parsed as Record<string, unknown>).id === "string"
        ? (parsed as Record<string, unknown>).id as string
        : "unknown";
      writeMessage(output, requestError(
        candidateId,
        (error as { code?: string }).code || "WCO_BROWSER_COMPANION_PROTOCOL_INVALID",
        error instanceof Error ? error.message : String(error),
      ));
      continue;
    }

    if (request.type === "shutdown") {
      writeMessage(output, { type: "result", id: request.id, value: { shutdown: true } });
      shutdown = true;
      lines.close();
      break;
    }

    if (request.type === "abort") {
      writeMessage(output, { type: "result", id: request.id, value: { aborted: false } });
      continue;
    }

    // The first-party process boundary is landed before browser automation is wired into it.
    // Failing closed here prevents this scaffold from ever being mistaken for qualified transport.
    writeMessage(output, requestError(
      request.id,
      "WCO_BROWSER_COMPANION_BROWSER_NOT_READY",
      "First-party Windows browser transport is not wired yet; no provider fallback is allowed.",
    ));
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  runWcoWindowsBrowserCompanion().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
