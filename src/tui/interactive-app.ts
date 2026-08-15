import { access, realpath } from "node:fs/promises";
import { parseReviewerSelection, reviewerLabel, type ReviewerSelection } from "../agent/reviewer-selection.js";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { readExecutorReceipt } from "../executor/store.js";
import { driveAutopilotJob, readAutopilotReceipt } from "../orchestration/autopilot-job.js";
import { readSelectedArtifact } from "../orchestration/artifact-binding.js";
import { runControlCommand } from "../orchestration/control-cli.js";
import type { JobMode } from "../orchestration/job-mode.js";
import { drivePairHarnessToCodeReview } from "../orchestration/pair-harness.js";
import { readLifecycleSnapshot } from "../orchestration/snapshot-reader.js";
import { readResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { detectRepository } from "../setup/repository-detect.js";
import { runSetupCommand } from "../setup/setup-cli.js";
import { runUninstallCommand } from "../uninstall/uninstall-cli.js";
import {
  advanceLocalWorker,
  appendLocalClarification,
  completeLocalWorkerSession,
  localWorkerJobMode,
  readLocalWorkerSession,
  startLocalAuthoring,
  type LocalWorkerSession,
} from "../web-bridge/local-worker.js";
import { createConfiguredWebBridge } from "../web-bridge/bridge-factory.js";
import { readWebCodeReviewReceipt } from "../web-bridge/code-review-service.js";
import { createPendingFinalReview, type WebReviewPurpose } from "../web-bridge/final-review-service.js";
import { materializeAndSubmitWebVerdict } from "../web-bridge/verdict-materializer.js";
import { runWebCommand } from "../web-bridge/web-cli.js";
import type { WebBridge } from "../web-bridge/web-bridge.js";
import { listLocalTaskHistory } from "../web-bridge/session-history.js";
import { NativeAgentRunGuard } from "../web-bridge/native-agent-run-guard.js";
import { readNativeOpenAiCredential } from "../web-bridge/native-openai-credential.js";
import { startNativeTunnel, stopNativeTunnel, type NativeTunnelProcess } from "../web-bridge/native-tunnel-runtime.js";
import { triggerWorkspaceAgent } from "../web-bridge/workspace-agent-client.js";
import { contentDigest, WebBridgeError } from "../web-bridge/contracts.js";
import { formatAutopilotOutcome, formatAutopilotStatus } from "./autopilot-presenter.js";
import { withFinalReviewNotification } from "./autopilot-web-bridge.js";
import { pairSessionCanComplete } from "./pair-completion.js";
import { derivePairStage, formatPairReview, formatPairStatus } from "./pair-presenter.js";
import { readReviewMode, writeReviewMode } from "./review-mode-store.js";
import { commandPalette } from "./slash-commands.js";
import { deriveUserStage, formatUserStage, type UserStage } from "./stages.js";
import { runInteractiveSession, terminalIo, type InteractiveIo } from "./session.js";

const sleep = async (milliseconds: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, milliseconds));
const MAX_WEB_REVIEW_ROUNDS = 4;

function splitRunId(runId: string): { taskId: string; archiveSha: string } | null {
  const index = runId.lastIndexOf(":");
  const taskId = runId.slice(0, index), archiveSha = runId.slice(index + 1);
  return index > 0 && /^[a-f0-9]{64}$/.test(archiveSha) ? { taskId, archiveSha } : null;
}

function readableState(value: unknown): string {
  const raw = String(value ?? "pending").trim();
  if (!raw) return "pending";
  const words = raw.toLowerCase().replaceAll("_", " ");
  return words === "ready for web review" ? "ready" : words;
}

function historyTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace("T", " ").replace(/\.\d{3}Z$/u, " UTC");
}

async function resultReceipt(runId: string, stateDirectory: string) {
  const identity = splitRunId(runId);
  if (!identity) return null;
  return await readResultBundleReceipt(resultBundlePaths(stateDirectory, identity.taskId, identity.archiveSha).receiptPath);
}

