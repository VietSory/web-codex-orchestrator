import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PINNED_MIUUYY_CHATGPT_WEB_SHA,
  WCO_CHATGPT_WEB_COMPANION_PROTOCOL,
  WCO_CHATGPT_WEB_COMPANION_TRANSPORT,
  type ChatGptWebCompanionMode,
  type ChatGptWebCompanionRequest,
  type ChatGptWebCompanionResponse,
  type ChatGptWebCompanionSuccess,
} from "../agent/chatgpt-web-companion-protocol.js";

const MAX_STDIN_BYTES = 4 * 1024 * 1024;

type UpstreamConfig = Record<string, unknown> & {
  browserHost?: unknown;
  solAvailable?: unknown;
  proAvailable?: unknown;
};

interface UpstreamConfigModule {
  loadConfig(): UpstreamConfig;
  providerConfig(config: UpstreamConfig): {
    chatgptWeb?: {
      localToolsEnabled?: boolean;
    };
  };
}

interface UpstreamBrowserWorker {
  inspectSession(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }>;
  run(turn: {
    traceId: string;
    modelId: string;
    reasoning?: string;
    capabilities: {
      localToolsEnabled: false;
      solAvailable: boolean;
      proAvailable: boolean;
    };
    prepare: () => Promise<{
      text: string;
      images: never[];
      release: () => void;
    }>;
    onTextDelta: (delta: string) => void;
  }): Promise<string>;
}

interface UpstreamBrowserWorkerModule {
  ChatGptBrowserWorker: {
    forProvider(provider: unknown): UpstreamBrowserWorker;
  };
  closeChatGptBrowserWorkers(): Promise<void>;
}

interface UpstreamModelModule {
  CHATGPT_WEB_MODEL_ID: string;
  CHATGPT_WEB_LUNA_MODEL_ID: string;
  resolveChatGptWebModelMode(
    modelId: string,
    reasoning: string | undefined,
    capabilities: {
      localToolsEnabled: false;
      solAvailable: boolean;
      proAvailable: boolean;
    },
  ): {
    modelId: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
  };
}

