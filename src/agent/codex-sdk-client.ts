import { Codex } from "@openai/codex-sdk";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import path from "node:path";
import { ExecutionError, isExecutionError } from "../execution/errors.js";
import { defaultSpawnBounded, type SpawnBoundedResult } from "../runtime/spawn-bounded.js";
import { assertCompatibleCodexCliVersion, minimalCodexEnvironment, type ResolvedCodexRuntime } from "../runtime/codex-runtime.js";
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";

export type CodexFactory = (
  options: ConstructorParameters<typeof Codex>[0]
) => Pick<Codex, "startThread" | "resumeThread">;

const MAX_PUBLIC_EVENTS = 256;
const PREFLIGHT_TIMEOUT_MS = 15_000;
const PREFLIGHT_OUTPUT_BYTES = 16_384;

function publicEvent(type: string): { type: string; timestamp: string } {
  return { type, timestamp: new Date().toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CodexSdkAgentClient implements AgentClient {
  constructor(
    private readonly runtime: ResolvedCodexRuntime,
    private readonly createCodex: CodexFactory =
      (options) => new Codex(options),
  ) {}

  private async preflight(args: string[], failureCode: "CODEX_RUNTIME_NOT_FOUND" | "CODEX_AUTH_UNAVAILABLE"): Promise<SpawnBoundedResult> {
    const result = await defaultSpawnBounded({
      executable: this.runtime.executable,
      args,
      cwd: path.dirname(this.runtime.executable),
      environment: minimalCodexEnvironment(this.runtime),
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
      stdoutMaxBytes: PREFLIGHT_OUTPUT_BYTES,
      stderrMaxBytes: PREFLIGHT_OUTPUT_BYTES,
    });
    if (result.spawnError || result.timedOut || result.exitCode !== 0) {
      throw new ExecutionError(failureCode, failureCode === "CODEX_AUTH_UNAVAILABLE" ? "Codex authentication is unavailable." : "The Codex runtime is unavailable.");
    }
    return result;
  }

  async checkAvailability(): Promise<void> {
    const version = await this.preflight(["--version"], "CODEX_RUNTIME_NOT_FOUND");
    assertCompatibleCodexCliVersion(`${version.stdout}\n${version.stderr}`);
    await this.preflight(["login", "status"], "CODEX_AUTH_UNAVAILABLE");
  }

  private validateRequest(request: AgentTurnRequest): void {
    if (request.approval_policy !== "never" || request.network_access !== false || request.live_web_search !== false || request.cached_web_search !== false) {
      throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "Codex approval, network, and web-search access must be restricted.");
    }
    if (!request.workspace_path || !request.accepted_bundle_path || !path.isAbsolute(request.workspace_path) || !path.isAbsolute(request.accepted_bundle_path)) {
      throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "Codex workspace and accepted bundle paths must be absolute.");
    }
    if (!isRecord(request.output_schema)) {
      throw new ExecutionError("AGENT_OUTPUT_INVALID", "Codex output schema is required.");
    }
    const workspace = path.resolve(request.workspace_path);
    const bundle = path.resolve(request.accepted_bundle_path);
    if (workspace === bundle || workspace.startsWith(`${bundle}${path.sep}`) || bundle.startsWith(`${workspace}${path.sep}`)) {
      throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "The accepted bundle must remain outside the writable workspace root.");
    }
    if (request.read_only && request.sandbox_mode !== "read-only") throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "Read-only Codex turns require read-only sandbox mode.");
    if (!request.read_only && request.sandbox_mode !== "workspace-write") throw new ExecutionError("CODEX_SANDBOX_UNAVAILABLE", "Implementation turns require workspace-write sandbox mode.");
  }

  private mapSdkError(error: unknown, request: AgentTurnRequest): ExecutionError {
    if (isExecutionError(error)) return error;
    if (request.signal?.aborted) return new ExecutionError("INTERRUPTED", "Execution was cancelled.");
    if (error instanceof Error && /timed?\s*out|timeout/i.test(error.message)) return new ExecutionError("CODEX_TURN_TIMEOUT", "The Codex turn timed out.");
    if (error instanceof Error && /auth|login|unauthori[sz]ed|forbidden|\b401\b/i.test(error.message)) return new ExecutionError("CODEX_AUTH_UNAVAILABLE", "Codex authentication is unavailable.");
    return new ExecutionError("CODEX_TURN_FAILED", "The Codex turn failed.");
  }

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    this.validateRequest(request);
    try {
      const codex = this.createCodex({
        codexPathOverride: this.runtime.executable,
        env: minimalCodexEnvironment(this.runtime),
        config: {
          show_raw_agent_reasoning: false,
        },
      });
      const threadOptions: ThreadOptions = {
        model: request.model,
        modelReasoningEffort: request.reasoning_effort,
        workingDirectory: request.workspace_path,
        sandboxMode: request.sandbox_mode,
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        additionalDirectories: [],
      };
      const thread = request.thread_id
        ? codex.resumeThread(request.thread_id, threadOptions)
        : codex.startThread(threadOptions);
      const { events } = await thread.runStreamed(request.prompt, {
        outputSchema: request.output_schema,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      let finalResponse = "";
      let usage: AgentTurnResponse["usage"];
      const public_events: NonNullable<AgentTurnResponse["public_events"]> = [];
      const recordEvent = (type: string): void => {
        if (public_events.length < MAX_PUBLIC_EVENTS) public_events.push(publicEvent(type));
      };
      for await (const event of events as AsyncIterable<ThreadEvent>) {
        switch (event.type) {
          case "thread.started":
            recordEvent(event.type);
            break;
          case "turn.started":
            recordEvent(event.type);
            break;
          case "item.completed":
            recordEvent(event.item.type);
            if (event.item.type === "agent_message") finalResponse = event.item.text;
            break;
          case "item.started":
          case "item.updated":
            recordEvent(event.item.type);
            break;
          case "turn.completed":
            recordEvent(event.type);
            usage = {
              input_tokens: event.usage.input_tokens,
              cached_input_tokens: event.usage.cached_input_tokens,
              output_tokens: event.usage.output_tokens,
            };
            break;
          case "turn.failed":
            recordEvent(event.type);
            throw this.mapSdkError(new Error(event.error.message), request);
          case "error":
            recordEvent(event.type);
            throw this.mapSdkError(new Error(event.message), request);
        }
      }
      if (!thread.id) throw new ExecutionError("CODEX_TURN_FAILED", "Codex did not provide a thread ID.");
      if (!finalResponse) throw new ExecutionError("AGENT_OUTPUT_INVALID", "Codex did not return a final structured response.");
      let output: unknown;
      try {
        output = JSON.parse(finalResponse) as unknown;
      } catch {
        throw new ExecutionError("AGENT_OUTPUT_INVALID", "Codex returned invalid JSON.");
      }
      return { thread_id: thread.id, output, ...(usage ? { usage } : {}), public_events };
    } catch (error) {
      throw this.mapSdkError(error, request);
    }
  }
}