async function reviewSummary(runId: string, stateDirectory: string): Promise<string> {
  const identity = splitRunId(runId);
  if (!identity) return "The current run identity is invalid. Use /doctor for recovery guidance.";
  const artifact = await readSelectedArtifact(stateDirectory, runId);
  const [execution, result, snapshot, webCodeReview] = await Promise.all([
    artifact ? readExecutorReceipt(stateDirectory, identity.taskId, identity.archiveSha, artifact.artifact_sha256) : Promise.resolve(null),
    resultReceipt(runId, stateDirectory),
    readLifecycleSnapshot(stateDirectory, runId),
    readWebCodeReviewReceipt(stateDirectory, runId),
  ]);
  let codeReview = "not started";
  if (execution?.review_strategy === "web") codeReview = `independent review · ${readableState(webCodeReview?.state)}`;
  else if (execution?.reviewer_selection) {
    const selected: ReviewerSelection = execution.reviewer_selection;
    const review = selected.kind === "terra" ? execution.terra_review : execution.sol_review;
    codeReview = `${reviewerLabel(selected)} · ${readableState(review.verdict)} · ${review.rounds} round(s)`;
  }
  return formatPairReview({
    snapshot,
    checksPassed: execution?.verification.passed === true,
    codeReview,
    draftPrUrl: result?.pull_request?.url ?? null,
    gitVerified: Boolean(result?.published_commit_sha),
  });
}

function configSummary(config: TrustedConfig, repositoryId: string, reviewer: ReviewerSelection): string {
  const mode = config.web_bridge?.mode ?? "chatgpt_codex";
  const transport = !config.web_bridge
    ? "local ChatGPT/Codex"
    : mode === "web_native_mcp"
      ? "advanced local Secure MCP"
      : mode === "managed_actions"
        ? "optional managed Web"
        : mode === "personal_actions" || mode === "actions_relay"
          ? "advanced personal relay"
          : "offline/manual";
  return [
    `Repository       ${repositoryId}`,
    `Transport        ${transport}`,
    `AUTOPILOT review ${reviewerLabel(reviewer)}`,
    "Final review     independent semantic review · required",
    "",
    "Normal setup: one official ChatGPT authorization when needed; WCO state and repository authority stay local.",
    "Daily use: run `wco` and type a goal.",
    "PAIR does not use the selected AUTOPILOT reviewer.",
    "Advanced compatibility profiles are opt-in only and never an automatic fallback.",
  ].join("\n");
}

export function initialWorkflowContinueArguments(session: Pick<LocalWorkerSession, "run_id" | "state" | "web_pack_path">, stateDirectory: string, configPath: string): string[] {
  if (session.state !== "IMPLEMENTATION_REGISTERED" || !session.run_id || !session.web_pack_path) throw new Error("WEB_PACK_NOT_REGISTERED: the durable local worker has no exact implementation pack to continue.");
  return ["--run-id", session.run_id, "--state-dir", stateDirectory, "--config", configPath, "--web-pack", session.web_pack_path, "--max-transitions", "8"];
}