function errorCode(error: unknown): string {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "WEB_CHATGPT_COMPANION_UPSTREAM_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestIdFromUnknown(value: unknown): string {
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && "id" in value
    && typeof (value as { id?: unknown }).id === "string"
  ) return (value as { id: string }).id;
  return "unknown";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) {
      throw Object.assign(
        new Error("Companion request exceeded the bounded stdin limit."),
        { code: "WEB_CHATGPT_COMPANION_REQUEST_TOO_LARGE" },
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequest(source: string): ChatGptWebCompanionRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.trim());
  } catch {
    throw Object.assign(
      new Error("Companion stdin must contain exactly one JSON request."),
      { code: "WEB_CHATGPT_COMPANION_REQUEST_INVALID" },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(
      new Error("Companion request must be an object."),
      { code: "WEB_CHATGPT_COMPANION_REQUEST_INVALID" },
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.protocol !== WCO_CHATGPT_WEB_COMPANION_PROTOCOL
    || typeof record.id !== "string"
    || record.id.length < 8
    || record.id.length > 128
    || typeof record.upstream_root !== "string"
    || !record.upstream_root.trim()
    || record.upstream_root.includes("\u0000")
  ) {
    throw Object.assign(
      new Error("Companion request protocol, identity, or upstream root is invalid."),
      { code: "WEB_CHATGPT_COMPANION_REQUEST_INVALID" },
    );
  }
  if (
    record.upstream_home !== undefined
    && (
      typeof record.upstream_home !== "string"
      || !record.upstream_home.trim()
      || record.upstream_home.includes("\u0000")
    )
  ) {
    throw Object.assign(
      new Error("Companion upstream home is invalid."),
      { code: "WEB_CHATGPT_COMPANION_REQUEST_INVALID" },
    );
  }
  if (record.type === "probe") return parsed as ChatGptWebCompanionRequest;
  if (
    record.type !== "turn"
    || (
      record.role !== "implementer"
      && record.role !== "internal_reviewer"
      && record.role !== "final_reviewer"
    )
    || (
      record.mode !== "instant"
      && record.mode !== "medium"
      && record.mode !== "high"
      && record.mode !== "extra-high"
      && record.mode !== "pro"
      && record.mode !== "luna"
    )
    || typeof record.prompt !== "string"
    || !record.prompt.trim()
    || Buffer.byteLength(record.prompt) > MAX_STDIN_BYTES
  ) {
    throw Object.assign(
      new Error("Companion turn request is invalid or oversized."),
      { code: "WEB_CHATGPT_COMPANION_REQUEST_INVALID" },
    );
  }
  return parsed as ChatGptWebCompanionRequest;
}

function writeResponse(response: ChatGptWebCompanionResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function pinnedCheckout(rootValue: string): string {
  const root = path.resolve(rootValue);
  if (!existsSync(root)) {
    throw Object.assign(
      new Error(`Pinned miuuyy checkout does not exist: ${root}`),
      { code: "WEB_CHATGPT_COMPANION_UPSTREAM_MISSING" },
    );
  }
  const head = execFileSync(
    "git",
    ["-C", root, "rev-parse", "HEAD"],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  if (head !== PINNED_MIUUYY_CHATGPT_WEB_SHA) {
    throw Object.assign(
      new Error(
        `miuuyy/codex-chatgpt-web HEAD is ${head}; WCO requires pinned ${PINNED_MIUUYY_CHATGPT_WEB_SHA}.`,
      ),
      { code: "WEB_CHATGPT_COMPANION_UPSTREAM_SHA_MISMATCH" },
    );
  }
  return root;
}

function modeSelection(
  mode: ChatGptWebCompanionMode,
  model: UpstreamModelModule,
  capabilities: {
    localToolsEnabled: false;
    solAvailable: boolean;
    proAvailable: boolean;
  },
): { modelId: string; effort: "low" | "medium" | "high" | "xhigh" | "max" } {
  const request = mode === "luna"
    ? { modelId: model.CHATGPT_WEB_LUNA_MODEL_ID, effort: "low" }
    : mode === "instant"
      ? { modelId: model.CHATGPT_WEB_MODEL_ID, effort: "low" }
      : mode === "medium"
        ? { modelId: model.CHATGPT_WEB_MODEL_ID, effort: "medium" }
        : mode === "high"
          ? { modelId: model.CHATGPT_WEB_MODEL_ID, effort: "high" }
          : mode === "extra-high"
            ? { modelId: model.CHATGPT_WEB_MODEL_ID, effort: "xhigh" }
            : { modelId: model.CHATGPT_WEB_MODEL_ID, effort: "max" };
  return model.resolveChatGptWebModelMode(
    request.modelId,
    request.effort,
    capabilities,
  );
}

async function importUpstream(root: string): Promise<{
  config: UpstreamConfigModule;
  worker: UpstreamBrowserWorkerModule;
  model: UpstreamModelModule;
}> {
  const configPath = path.join(root, "src", "config.ts");
  const workerPath = path.join(
    root,
    "src",
    "adapters",
    "chatgpt-web",
    "browser-worker.ts",
  );
  const modelPath = path.join(
    root,
    "src",
    "adapters",
    "chatgpt-web",
    "model.ts",
  );
  for (const candidate of [configPath, workerPath, modelPath]) {
    if (!existsSync(candidate)) {
      throw Object.assign(
        new Error(`Pinned miuuyy source file is missing: ${candidate}`),
        { code: "WEB_CHATGPT_COMPANION_UPSTREAM_LAYOUT_MISMATCH" },
      );
    }
  }
  const [config, worker, model] = await Promise.all([
    import(pathToFileURL(configPath).href) as Promise<UpstreamConfigModule>,
    import(pathToFileURL(workerPath).href) as Promise<UpstreamBrowserWorkerModule>,
    import(pathToFileURL(modelPath).href) as Promise<UpstreamModelModule>,
  ]);
  return { config, worker, model };
}

async function runRequest(
  request: ChatGptWebCompanionRequest,
): Promise<ChatGptWebCompanionSuccess> {
  if (process.platform !== "win32") {
    throw Object.assign(
      new Error(
        "The miuuyy companion must run as a Windows-native process so browser automation never crosses the WSL CDP boundary.",
      ),
      { code: "WEB_CHATGPT_COMPANION_WINDOWS_REQUIRED" },
    );
  }

  const root = pinnedCheckout(request.upstream_root);
  if (request.upstream_home) {
    process.env.CODEX_CHATGPT_WEB_HOME = request.upstream_home;
  }

  const upstream = await importUpstream(root);
  const config = upstream.config.loadConfig();
  if (config.browserHost !== "launcher") {
    throw Object.assign(
      new Error(
        "The pinned miuuyy configuration must use browserHost=launcher; WCO will not fall back to a cross-OS managed Chrome/CDP path.",
      ),
      { code: "WEB_CHATGPT_COMPANION_LAUNCHER_REQUIRED" },
    );
  }
  const solAvailable = config.solAvailable === true;
  const proAvailable = config.proAvailable === true;
  const capabilities = {
    localToolsEnabled: false as const,
    solAvailable,
    proAvailable,
  };
  const provider = upstream.config.providerConfig({
    ...config,
    mode: "browser-only",
  });
  if (provider.chatgptWeb) provider.chatgptWeb.localToolsEnabled = false;
  const worker = upstream.worker.ChatGptBrowserWorker.forProvider(provider);

  try {
    if (request.type === "probe") {
      const session = await worker.inspectSession(true);
      if (session.authenticated !== true || session.temporary !== true) {
        throw Object.assign(
          new Error("miuuyy launcher session is not authenticated in Temporary Chat."),
          { code: "WEB_CHATGPT_COMPANION_SESSION_NOT_READY" },
        );
      }
      return {
        protocol: WCO_CHATGPT_WEB_COMPANION_PROTOCOL,
        id: request.id,
        ok: true,
        provider: "chatgpt-web",
        transport: WCO_CHATGPT_WEB_COMPANION_TRANSPORT,
        upstream_sha: PINNED_MIUUYY_CHATGPT_WEB_SHA,
        temporary_chat: true,
        ...(typeof session.solAvailable === "boolean"
          ? { sol_available: session.solAvailable }
          : { sol_available: solAvailable }),
        ...(typeof session.proAvailable === "boolean"
          ? { pro_available: session.proAvailable }
          : { pro_available: proAvailable }),
      };
    }

    const selected = modeSelection(request.mode, upstream.model, capabilities);
    const traceId = `wco_${request.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 96)}`;
    const answer = await worker.run({
      traceId,
      modelId: selected.modelId,
      reasoning: selected.effort,
      capabilities,
      prepare: async () => ({
        text: request.prompt,
        images: [],
        release: () => undefined,
      }),
      onTextDelta: () => undefined,
    });
    return {
      protocol: WCO_CHATGPT_WEB_COMPANION_PROTOCOL,
      id: request.id,
      ok: true,
      provider: "chatgpt-web",
      transport: WCO_CHATGPT_WEB_COMPANION_TRANSPORT,
      upstream_sha: PINNED_MIUUYY_CHATGPT_WEB_SHA,
      temporary_chat: true,
      mode: request.mode,
      model_id: selected.modelId,
      answer,
      sol_available: solAvailable,
      pro_available: proAvailable,
    };
  } finally {
    await upstream.worker.closeChatGptBrowserWorkers();
  }
}

async function main(): Promise<void> {
  // Upstream browser diagnostics/logs are useful, but stdout is reserved for
  // exactly one machine-readable companion response consumed by WCO.
  const stderr = console.error.bind(console);
  console.log = (...args: unknown[]) => stderr(...args);
  console.info = (...args: unknown[]) => stderr(...args);
  console.warn = (...args: unknown[]) => stderr(...args);
  console.debug = (...args: unknown[]) => stderr(...args);

  let parsedUnknown: unknown;
  let request: ChatGptWebCompanionRequest;
  try {
    const source = await readStdin();
    parsedUnknown = JSON.parse(source.trim());
    request = parseRequest(source);
  } catch (error) {
    writeResponse({
      protocol: WCO_CHATGPT_WEB_COMPANION_PROTOCOL,
      id: requestIdFromUnknown(parsedUnknown),
      ok: false,
      code: errorCode(error),
      error: errorMessage(error),
    });
    process.exitCode = 1;
    return;
  }

  try {
    writeResponse(await runRequest(request));
  } catch (error) {
    writeResponse({
      protocol: WCO_CHATGPT_WEB_COMPANION_PROTOCOL,
      id: request.id,
      ok: false,
      code: errorCode(error),
      error: errorMessage(error),
    });
    process.exitCode = 1;
  }
}

await main();
