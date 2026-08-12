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
import { createPendingFinalReview } from "../web-bridge/final-review-service.js";
import { materializeAndSubmitWebVerdict } from "../web-bridge/verdict-materializer.js";
import { runWebCommand } from "../web-bridge/web-cli.js";
import type { WebBridge } from "../web-bridge/web-bridge.js";
import { listLocalTaskHistory } from "../web-bridge/session-history.js";
import { ManagedWebOnboardingClient } from "../web-bridge/managed-onboarding.js";
import { resolveManagedWebService } from "../web-bridge/managed-service.js";
import { writeTrustedConfigAtomic } from "../setup/config-writer.js";
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
  return [
    `Repository    ${repositoryId}`,
    `Web bridge    ${config.web_bridge?.mode ?? "manual_file"}`,
    `ChatGPT Web   ${config.web_bridge?.mode === "managed_actions" ? "managed OAuth" : config.web_bridge?.mode === "personal_actions" || config.web_bridge?.mode === "actions_relay" ? "personal Bearer" : "offline/manual"}`,
    `AUTOPILOT review ${reviewerLabel(reviewer)}`,
    "Final review  original ChatGPT Web · required",
    "",
    "Change AUTOPILOT reviewer with `/mode <sol|terra> <minimal|low|medium|high|xhigh>`.",
    "PAIR does not use the selected model reviewer.",
    "Set up the default personal profile with `wco web setup --personal`.",
    "Managed OAuth remains available through `/web connect`; legacy bearer config through `/web connect --self-hosted`.",
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
    const code = await runSetupCommand([], process.cwd(), { write: (value) => io.write(value), error: (value) => io.write(value), question: async (prompt) => await io.question(prompt) });
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

  const connectionWorks = async (): Promise<boolean> => {
    if (!bridge || config.web_bridge?.mode === "manual_file") return false;
    try { return (await bridge.getConnectionStatus()).connected; } catch { return false; }
  };
  const managedServiceAvailable = async (): Promise<boolean> => {
    try { const metadata = resolveManagedWebService(); await new ManagedWebOnboardingClient({ metadata, credentialsDirectory: paths.credentials }).probeService(); return true; }
    catch { return false; }
  };
  const ensureWebConnected = async (): Promise<boolean> => {
    if (await connectionWorks()) return true;
    if (config.web_bridge?.mode === "manual_file") return false;
    const personal = config.web_bridge?.mode === "personal_actions" || config.web_bridge?.mode === "actions_relay";
    const answer = (await io.question(personal ? "Personal Web transport is not connected. Open setup instructions? [Y/n] " : "Connect managed ChatGPT Web? [Y/n] ")).trim();
    if (answer && !/^y(es)?$/i.test(answer)) return false;
    if (personal) { io.write("Run `wco web setup --personal` after authorizing or deploying a RelayProtocol-compatible HTTPS endpoint.\n"); return false; }
    const code = await runWebCommand(["connect"], webIo);
    if (code !== 0) return false;
    await reloadBridge();
    return await connectionWorks();
  };
  const openWebArchitect = async (): Promise<void> => {
    const code = await runWebCommand(["open"], webIo);
    if (code !== 0) throw new Error("WEB_GPT_OPEN_FAILED: the configured Senior Architect GPT could not be opened.");
  };

  const waitForImplementation = async (): Promise<LocalWorkerSession> => {
    if (!latest) throw new Error("No active Web authoring session.");
    if (!bridge) throw new Error("WCO Relay is not connected.");
    const poll = Math.max(250, Math.min(config.web_bridge?.poll_interval_ms ?? 1_000, 10_000));
    io.write("Waiting for ChatGPT Web to inspect the exact base, seal the contract, and submit implementation authority…\n");
    while (latest.state !== "IMPLEMENTATION_REGISTERED") {
      latest = await advanceLocalWorker({ bridge, session: latest, repositoryPath: repositoryConfig.path, stateDirectory: paths.state, configPath: paths.config, config });
      if (latest.state === "IMPLEMENTATION_REGISTERED") break;
      if (latest.state === "BLOCKED") throw new Error("Web authoring is blocked. Use /status for details.");
      await sleep(poll);
    }
    return latest;
  };

  const continuePairWorkflow = async (): Promise<string> => {
    if (!latest?.run_id || !latest.web_pack_path || latest.state !== "IMPLEMENTATION_REGISTERED") return `Workflow is waiting at ${latest?.state ?? "NO_TASK"}.`;
    if (!bridge) throw new Error("WCO Relay is not connected.");
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
      await openWebArchitect();
      const reviewLabel = review.purpose === "independent_code_review" ? "independent ChatGPT Web code review" : "original ChatGPT Web final intent review";
      io.write(`Waiting for ${reviewLabel}${round > 0 ? ` · round ${round + 1}` : ""}…\n`);
      const poll = Math.max(250, Math.min(config.web_bridge?.poll_interval_ms ?? 1_000, 10_000));
      let verdict = await bridge.waitForVerdict(review.job_id);
      while (!verdict) { await sleep(poll); verdict = await bridge.waitForVerdict(review.job_id); }
      const adopted = await materializeAndSubmitWebVerdict({ envelope: verdict, stateDirectory: paths.state, configPath: paths.config });
      io.write(`${reviewLabel}: ${adopted.receipt.state}\n`);
      code = await runControlCommand("continue", ["--run-id", runId, "--state-dir", paths.state, "--config", paths.config, "--max-transitions", "8"], { stdout: () => undefined, stderr: () => undefined });
      if (code !== 0) return `Workflow stopped safely with exit ${code}. Use /doctor, then retry /run.`;
    }

    return "PAIR · NEEDS YOU\nThe Web review round budget was exhausted without a terminal approval. No merge action was taken.";
  };

  const driveAutopilotForUser = async (): Promise<string> => {
    if (!latest?.run_id || !latest.web_pack_path || latest.state !== "IMPLEMENTATION_REGISTERED") return "AUTOPILOT is waiting for Web implementation authority.";
    if (!bridge) throw new Error("WCO Relay is not connected.");
    const controller = new AbortController(); const interrupt = (): void => controller.abort(); process.once("SIGINT", interrupt);
    try {
      const interactiveBridge = withFinalReviewNotification(bridge, async () => {
        io.write("AUTOPILOT is ready for final review.\n");
        try { await openWebArchitect(); io.write("Waiting for original ChatGPT Web final intent review…\n"); }
        catch { io.write("Final review remains pending. Open the configured Senior Architect GPT manually, or run `wco web open` in another terminal.\n"); }
      });
      const receipt = await driveAutopilotJob({ bridge: interactiveBridge, runId: latest.run_id, stateDirectory: paths.state, configPath: paths.config, webPackPath: latest.web_pack_path, signal: controller.signal, ...(config.web_bridge?.poll_interval_ms !== undefined ? { pollIntervalMs: config.web_bridge.poll_interval_ms } : {}) });
      if (receipt.status === "READY_FOR_YOU") await completeLocalWorkerSession({ session: latest, stateDirectory: paths.state });
      const result = await resultReceipt(receipt.run_id, paths.state);
      return formatAutopilotOutcome(receipt, result?.pull_request?.url ?? null);
    } catch (error) {
      return ["AUTOPILOT could not continue safely.", error instanceof Error ? error.message : String(error), "No merge action was taken. Use /doctor and /review before retrying /run."].join("\n");
    } finally { process.removeListener("SIGINT", interrupt); }
  };

  const startAndDriveTask = async (goal: string, replaceExplicit = false, mode: JobMode = "PAIR"): Promise<string> => {
    if (!await ensureWebConnected()) return "Task was not started because the Web Architect is not connected. Use /web connect when ready.";
    if (!bridge) throw new Error("WCO Relay is not connected.");
    const selectedReviewer = await readReviewMode(paths.state);
    latest = await startLocalAuthoring({ bridge, repository: { repository_id: repositoryId, base_branch: detected.base_branch, base_commit: detected.base_commit }, goal, stateDirectory: paths.state, replaceExplicit, mode });
    io.write("Task sent securely to WCO Web.\n");
    if (mode === "AUTOPILOT") io.write(`Reviewer: ${reviewerLabel(selectedReviewer)}\n`);
    io.write("Opening WCO Senior Architect...\n"); await openWebArchitect(); io.write("In ChatGPT Web, click “Start my pending WCO task”. No ZIP/download handoff is required.\n");
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

  if (firstRun) {
    const choice = (await io.question("Web transport [Personal/Managed/Manual] (Personal): ")).trim().toLowerCase();
    const selected = !choice || choice === "p" || choice === "personal" ? "personal_actions" : choice === "m" || choice === "managed" ? "managed_actions" : choice === "manual" || choice === "file" || choice === "offline" ? "manual_file" : null;
    if (!selected) io.write("Unknown transport choice; keeping recommended personal_actions.\n");
    else if (selected !== config.web_bridge?.mode) {
      await writeTrustedConfigAtomic(paths.config, { ...config, web_bridge: { mode: selected, poll_interval_ms: config.web_bridge?.poll_interval_ms ?? 1_000, job_ttl_seconds: config.web_bridge?.job_ttl_seconds ?? 86_400 } }, { overwrite: true });
      await reloadBridge();
    }
    if ((selected ?? "personal_actions") === "personal_actions") io.write("Personal is recommended. Run `wco web setup --personal` after authorizing a compatible free relay provider; no OAuth or managed account is required.\n");
    else if ((selected ?? "personal_actions") === "managed_actions") {
      if (await managedServiceAvailable()) { const answer = (await io.question("Connect managed ChatGPT Web? [Y/n] ")).trim(); if (!answer || /^y(es)?$/i.test(answer)) { await runWebCommand(["connect"], webIo); await reloadBridge(); } else io.write("Managed ChatGPT Web is not connected. The TUI remains available; use `/web connect` later.\n"); }
      else io.write("! Managed WCO Relay deployment required. Personal and manual profiles remain independent.\n");
    } else io.write("Manual/offline Web transport selected. No relay or Internet connection is required.\n");
  } else if (!await connectionWorks() && config.web_bridge?.mode === "managed_actions" && await managedServiceAvailable()) {
    const answer = (await io.question("WCO connection expired or was revoked. Reconnect ChatGPT Web? [Y/n] ")).trim();
    if (!answer || /^y(es)?$/i.test(answer)) { await runWebCommand(["connect"], webIo); await reloadBridge(); }
  }

  await runInteractiveSession(io, {
    state: async () => {
      latest = await readLocalWorkerSession(paths.state, repositoryId);
      return { active: Boolean(latest && !["BLOCKED", "COMPLETED"].includes(latest.state)), sealed: latest?.sealed ?? false, summary: `WCO · ${repositoryId}\nRepository   ${detected.base_branch}@${detected.base_commit.slice(0, 7)}\nStatus       ${await displayUserStatus(latest)}${latest ? `\nTask         ${latest.goal}` : ""}` };
    },
    newTask: async (goal) => await startAndDriveTask(goal),
    clarify: async (value) => {
      if (!latest) return "No active task. Enter a goal to start one.";
      const connectedBridge = bridge; if (!connectedBridge) return "WCO Relay is not connected.";
      await appendLocalClarification({ bridge: connectedBridge, session: latest, value, stateDirectory: paths.state }); return "Clarification sent before contract sealing.";
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
        if (localWorkerJobMode(latest) === "AUTOPILOT") {
          if (!await ensureWebConnected()) return { message: "Web Architect is not connected." };
          if (latest.state !== "IMPLEMENTATION_REGISTERED") { await openWebArchitect(); await waitForImplementation(); }
          return { message: await driveAutopilotForUser() };
        }
        if (latest.state === "COMPLETED") return { message: "Current task is complete. Enter a new goal or use /new <goal>." };
        if (!await ensureWebConnected()) return { message: "Web Architect is not connected." };
        if (latest.state !== "IMPLEMENTATION_REGISTERED") { await openWebArchitect(); await waitForImplementation(); }
        return { message: await continuePairWorkflow() };
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
  return 0;
}