export async function runInteractiveApp(io: InteractiveIo = terminalIo()): Promise<number> {
  const paths = resolveWcoPaths({});
  let firstRun = false;
  try { await access(paths.config); }
  catch {
    firstRun = true;
    io.write("Welcome to WCO\n");
    io.write("Setting up this Git repository locally. If ChatGPT is not authorized yet, the official Codex sign-in may open once.\n\n");
    // `wco` itself is consent to register the current repository. ChatGPT
    // authorization is the only normal-user external setup boundary.
    const code = await runSetupCommand(["--yes"], process.cwd(), { write: (value) => io.write(value), error: (value) => io.write(value), question: async (prompt) => await io.question(prompt) });
    if (code !== 0) return code;
  }

  let config = await loadTrustedConfig(paths.config);
  const detected = await detectRepository(process.cwd());
  const root = await realpath(detected.root);
  const registration = Object.entries(config.repositories).find(([, value]) => value.path === root || value.path.toLowerCase() === root.toLowerCase());
  if (!registration) {
    io.write("This repository is not registered with WCO yet. Run `wco setup` here, then run `wco` again.\n");
    return 1;
  }

  const [repositoryId, repositoryConfig] = registration;
  let bridge: WebBridge | null = null;
  let latest = await readLocalWorkerSession(paths.state, repositoryId);
  let nativeTunnel: NativeTunnelProcess | null = null;
  const nativeRuns = new Map<string, NativeAgentRunGuard>();
  const webIo = {
    write: (value: string) => io.write(value),
    error: (value: string) => io.write(value),
    question: async (prompt: string) => await io.question(prompt),
    secret: async (prompt: string) => io.secret ? await io.secret(prompt) : await io.question(prompt),
  };

  const reloadBridge = async (): Promise<void> => {
    config = await loadTrustedConfig(paths.config);
    try { bridge = createConfiguredWebBridge(config, paths.bridge, process.env, paths.state); }
    catch { bridge = null; }
  };
  await reloadBridge();

  const isLocal = (): boolean => !config.web_bridge;
  const isNative = (): boolean => config.web_bridge?.mode === "web_native_mcp";
  const isManaged = (): boolean => config.web_bridge?.mode === "managed_actions";
  const ensureNativeTunnel = async (): Promise<void> => {
    if (!isNative()) return;
    if (nativeTunnel && nativeTunnel.child.exitCode === null) return;
    const credential = await readNativeOpenAiCredential(paths.credentials);
    nativeTunnel = await startNativeTunnel({ cacheDirectory: paths.cache, credential });
  };
  const connectionWorks = async (): Promise<boolean> => {
    if (!bridge || config.web_bridge?.mode === "manual_file") return false;
    if (isNative()) {
      try { await readNativeOpenAiCredential(paths.credentials); return (await bridge.getConnectionStatus()).connected; } catch { return false; }
    }
    try { return (await bridge.getConnectionStatus()).connected; } catch { return false; }
  };
  const ensureWebConnected = async (): Promise<boolean> => {
    // Normal local ChatGPT/Codex owns its official login boundary inside the
    // provider call. Do not preflight auth here: createAuthoringJob() performs
    // the interactive sign-in before durable task creation, so the user's first
    // goal can naturally trigger one browser authorization and continue.
    if (isLocal()) {
      if (bridge) return true;
      io.write("The local ChatGPT/Codex runtime is unavailable. Use /doctor for the next step.\n");
      return false;
    }
    if (await connectionWorks()) { if (isNative()) await ensureNativeTunnel(); return true; }
    if (config.web_bridge?.mode === "manual_file") return false;
    if (isNative()) {
      io.write("Advanced native-MCP transport is not connected.\n");
      const code = await runWebCommand(["connect", "--native"], webIo);
      if (code !== 0) return false;
      await reloadBridge();
      await ensureNativeTunnel();
      return await connectionWorks();
    }
    if (isManaged()) {
      const code = await runWebCommand(["connect", "--managed"], webIo);
      if (code !== 0) return false;
      await reloadBridge();
      return await connectionWorks();
    }
    const personal = config.web_bridge?.mode === "personal_actions" || config.web_bridge?.mode === "actions_relay";
    const answer = (await io.question(personal ? "Advanced personal relay is not connected. Configure it? [y/N] " : "Advanced Web profile is disconnected. Configure it? [y/N] ")).trim();
    if (!/^y(es)?$/i.test(answer)) return false;
    const code = await runWebCommand(personal ? ["setup", "--personal"] : ["connect", "--self-hosted"], webIo);
    if (code !== 0) return false;
    await reloadBridge(); return await connectionWorks();
  };
  const openWebArchitect = async (): Promise<void> => {
    const code = await runWebCommand(["open"], webIo);
    if (code !== 0) throw new Error("WEB_GPT_OPEN_FAILED: the configured advanced Senior Architect GPT could not be opened.");
  };
  const nativeConversationKey = (): string => `wco-author-${latest?.session_id ?? repositoryId}`.slice(0, 128);
  const triggerNativeTurn = async (purpose: "author" | WebReviewPurpose, identity: string): Promise<NativeAgentRunGuard | null> => {
    if (!isNative()) return null;
    await ensureNativeTunnel();
    const credential = await readNativeOpenAiCredential(paths.credentials);
    const conversationKey = purpose === "independent_code_review" ? `wco-review-${contentDigest({ identity }).slice(0, 48)}` : nativeConversationKey();
    const input = purpose === "author"
      ? "Continue the exact pending WCO authoring task. Use only WCO MCP tools: get the pending task, inspect the exact sealed Git base with bounded reads, seal the contract, then submit bounded implementation authority. Never request shell/Git mutation; Harness alone mutates and verifies."
      : purpose === "independent_code_review"
        ? "Perform the exact pending independent PAIR code review. Fetch pending review identity and exact review evidence through WCO MCP, inspect every changed hunk and necessary bounded context, then submit APPROVE, REVISE with bounded repair authority, or BLOCK. Never mutate or merge."
        : "Continue the original WCO author conversation and perform the exact pending final intent review. Fetch pending review identity/evidence through WCO MCP, compare the exact final Draft PR result to the original sealed intent and every changed hunk, then submit APPROVE, REVISE with bounded repair authority, or BLOCK. Never mutate or merge.";
    const receipt = await triggerWorkspaceAgent({ credential, input, conversationKey, idempotencyKey: `wco-${contentDigest({ purpose, identity }).slice(0, 48)}` });
    const guard = new NativeAgentRunGuard(credential, receipt.agent_trigger_run_id);
    nativeRuns.set(identity, guard);
    io.write(`ChatGPT Web ${purpose === "author" ? "authoring" : "review"} started automatically. ${receipt.conversation_url}\n`);
    return guard;
  };
  const assertNativeOutputStillPossible = async (identity: string, output: "implementation" | "verdict"): Promise<void> => {
    if (!isNative()) return;
    const guard = nativeRuns.get(identity);
    if (!guard) return;
    const status = await guard.assertCanStillComplete();
    if (status === "completed") {
      throw new WebBridgeError("WEB_NATIVE_AGENT_INCOMPLETE", `The ChatGPT Workspace Agent run completed without submitting the required WCO ${output}.`);
    }
  };

  const waitForImplementation = async (): Promise<LocalWorkerSession> => {
    if (!latest) throw new Error("No active authoring session.");
    if (!bridge) throw new Error("WCO transport is not connected.");
    const poll = Math.max(250, Math.min(config.web_bridge?.poll_interval_ms ?? 1_000, 10_000));
    io.write(isLocal()
      ? "● Understanding your goal and the exact repository state…\n"
      : "● Waiting for the configured authoring profile to prepare the task…\n");
    while (latest.state !== "IMPLEMENTATION_REGISTERED") {
      latest = await advanceLocalWorker({ bridge, session: latest, repositoryPath: repositoryConfig.path, stateDirectory: paths.state, configPath: paths.config, config });
      if (latest.state === "IMPLEMENTATION_REGISTERED") break;
      if (latest.state === "BLOCKED") throw new Error("Task preparation needs your attention. Use /status for details.");
      if (latest.job_id) await assertNativeOutputStillPossible(latest.job_id, "implementation");
      await sleep(poll);
    }
    return latest;
  };

  const continuePairWorkflow = async (): Promise<string> => {
    if (!latest?.run_id || !latest.web_pack_path || latest.state !== "IMPLEMENTATION_REGISTERED") return "PAIR is still preparing the task. Use /status for the current step.";
    if (!bridge) throw new Error("WCO transport is not connected.");
    const runId = latest.run_id;
    try {
      io.write("● Implementing, running checks, and preparing the Draft PR…\n");
      await drivePairHarnessToCodeReview({ runId, webPackPath: latest.web_pack_path, stateDirectory: paths.state, configPath: paths.config });
      io.write("● Implementation and checks complete. Review evidence is ready.\n");
    } catch (error) {
      return `PAIR · Needs your attention\nReason        ${error instanceof Error ? error.message : String(error)}\nNext          use /review for evidence and /doctor for recovery guidance\nNothing was merged. Saved progress is preserved.`;
    }
    let code = 0;

    for (let round = 0; round < MAX_WEB_REVIEW_ROUNDS; round += 1) {
      let snapshot = await readLifecycleSnapshot(paths.state, runId);
      if (pairSessionCanComplete(snapshot)) {
        await completeLocalWorkerSession({ session: latest, stateDirectory: paths.state });
        const result = await resultReceipt(runId, paths.state);
        return `PAIR · Ready for you\nDraft PR      ${result?.pull_request?.url ?? "ready"}\nChecks        passed\nCode review   approved\nFinal review  approved\nNext          review the Draft PR and merge when ready`;
      }
      if (snapshot.web_review_state === "ESCALATED") return "PAIR · Needs your attention\nFinal review found a consequential decision that needs you. Nothing was merged.";

      if (snapshot.web_review_state === "REVISION_REQUESTED") {
        code = await runControlCommand("continue", ["--run-id", runId, "--state-dir", paths.state, "--config", paths.config, "--max-transitions", "8"], { stdout: () => undefined, stderr: () => undefined });
        if (code !== 0) return "The revision stopped safely. Use /review and /doctor for details, then retry /run.";
        snapshot = await readLifecycleSnapshot(paths.state, runId);
        if (snapshot.web_review_state === "ESCALATED") return "PAIR · Needs your attention\nFinal review found a consequential decision that needs you. Nothing was merged.";
        if (pairSessionCanComplete(snapshot)) continue;
      }

      const review = await createPendingFinalReview({ bridge, runId, stateDirectory: paths.state });
      const reviewLabel = review.purpose === "independent_code_review" ? "independent code review" : "final intent review";
      if (isNative()) await triggerNativeTurn(review.purpose, review.job_id);
      else if (!isManaged() && !isLocal()) await openWebArchitect();
      io.write(`● Waiting for ${reviewLabel}${round > 0 ? ` · round ${round + 1}` : ""}…\n`);
      const poll = Math.max(250, Math.min(config.web_bridge?.poll_interval_ms ?? 1_000, 10_000));
      let verdict = await bridge.waitForVerdict(review.job_id);
      while (!verdict) {
        await assertNativeOutputStillPossible(review.job_id, "verdict");
        await sleep(poll);
        verdict = await bridge.waitForVerdict(review.job_id);
      }
      const adopted = await materializeAndSubmitWebVerdict({ envelope: verdict, stateDirectory: paths.state, configPath: paths.config });
      io.write(`● ${reviewLabel}: ${readableState(adopted.receipt.state)}\n`);
      code = await runControlCommand("continue", ["--run-id", runId, "--state-dir", paths.state, "--config", paths.config, "--max-transitions", "8"], { stdout: () => undefined, stderr: () => undefined });
      if (code !== 0) return "The workflow stopped safely. Use /review and /doctor for details, then retry /run.";
    }

    return "PAIR · Needs your attention\nThe review limit was reached without a final approval. Nothing was merged.";
  };

  const driveAutopilotForUser = async (): Promise<string> => {
    if (!latest?.run_id || !latest.web_pack_path || latest.state !== "IMPLEMENTATION_REGISTERED") return "AUTOPILOT is still preparing the task.";
    if (!bridge) throw new Error("WCO transport is not connected.");
    const controller = new AbortController(); const interrupt = (): void => controller.abort(); process.once("SIGINT", interrupt);
    try {
      const interactiveBridge = withFinalReviewNotification(
        bridge,
        async (reviewId) => {
          io.write("AUTOPILOT is ready for final review.\n");
          if (isNative()) await triggerNativeTurn("final_intent_review", reviewId);
          else if (!isManaged() && !isLocal()) await openWebArchitect();
          io.write("Waiting for final intent review…\n");
        },
        isNative() ? async (reviewId) => await assertNativeOutputStillPossible(reviewId, "verdict") : undefined,
      );
      const receipt = await driveAutopilotJob({ bridge: interactiveBridge, runId: latest.run_id, stateDirectory: paths.state, configPath: paths.config, webPackPath: latest.web_pack_path, signal: controller.signal, ...(config.web_bridge?.poll_interval_ms !== undefined ? { pollIntervalMs: config.web_bridge.poll_interval_ms } : {}) });
      if (receipt.status === "READY_FOR_YOU") await completeLocalWorkerSession({ session: latest, stateDirectory: paths.state });
      const result = await resultReceipt(receipt.run_id, paths.state);
      return formatAutopilotOutcome(receipt, result?.pull_request?.url ?? null);
    } catch (error) {
      return ["AUTOPILOT stopped safely.", error instanceof Error ? error.message : String(error), "Nothing was merged. Use /review for evidence and /doctor if a prerequisite is unavailable, then retry /run."].join("\n");
    } finally { process.removeListener("SIGINT", interrupt); }
  };

  const startAndDriveTask = async (goal: string, replaceExplicit = false, mode: JobMode = "PAIR"): Promise<string> => {
    if (!await ensureWebConnected()) return "Task was not started. Use /doctor for the next step, or /web status to inspect the selected transport.";
    if (!bridge) throw new Error("WCO transport is not connected.");
    const selectedReviewer = await readReviewMode(paths.state);
    latest = await startLocalAuthoring({ bridge, repository: { repository_id: repositoryId, base_branch: detected.base_branch, base_commit: detected.base_commit }, goal, stateDirectory: paths.state, replaceExplicit, mode });
    io.write("● Goal accepted. WCO is preparing the task safely.\n");
    if (mode === "AUTOPILOT") io.write(`AUTOPILOT reviewer: ${reviewerLabel(selectedReviewer)}\n`);
    if (isNative()) await triggerNativeTurn("author", latest.job_id!);
    else if (isManaged()) io.write("Optional managed ChatGPT Web authoring started automatically.\n");
    else if (!isLocal()) { io.write("Opening advanced WCO Senior Architect...\n"); await openWebArchitect(); }
    await waitForImplementation();
    io.write("● Plan ready. Starting implementation, checks, and review…\n");
    return mode === "AUTOPILOT" ? await driveAutopilotForUser() : await continuePairWorkflow();
  };

  const displayUserStatus = async (session: LocalWorkerSession | null): Promise<string> => {
    if (!session) return formatUserStage("READY");
    const stage = deriveUserStage(session);
    if (localWorkerJobMode(session) !== "AUTOPILOT") {
      if (!session.run_id) return formatUserStage(stage === "READY" ? "WEB_RESEARCH" : stage);
      try { return formatUserStage(derivePairStage(await readLifecycleSnapshot(paths.state, session.run_id))); }
      catch { return "Needs your attention"; }
    }
    if (!session.run_id) {
      const visibleStage: UserStage = stage === "READY" ? "WEB_RESEARCH" : stage;
      return `AUTOPILOT · ${formatUserStage(visibleStage)}`;
    }
    try { return formatAutopilotStatus(await readAutopilotReceipt(paths.state, session.run_id)); }
    catch { return "AUTOPILOT · Needs your attention"; }
  };

  if (firstRun && isNative()) {
    io.write("Advanced native-MCP setup is required for this explicitly selected profile. Normal zero-config WCO does not require a tunnel, connector, relay, public host, or inbound port.\n");
    const code = await runWebCommand(["connect", "--native"], webIo);
    if (code !== 0) return code;
    await reloadBridge();
    await ensureNativeTunnel();
  } else if (firstRun && isManaged()) {
    const code = await runWebCommand(["connect", "--managed"], webIo);
    if (code !== 0) return code;
    await reloadBridge();
  }

  try {
    await runInteractiveSession(io, {
      state: async () => {
        latest = await readLocalWorkerSession(paths.state, repositoryId);
        return { active: Boolean(latest && latest.state !== "COMPLETED"), sealed: latest?.sealed ?? false, summary: `WCO · ${repositoryId}\nRepository   ${detected.base_branch}@${detected.base_commit.slice(0, 7)}\nStatus       ${await displayUserStatus(latest)}${latest ? `\nTask         ${latest.goal}` : ""}` };
      },
      newTask: async (goal) => await startAndDriveTask(goal),
      clarify: async (value) => {
        if (!latest) return "No active task. Type a goal to start one.";
        const connectedBridge = bridge; if (!connectedBridge) return "ChatGPT/Codex is not ready. Use /doctor for the next step.";
        await appendLocalClarification({ bridge: connectedBridge, session: latest, value, stateDirectory: paths.state }); return "Added that detail to the task before the plan was locked.";
      },
      command: async (command, args) => {
        if (command === "/quit") return { message: "Goodbye.", quit: true };
        if (command === "/help") return { message: commandPalette() };
        if (command === "/new") { if (!args) return { message: "Usage: /new <goal>" }; return { message: await startAndDriveTask(args, true, "PAIR") }; }
        if (command === "/auto") { if (!args) return { message: "Usage: /auto <goal>" }; return { message: await startAndDriveTask(args, true, "AUTOPILOT") }; }
        if (command === "/mode") {
          const current = await readReviewMode(paths.state);
          if (!args) return { message: `AUTOPILOT reviewer: ${reviewerLabel(current)}\nFinal review: required\nUsage: /mode <sol|terra> <minimal|low|medium|high|xhigh>` };
          if (latest && localWorkerJobMode(latest) === "AUTOPILOT" && !["BLOCKED", "COMPLETED"].includes(latest.state)) return { message: `The AUTOPILOT reviewer is locked for the active task (${reviewerLabel(current)}). Finish this task before changing /mode.` };
          const values = args.split(/\s+/u).filter(Boolean);
          if (values.length !== 2) return { message: "Usage: /mode <sol|terra> <minimal|low|medium|high|xhigh>" };
          try { const selected = parseReviewerSelection(values[0]!, values[1]!); await writeReviewMode(paths.state, selected); return { message: `AUTOPILOT reviewer: ${reviewerLabel(selected)}. This applies to new AUTOPILOT tasks.` }; }
          catch (error) { return { message: error instanceof Error ? error.message : String(error) }; }
        }
        if (command === "/task") {
          if (!latest) return { message: "No active task." };
          const mode = localWorkerJobMode(latest); return { message: mode === "AUTOPILOT" ? `Goal: ${latest.goal}\nMode: AUTOPILOT\nPlan: ${latest.sealed ? "locked" : "being refined"}` : `Goal: ${latest.goal}\nPlan: ${latest.sealed ? "locked" : "being refined"}` };
        }
        if (command === "/web") {
          const webArgs = args ? args.split(/\s+/u).filter(Boolean) : ["status"];
          const code = await runWebCommand(webArgs, webIo);
          await reloadBridge();
          return { message: code === 0 ? "" : "The ChatGPT command needs attention. See the message above for the next step." };
        }
        if (command === "/doctor") {
          const lines: string[] = [];
          const doctorMode = latest ? localWorkerJobMode(latest) : "PAIR";
          const code = await runControlCommand("doctor", ["--state-dir", paths.state, "--config", paths.config, "--mode", doctorMode], { stdout: (value) => lines.push(value), stderr: (value) => lines.push(value) });
          const ending = code === 0 ? `Mode: ${doctorMode}\nEverything required for this mode is ready.` : `Mode: ${doctorMode}\nSome checks need attention before WCO can continue.`;
          return { message: `${lines.join("\n")}\n${ending}` };
        }
        if (command === "/status") {
          if (!latest) return { message: "Ready. Type a goal to start a task." };
          if (localWorkerJobMode(latest) === "AUTOPILOT") {
            const status = await displayUserStatus(latest);
            return { message: `Status: ${status}\nGoal: ${latest.goal}\nMode: AUTOPILOT\nPlan: ${latest.sealed ? "locked" : "being refined"}` };
          }
          if (!latest.run_id) return { message: `PAIR · ${await displayUserStatus(latest)}\nGoal          ${latest.goal}\nPlan          ${latest.sealed ? "locked" : "being refined"}\nNext          WCO is preparing the task` };
          try {
            const [snapshot, result] = await Promise.all([readLifecycleSnapshot(paths.state, latest.run_id), resultReceipt(latest.run_id, paths.state)]);
            return { message: formatPairStatus({ goal: latest.goal, planLocked: latest.sealed, snapshot, draftPrUrl: result?.pull_request?.url ?? null }) };
          } catch {
            return { message: `PAIR · Needs your attention\nGoal          ${latest.goal}\nNext          use /review for evidence and /doctor for recovery guidance` };
          }
        }
        if (command === "/review") return { message: latest?.run_id ? await reviewSummary(latest.run_id, paths.state) : "No review is available yet." };
        if (command === "/pause" || command === "/resume") {
          if (!latest?.run_id) return { message: "This task has not reached a pausable step yet." };
          const code = await runControlCommand(command.slice(1), ["--run-id", latest.run_id, "--state-dir", paths.state], { stdout: () => undefined, stderr: () => undefined });
          if (code === 0) return { message: command === "/pause" ? "Paused safely. Progress is saved." : "Resumed. Use /run to continue the task." };
          return { message: `${command === "/pause" ? "Pause" : "Resume"} could not be completed. Use /status and /doctor for details.` };
        }
        if (command === "/run") {
          if (!latest) return { message: "Type a task goal first." };
          if (latest.state === "COMPLETED") return { message: "This task is complete. Type a new goal or use /new <goal>." };
          if (!await ensureWebConnected()) return { message: "The selected transport is not ready. Use /doctor for the next step." };
          if (latest.state !== "IMPLEMENTATION_REGISTERED") {
            if (isNative()) await triggerNativeTurn("author", latest.job_id ?? latest.session_id);
            else if (!isManaged() && !isLocal()) await openWebArchitect();
            await waitForImplementation();
          }
          return { message: localWorkerJobMode(latest) === "AUTOPILOT" ? await driveAutopilotForUser() : await continuePairWorkflow() };
        }
        if (command === "/uninstall") {
          const answer = (await io.question("Remove WCO-owned local data and uninstall WCO? Your repositories, branches, and PRs will be preserved. [y/N] ")).trim();
          if (!/^y(es)?$/i.test(answer)) return { message: "Uninstall cancelled." };
          const code = await runUninstallCommand(["--purge", "--yes"]); return { message: code === 0 ? "WCO uninstall scheduled/completed. Goodbye." : "Uninstall could not be completed. Your repositories, branches, and PRs were preserved.", quit: code === 0 };
        }
        if (command === "/config") {
          if (args === "web") { const code = await runWebCommand(["connect"], webIo); await reloadBridge(); return { message: code === 0 ? configSummary(config, repositoryId, await readReviewMode(paths.state)) : "ChatGPT configuration needs attention. See the message above." }; }
          return { message: configSummary(config, repositoryId, await readReviewMode(paths.state)) };
        }
        if (command === "/history") {
          const previous = await listLocalTaskHistory(paths.state, repositoryId, 10); const entries = [...(latest ? [latest] : []), ...previous].slice(0, 10);
          return { message: entries.length ? entries.map((item, index) => `${index + 1}. ${item.goal}\n   ${formatUserStage(deriveUserStage(item))}${localWorkerJobMode(item) === "AUTOPILOT" ? " · AUTOPILOT" : ""} · ${historyTime(item.updated_at)}`).join("\n") : "No task history for this repository." };
        }
        return { message: `Unknown command '${command}'. Type / to see available commands.` };
      },
    });
  } finally { await stopNativeTunnel(nativeTunnel).catch(() => undefined); }
  return 0;
}
