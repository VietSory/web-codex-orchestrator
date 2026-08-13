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
import { readReviewMode, writeReviewMode } from "./review-mode-store.js";
import { commandPalette } from "./slash-commands.js";
import { deriveUserStage } from "./stages.js";
import { runInteractiveSession, terminalIo, type InteractiveIo } from "./session.js";

const sleep = async (milliseconds: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, milliseconds));
const MAX_WEB_REVIEW_ROUNDS = 4;

function splitRunId(runId: string): { taskId: string; archiveSha: string } | null {
  const index = runId.lastIndexOf(":");
  const taskId = runId.slice(0, index), archiveSha = runId.slice(index + 1);
  return index > 0 && /^[a-f0-9]{64}$/.test(archiveSha) ? { taskId, archiveSha } : null;
}

async function resultReceipt(runId: string, stateDirectory: string) {
  const identity = splitRunId(runId);
  if (!identity) return null;
  return await readResultBundleReceipt(resultBundlePaths(stateDirectory, identity.taskId, identity.archiveSha).receiptPath);
}

async function reviewSummary(runId: string, stateDirectory: string): Promise<string> {
  const identity = splitRunId(runId);
  if (!identity) return "Current run identity is invalid.";
  const artifact = await readSelectedArtifact(stateDirectory, runId);
  const [execution, result, snapshot, webCodeReview] = await Promise.all([
    artifact ? readExecutorReceipt(stateDirectory, identity.taskId, identity.archiveSha, artifact.artifact_sha256) : Promise.resolve(null),
    resultReceipt(runId, stateDirectory),
    readLifecycleSnapshot(stateDirectory, runId),
    readWebCodeReviewReceipt(stateDirectory, runId),
  ]);
  let codeReview = "pending";
  if (execution?.review_strategy === "web") codeReview = `independent Web · ${webCodeReview?.state ?? "PENDING"}`;
  else if (execution?.reviewer_selection) {
    const selected: ReviewerSelection = execution.reviewer_selection;
    const review = selected.kind === "terra" ? execution.terra_review : execution.sol_review;
    codeReview = `${reviewerLabel(selected)} · ${review.verdict ?? "pending"} · ${review.rounds} round(s)`;
  }
  return [
    `Code review   ${codeReview}`,
    `Verification  ${execution?.verification.passed ? "passed" : "pending"}`,
    `Result Bundle ${result ? "ready" : "pending"}`,
    `Web final     ${snapshot.web_review_state ?? "pending"}`,
    `Published     ${result?.published_commit_sha ? "exact commit verified" : "pending"}`,
    `Draft PR      ${result?.pull_request?.url ?? "pending"}`,
  ].join("\n");
}

