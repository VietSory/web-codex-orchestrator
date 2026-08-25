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
import { WcoWindowsChatGptBrowserTransport } from "./browser-transport.js";

function writeMessage(output: Writable, message: WcoBrowserCompanionMessage): void {
  output.write(`${JSON.stringify(message)}\n`);
}

function requestError(id: string, code: string, message: string): WcoBrowserCompanionErrorMessage {
  return { type: "error", id, code, message };
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "WCO_BROWSER_COMPANION_BROWSER_FAILED";
}

/**
 * Native Windows boundary for ChatGPT Web model transport.
 *
 * This process intentionally has no repository/workspace API. Its stdin protocol accepts only
 * prepared prompt text plus bounded browser-model metadata. Browser/CDP control stays in this
 * native Windows process, while WSL retains repository, mutation, verification and Git authority.
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

  const transport = new WcoWindowsChatGptBrowserTransport(process.env);
  const active = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Infinity });
  let shuttingDown = false;

  const dispatch = (request: Extract<WcoBrowserCompanionRequest, { type: "inspect" | "run" }>): void => {
    if (active.has(request.id)) {
      writeMessage(output, requestError(request.id, "WCO_BROWSER_COMPANION_DUPLICATE_ID", "A browser request with this id is already active."));
      return;
    }
    const controller = new AbortController();
    active.set(request.id, controller);
    const task = (async () => {
      try {
        if (request.type === "inspect") {
          const evidence = await transport.inspect(controller.signal);
          writeMessage(output, { type: "result", id: request.id, value: evidence });
          return;
        }
        const result = await transport.run(request.prompt, request.mode, controller.signal);
        writeMessage(output, { type: "result", id: request.id, text: result.text, value: result.evidence });
      } catch (error) {
        writeMessage(output, requestError(
          request.id,
          errorCode(error),
          error instanceof Error ? error.message : String(error),
        ));
      } finally {
        active.delete(request.id);
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  writeMessage(output, {
    type: "ready",
    protocol_version: WCO_BROWSER_COMPANION_PROTOCOL_VERSION,
    kind: WCO_BROWSER_COMPANION_KIND,
    pid: process.pid,
  });

  try {
    for await (const line of lines) {
      if (shuttingDown || !line.trim()) continue;

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
          errorCode(error),
          error instanceof Error ? error.message : String(error),
        ));
        continue;
      }

      if (request.type === "shutdown") {
        shuttingDown = true;
        for (const controller of active.values()) controller.abort();
        if (pending.size > 0) await Promise.allSettled([...pending]);
        await transport.close();
        writeMessage(output, { type: "result", id: request.id, value: { shutdown: true } });
        lines.close();
        break;
      }

      if (request.type === "abort") {
        const controller = active.get(request.target_id);
        if (controller) controller.abort();
        writeMessage(output, { type: "result", id: request.id, value: { aborted: Boolean(controller) } });
        continue;
      }

      dispatch(request);
    }
  } finally {
    for (const controller of active.values()) controller.abort();
    if (pending.size > 0) await Promise.allSettled([...pending]);
    await transport.close();
  }
}

const entry = process.argv[1] ? new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href : "";
if (import.meta.url === entry) {
  runWcoWindowsBrowserCompanion().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