function configSummary(config: TrustedConfig, repositoryId: string, reviewer: ReviewerSelection): string {
  const mode = config.web_bridge?.mode ?? "manual_file";
  const chatgpt = mode === "web_native_mcp"
    ? "local WCO MCP · official outbound OpenAI tunnel"
    : mode === "managed_actions"
      ? "optional managed compatibility"
      : mode === "personal_actions" || mode === "actions_relay"
        ? "optional relay compatibility"
        : "offline/manual";
  return [
    `Repository    ${repositoryId}`,
    `Web bridge    ${mode}`,
    `ChatGPT Web   ${chatgpt}`,
    `AUTOPILOT review ${reviewerLabel(reviewer)}`,
    "Final review  original ChatGPT Web · required",
    "",
    "Normal architecture: repository, Harness, receipts, cache and MCP mailbox stay on this machine.",
    "Normal Web setup: `wco web connect` configures the official OpenAI local transport once; daily tasks require no browser interaction.",
    "PAIR does not use the selected model reviewer.",
    "Optional compatibility only: `wco web connect --managed`, `wco web setup --personal`, `--self-hosted`, manual_file.",
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
    io.write("Welcome to WCO\n\n");
    // Running `wco` in a repository is consent to register that repository.
    // Keep first-run friction focused on the external OpenAI authorization/setup
    // that WCO cannot perform without the user's account permissions.
    const code = await runSetupCommand(["--yes"], process.cwd(), { write: (value) => io.write(value), error: (value) => io.write(value), question: async (prompt) => await io.question(prompt) });
    if (code !== 0) return code;
  }

  let config = await loadTrustedConfig(paths.config);
  const detected = await detectRepository(process.cwd());
  const root = await realpath(detected.root);
  const registration = Object.entries(config.repositories).find(([, value]) => value.path === root || value.path.toLowerCase() === root.toLowerCase());
  if (!registration) {
    io.write("This repository is not registered in the trusted WCO config. Run `wco setup` here.\n");
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
    try { bridge = createConfiguredWebBridge(config, paths.bridge); }
    catch { bridge = null; }
  };
  await reloadBridge();

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
    if (await connectionWorks()) { if (isNative()) await ensureNativeTunnel(); return true; }
    if (config.web_bridge?.mode === "manual_file") return false;
    if (isNative()) {
      const code = await runWebCommand(["connect"], webIo);
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
    const answer = (await io.question(personal ? "Optional personal relay is not connected. Configure it? [y/N] " : "Optional Web profile is disconnected. Configure it? [y/N] ")).trim();
    if (!/^y(es)?$/i.test(answer)) return false;
    const code = await runWebCommand(personal ? ["setup", "--personal"] : ["connect", "--self-hosted"], webIo);
    if (code !== 0) return false;
    await reloadBridge(); return await connectionWorks();
  };
  const openWebArchitect = async (): Promise<void> => {
    const code = await runWebCommand(["open"], webIo);
    if (code !== 0) throw new Error("WEB_GPT_OPEN_FAILED: the configured optional Senior Architect GPT could not be opened.");
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
    io.write(`ChatGPT Web ${purpose === "author" ? "authoring" : "review"} queued through the official local tunnel. Waiting for exact MCP evidence…\n`);
    return guard;
  };
  const assertNativeOutputStillPossible = async (identity: string, output: "implementation" | "verdict"): Promise<void> => {
    if (!isNative()) return;
    const guard = nativeRuns.get(identity);
    if (!guard) return;
    const status = await guard.assertCanStillComplete();
    if (status === "completed") {
      throw new WebBridgeError("WEB_NATIVE_AGENT_INCOMPLETE", `The native Workspace Agent turn completed without submitting the required WCO ${output}.`);
    }
  };

  const waitForImplementation = async (): Promise<LocalWorkerSession> => {
    if (!latest) throw new Error("No active Web authoring session.");
    if (!bridge) throw new Error("WCO Web bridge is not connected.");
    const poll = Math.max(250, Math.min(config.web_bridge?.poll_interval_ms ?? 1_000, 10_000));
    io.write("Waiting for ChatGPT Web to inspect the exact base, seal the contract, and submit implementation authority…\n");
    while (latest.state !== "IMPLEMENTATION_REGISTERED") {
      latest = await advanceLocalWorker({ bridge, session: latest, repositoryPath: repositoryConfig.path, stateDirectory: paths.state, configPath: paths.config, config });
      if (latest.state === "IMPLEMENTATION_REGISTERED") break;
      if (latest.state === "BLOCKED") throw new Error("Web authoring is blocked. Use /status for details.");
      if (latest.job_id) await assertNativeOutputStillPossible(latest.job_id, "implementation");
      await sleep(poll);
    }
    return latest;
  };

  const continuePairWorkflow = async (): Promise<string> => {
    if (!latest?.run_id || !latest.web_pack_path || latest.state !== "IMPLEMENTATION_REGISTERED") return `Workflow is waiting at ${latest?.state ?? "NO_TASK"}.`;
    if (!bridge) throw new Error("WCO Web bridge is not connected.");
    const runId = latest.run_id;
    try {
      await drivePairHarnessToCodeReview({ runId, webPackPath: latest.web_pack_path, stateDirectory: paths.state, configPath: paths.config });
    } catch (error) {
      return `PAIR Harness stopped safely: ${error instanceof Error ? error.message : String(error)}\nNo model reviewer or merge action was started.`;
    }
    let code = 0;

    for (let round = 0; round < MAX_WEB_REVIEW_ROUNDS; round += 1) {
      let snapshot = await readLifecycleSnapshot(paths.state, runId);
      if (pairSessionCanComplete(snapshot)) {
        await completeLocalWorkerSession({ session: latest, stateDirectory: paths.state });
        const result = await resultReceipt(runId, paths.state);
        return `PAIR · READY FOR YOU\nDraft PR      ${result?.pull_request?.url ?? "ready"}\nVerification  passed\nCode review   approved\nWeb final     approved\nAction        review and merge when ready`;
      }
      if (snapshot.web_review_state === "ESCALATED") return "PAIR · NEEDS YOU\nChatGPT Web final review escalated a consequential decision. No merge action was taken.";

      if (snapshot.web_review_state === "REVISION_REQUESTED") {
        code = await runControlCommand("continue", ["--run-id", runId, "--state-dir", paths.state, "--config", paths.config, "--max-transitions", "8"], { stdout: () => undefined, stderr: () => undefined });
        if (code !== 0) return `Revision stopped safely with exit ${code}. Use /doctor and /review, then retry /run.`;
        snapshot = await readLifecycleSnapshot(paths.state, runId);
        if (snapshot.web_review_state === "ESCALATED") return "PAIR · NEEDS YOU\nChatGPT Web final review escalated a consequential decision. No merge action was taken.";
        if (pairSessionCanComplete(snapshot)) continue;
      }

      const review = await createPendingFinalReview({ bridge, runId, stateDirectory: paths.state });
      const reviewLabel = review.purpose === "independent_code_review" ? "independent ChatGPT Web code review" : "original ChatGPT Web final intent review";
      if (isNative()) await triggerNativeTurn(review.purpose, review.job_id);
      else if (!isManaged()) await openWebArchitect();
      io.write(`Waiting for ${reviewLabel}${round > 0 ? ` · round ${round + 1}` : ""}…\n`);
      const poll = Math.max(250, Math.min(config.web_bridge?.poll_interval_ms ?? 1_000, 10_000));
      let verdict = await bridge.waitForVerdict(review.job_id);
      while (!verdict) {
        await assertNativeOutputStillPossible(review.job_id, "verdict");
        await sleep(poll);
        verdict = await bridge.waitForVerdict(review.job_id);
      }
      const adopted = await materializeAndSubmitWebVerdict({ envelope: verdict, stateDirectory: paths.state, configPath: paths.config });
      io.write(`${reviewLabel}: ${adopted.receipt.state}\n`);
      code = await runControlCommand("continue", ["--run-id", runId, "--state-dir", paths.state, "--config", paths.config, "--max-transitions", "8"], { stdout: () => undefined, stderr: () => undefined });
      if (code !== 0) return `Workflow stopped safely with exit ${code}. Use /doctor, then retry /run.`;
    }

    return "PAIR · NEEDS YOU\nThe Web review round budget was exhausted without a terminal approval. No merge action was taken.";
  };

  const driveAutopilotForUser = async (): Promise<string> => {
    if (!latest?.run_id || !latest.web_pack_path || latest.state !== "IMPLEMENTATION_REGISTERED") return "AUTOPILOT is waiting for Web implementation authority.";
    if (!bridge) throw new Error("WCO Web bridge is not connected.");
    const controller = new AbortController(); const interrupt = (): void => controller.abort(); process.once("SIGINT", interrupt);
    try {
      const interactiveBridge = withFinalReviewNotification(
        bridge,
        async (reviewId) => {
          io.write("AUTOPILOT is ready for final review.\n");
          if (isNative()) await triggerNativeTurn("final_intent_review", reviewId);
          else if (!isManaged()) await openWebArchitect();
          io.write("Waiting for original ChatGPT Web final intent review…\n");
        },
        isNative() ? async (reviewId) => await assertNativeOutputStillPossible(reviewId, "verdict") : undefined,
      );
      const receipt = await driveAutopilotJob({ bridge: interactiveBridge, runId: latest.run_id, stateDirectory: paths.state, configPath: paths.config, webPackPath: latest.web_pack_path, signal: controller.signal, ...(config.web_bridge?.poll_interval_ms !== undefined ? { pollIntervalMs: config.web_bridge.poll_interval_ms } : {}) });
      if (receipt.status === "READY_FOR_YOU") await completeLocalWorkerSession({ session: latest, stateDirectory: paths.state });
      const result = await resultReceipt(receipt.run_id, paths.state);
      return formatAutopilotOutcome(receipt, result?.pull_request?.url ?? null);
    } catch (error) {
      return ["AUTOPILOT could not continue safely.", error instanceof Error ? error.message : String(error), "No merge action was taken. Use /doctor and /review before retrying /run."].join("\n");
    } finally { process.removeListener("SIGINT", interrupt); }
  };

  const startAndDriveTask = async (goal: string, replaceExplicit = false, mode: JobMode = "PAIR"): Promise<string> => {
    if (!await ensureWebConnected()) return "Task was not started because the configured Web transport is unavailable. Run /web connect when ready.";
    if (!bridge) throw new Error("WCO Web bridge is not connected.");
    const selectedReviewer = await readReviewMode(paths.state);
    latest = await startLocalAuthoring({ bridge, repository: { repository_id: repositoryId, base_branch: detected.base_branch, base_commit: detected.base_commit }, goal, stateDirectory: paths.state, replaceExplicit, mode });
    io.write("Task registered locally with WCO.\n");
    if (mode === "AUTOPILOT") io.write(`Reviewer: ${reviewerLabel(selectedReviewer)}\n`);
    if (isNative()) await triggerNativeTurn("author", latest.job_id!);
    else if (isManaged()) io.write("Optional managed ChatGPT Web authoring started automatically.\n");
    else { io.write("Opening optional WCO Senior Architect...\n"); await openWebArchitect(); }
    await waitForImplementation();
    io.write("Web implementation accepted. Starting verification and review…\n");
    return mode === "AUTOPILOT" ? await driveAutopilotForUser() : await continuePairWorkflow();
  };

  const displayUserStatus = async (session: LocalWorkerSession | null): Promise<string> => {
    if (!session) return "READY";
    if (localWorkerJobMode(session) !== "AUTOPILOT") return deriveUserStage(session);
    if (!session.run_id) return `AUTOPILOT · ${deriveUserStage(session) === "READY" ? "WEB_RESEARCH" : deriveUserStage(session)}`;
    try { return formatAutopilotStatus(await readAutopilotReceipt(paths.state, session.run_id)); }
    catch { return "AUTOPILOT · NEEDS_YOU"; }
  };

  if (firstRun && isNative()) {
    io.write("One-time OpenAI/ChatGPT local transport setup is required. WCO itself remains local and will not deploy a server, relay, domain or public endpoint.\n");
    const code = await runWebCommand(["connect"], webIo);
    if (code !== 0) return code;
    await reloadBridge();
    await ensureNativeTunnel();
  }

  try {
    await runInteractiveSession(io, {
      state: async () => {
        latest = await readLocalWorkerSession(paths.state, repositoryId);
        return { active: Boolean(latest && !["BLOCKED", "COMPLETED"].includes(latest.state)), sealed: latest?.sealed ?? false, summary: `WCO · ${repositoryId}\nRepository   ${detected.base_branch}@${detected.base_commit.slice(0, 7)}\nStatus       ${await displayUserStatus(latest)}${latest ? `\nTask         ${latest.goal}` : ""}` };
      },
      newTask: async (goal) => await startAndDriveTask(goal),
      clarify: async (value) => {
        if (!latest) return "No active task. Enter a goal to start one.";
        const connectedBridge = bridge; if (!connectedBridge) return "WCO Web bridge is not connected.";
        await appendLocalClarification({ bridge: connectedBridge, session: latest, value, stateDirectory: paths.state }); return "Clarification recorded before contract sealing.";
      },
      command: async (command, args) => {
        if (command === "/quit") return { message: "Goodbye.", quit: true };
        if (command === "/help") return { message: commandPalette() };
        if (command === "/new") { if (!args) return { message: "Usage: /new <goal>" }; return { message: await startAndDriveTask(args, true, "PAIR") }; }
        if (command === "/auto") { if (!args) return { message: "Usage: /auto <goal>" }; return { message: await startAndDriveTask(args, true, "AUTOPILOT") }; }
        if (command === "/mode") {
          const current = await readReviewMode(paths.state);
          if (!args) return { message: `AUTOPILOT reviewer: ${reviewerLabel(current)}\nFinal review: original ChatGPT Web · required\nUsage: /mode <sol|terra> <minimal|low|medium|high|xhigh>` };
          if (latest && localWorkerJobMode(latest) === "AUTOPILOT" && !["BLOCKED", "COMPLETED"].includes(latest.state)) return { message: `AUTOPILOT reviewer is frozen for the active task (${reviewerLabel(current)}). Finish it before changing /mode.` };
          const values = args.split(/\s+/u).filter(Boolean);
          if (values.length !== 2) return { message: "Usage: /mode <sol|terra> <minimal|low|medium|high|xhigh>" };
          try { const selected = parseReviewerSelection(values[0]!, values[1]!); await writeReviewMode(paths.state, selected); return { message: `AUTOPILOT reviewer: ${reviewerLabel(selected)}. Applies to new AUTOPILOT tasks.` }; }
          catch (error) { return { message: error instanceof Error ? error.message : String(error) }; }
        }
        if (command === "/task") {
          if (!latest) return { message: "No active task." };
          const mode = localWorkerJobMode(latest); return { message: mode === "AUTOPILOT" ? `Goal: ${latest.goal}\nMode: AUTOPILOT\nContract: ${latest.sealed ? "sealed" : "open"}` : `Goal: ${latest.goal}\nContract: ${latest.sealed ? "sealed" : "open"}` };
        }
        if (command === "/web") { const webArgs = args ? args.split(/\s+/u).filter(Boolean) : ["status"]; const code = await runWebCommand(webArgs, webIo); await reloadBridge(); return { message: `Web command finished with exit ${code}.` }; }
        if (command === "/doctor") {
          const lines: string[] = [];
          const doctorMode = latest ? localWorkerJobMode(latest) : "PAIR";
          const code = await runControlCommand("doctor", ["--state-dir", paths.state, "--config", paths.config, "--mode", doctorMode], { stdout: (value) => lines.push(value), stderr: (value) => lines.push(value) });
          return { message: `${lines.join("\n")}\nMode: ${doctorMode}\nDoctor exit: ${code}` };
        }
        if (command === "/status") {
          if (!latest) return { message: "No active run." };
          const status = await displayUserStatus(latest); return { message: localWorkerJobMode(latest) === "AUTOPILOT" ? `Status: ${status}\nGoal: ${latest.goal}\nMode: AUTOPILOT\nContract: ${latest.sealed ? "sealed" : "open"}` : `Status: ${status}\nGoal: ${latest.goal}\nContract: ${latest.sealed ? "sealed" : "open"}` };
        }
        if (command === "/review") return { message: latest?.run_id ? await reviewSummary(latest.run_id, paths.state) : "No active run." };
        if (command === "/pause" || command === "/resume") {
          if (!latest?.run_id) return { message: "No prepared run to pause/resume." };
          const code = await runControlCommand(command.slice(1), ["--run-id", latest.run_id, "--state-dir", paths.state], { stdout: () => undefined, stderr: () => undefined }); return { message: code === 0 ? `Workflow ${command === "/pause" ? "paused" : "resumed"} safely.` : `${command === "/pause" ? "Pause" : "Resume"} failed safely with exit ${code}.` };
        }
        if (command === "/run") {
          if (!latest) return { message: "Enter a task goal first." };
          if (latest.state === "COMPLETED") return { message: "Current task is complete. Enter a new goal or use /new <goal>." };
          if (!await ensureWebConnected()) return { message: "WCO Web transport is unavailable." };
          if (latest.state !== "IMPLEMENTATION_REGISTERED") {
            if (isNative()) await triggerNativeTurn("author", latest.job_id ?? latest.session_id);
            else if (!isManaged()) await openWebArchitect();
            await waitForImplementation();
          }
          return { message: localWorkerJobMode(latest) === "AUTOPILOT" ? await driveAutopilotForUser() : await continuePairWorkflow() };
        }
        if (command === "/uninstall") {
          const answer = (await io.question("Remove WCO-owned local data and uninstall WCO? Your repositories/branches/PRs will be preserved. [y/N] ")).trim();
          if (!/^y(es)?$/i.test(answer)) return { message: "Uninstall cancelled." };
          const code = await runUninstallCommand(["--purge", "--yes"]); return { message: code === 0 ? "WCO uninstall scheduled/completed. Goodbye." : `Uninstall failed with exit ${code}.`, quit: code === 0 };
        }
        if (command === "/config") {
          if (args === "web") { const code = await runWebCommand(["connect"], webIo); await reloadBridge(); return { message: code === 0 ? configSummary(config, repositoryId, await readReviewMode(paths.state)) : `Web configuration failed with exit ${code}.` }; }
          return { message: configSummary(config, repositoryId, await readReviewMode(paths.state)) };
        }
        if (command === "/history") {
          const previous = await listLocalTaskHistory(paths.state, repositoryId, 10); const entries = [...(latest ? [latest] : []), ...previous].slice(0, 10);
          return { message: entries.length ? entries.map((item, index) => `${index + 1}. ${item.goal}\n   ${item.state}${localWorkerJobMode(item) === "AUTOPILOT" ? " · AUTOPILOT" : ""} · ${item.updated_at}`).join("\n") : "No task history for this repository." };
        }
        return { message: `Unknown command '${command}'. Type / for the command palette.` };
      },
    });
  } finally { await stopNativeTunnel(nativeTunnel).catch(() => undefined); }
  return 0;
}
