import { access, realpath } from "node:fs/promises";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";
import { readExecutionReceipt } from "../execution/execution-store.js";
import { runControlCommand } from "../orchestration/control-cli.js";
import { readResultBundleReceipt } from "../result-bundle/result-bundle-store.js";
import { resultBundlePaths } from "../result-bundle/result-bundle-paths.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { detectRepository } from "../setup/repository-detect.js";
import { runSetupCommand } from "../setup/setup-cli.js";
import { runUninstallCommand } from "../uninstall/uninstall-cli.js";
import { advanceLocalWorker, appendLocalClarification, readLocalWorkerSession, startLocalAuthoring, type LocalWorkerSession } from "../web-bridge/local-worker.js";
import { createConfiguredWebBridge } from "../web-bridge/bridge-factory.js";
import { runWebCommand } from "../web-bridge/web-cli.js";
import { createPendingFinalReview } from "../web-bridge/final-review-service.js";
import { materializeAndSubmitWebVerdict } from "../web-bridge/verdict-materializer.js";
import type { WebBridge } from "../web-bridge/web-bridge.js";
import { listLocalTaskHistory } from "../web-bridge/session-history.js";
import { commandPalette } from "./slash-commands.js";
import { deriveUserStage } from "./stages.js";
import { runInteractiveSession, terminalIo, type InteractiveIo } from "./session.js";

const sleep = async (milliseconds: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, milliseconds));

function splitRunId(runId: string): { taskId: string; archiveSha: string } | null {
  const index = runId.lastIndexOf(":");
  const taskId = runId.slice(0, index), archiveSha = runId.slice(index + 1);
  return index > 0 && /^[a-f0-9]{64}$/.test(archiveSha) ? { taskId, archiveSha } : null;
}

async function reviewSummary(runId: string, stateDirectory: string): Promise<string> {
  const identity = splitRunId(runId);
  if (!identity) return "Current run identity is invalid.";
  const execution = await readExecutionReceipt(stateDirectory, identity.taskId, identity.archiveSha);
  const result = await readResultBundleReceipt(resultBundlePaths(stateDirectory, identity.taskId, identity.archiveSha).receiptPath);
  const lines = [
    `Run           ${runId}`,
    `Terra         ${execution?.internal_reviewer.verdict ?? "pending"}${execution ? ` · ${execution.internal_reviewer.rounds} round(s)` : ""}`,
    `Sol           ${execution?.final_reviewer.verdict ?? "pending"}${execution ? ` · ${execution.final_reviewer.rounds} round(s)` : ""}`,
    `Result Bundle ${result?.archive_sha256 ?? "pending"}`,
    `Published     ${result?.published_commit_sha ?? "pending"}`,
    `Draft PR      ${result?.pull_request?.url ?? "pending"}`,
  ];
  return lines.join("\n");
}

function configSummary(config: TrustedConfig, paths: ReturnType<typeof resolveWcoPaths>, repositoryId: string): string {
  return [
    `Repository    ${repositoryId}`,
    `Web bridge    ${config.web_bridge?.mode ?? "manual_file"}`,
    `Web GPT       ${config.web_bridge?.gpt_url ?? "not connected"}`,
    `Implementer   ${config.agents?.implementer.model ?? "default"} · ${config.agents?.implementer.reasoning_effort ?? "default"}`,
    `Review        ${config.agents?.internal_reviewer.model ?? "default"} → ${config.agents?.final_reviewer.model ?? "default"}`,
    `Config        ${paths.config}`,
    `State         ${paths.state}`,
    "",
    "Change Web connection with `/config web` or `/web connect`.",
  ].join("\n");
}

export async function runInteractiveApp(io: InteractiveIo = terminalIo()): Promise<number> {
  const paths = resolveWcoPaths({});
  try { await access(paths.config); }
  catch {
    io.write("First-time setup\n");
    const code = await runSetupCommand([], process.cwd());
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
  let bridge: WebBridge = createConfiguredWebBridge(config, paths.bridge);
  let latest = await readLocalWorkerSession(paths.state, repositoryId);
  const webIo = { write: (value: string) => io.write(value), error: (value: string) => io.write(value), question: async (prompt: string) => await io.question(prompt) };

  const reloadBridge = async (): Promise<void> => {
    config = await loadTrustedConfig(paths.config);
    bridge = createConfiguredWebBridge(config, paths.bridge);
  };

  const ensureWebConnected = async (): Promise<boolean> => {
    if (config.web_bridge?.mode === "actions_relay") {
      try { if ((await bridge.getConnectionStatus()).connected) return true; }
      catch { /* offer reconnect below */ }
    }
    const answer = (await io.question("ChatGPT Web is not connected. Connect the WCO Senior Architect now? [Y/n] ")).trim();
    if (answer && !/^y(es)?$/i.test(answer)) return false;
    const code = await runWebCommand(["connect"], webIo);
    if (code !== 0) return false;
    await reloadBridge();
    return true;
  };

  const openWebArchitect = async (): Promise<void> => {
    const code = await runWebCommand(["open"], webIo);
    if (code !== 0) throw new Error("WEB_GPT_OPEN_FAILED: the configured Senior Architect GPT could not be opened.");
  };

  const waitForImplementation = async (): Promise<LocalWorkerSession> => {
    if (!latest) throw new Error("No active Web authoring session.");
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

  const continueThroughFinalReview = async (): Promise<string> => {
    if (!latest?.run_id || latest.state !== "IMPLEMENTATION_REGISTERED") return `Workflow is waiting at ${latest?.state ?? "NO_TASK"}.`;
    const lines: string[] = [];
    let code = await runControlCommand("continue", ["--run-id", latest.run_id, "--state-dir", paths.state, "--config", paths.config, "--max-transitions", "8"], { stdout: (value) => { lines.push(value); io.write(`${value}\n`); }, stderr: (value) => { lines.push(value); io.write(`${value}\n`); } });
    try {
      const review = await createPendingFinalReview({ bridge, runId: latest.run_id, stateDirectory: paths.state });
      await openWebArchitect();
      io.write("Waiting for ChatGPT Web final review…\n");
      const poll = Math.max(250, Math.min(config.web_bridge?.poll_interval_ms ?? 1_000, 10_000));
      let verdict = await bridge.waitForVerdict(review.job_id);
      while (!verdict) { await sleep(poll); verdict = await bridge.waitForVerdict(review.job_id); }
      const adopted = await materializeAndSubmitWebVerdict({ envelope: verdict, stateDirectory: paths.state, configPath: paths.config });
      lines.push(`Web final review: ${adopted.receipt.state}`);
      io.write(`Web final review: ${adopted.receipt.state}\n`);
      code = await runControlCommand("continue", ["--run-id", latest.run_id, "--state-dir", paths.state, "--config", paths.config, "--max-transitions", "8"], { stdout: (value) => { lines.push(value); io.write(`${value}\n`); }, stderr: (value) => { lines.push(value); io.write(`${value}\n`); } });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("not ready")) throw error;
    }
    return `${lines.join("\n")}\nWorkflow exit: ${code}`;
  };

  const startAndDriveTask = async (goal: string, replaceExplicit = false): Promise<string> => {
    if (!await ensureWebConnected()) return "Task was not started because the Web Architect is not connected. Use /web connect when ready.";
    latest = await startLocalAuthoring({ bridge, repository: { repository_id: repositoryId, base_branch: detected.base_branch, base_commit: detected.base_commit }, goal, stateDirectory: paths.state, replaceExplicit });
    io.write(`Web authoring job created: ${latest.job_id}\n`);
    await openWebArchitect();
    io.write("In ChatGPT Web, click “Start my pending WCO task”. No ZIP/download handoff is required.\n");
    await waitForImplementation();
    io.write("Web contract and implementation authority were accepted locally. Starting WCO execution…\n");
    return await continueThroughFinalReview();
  };

  await runInteractiveSession(io, {
    state: async () => {
      latest = await readLocalWorkerSession(paths.state, repositoryId);
      return {
        active: Boolean(latest && latest.state !== "BLOCKED"),
        sealed: latest?.sealed ?? false,
        summary: `WCO · ${repositoryId}\nRepository   ${detected.base_branch}@${detected.base_commit.slice(0, 7)}\nStatus       ${deriveUserStage(latest)}${latest ? `\nTask         ${latest.goal}` : ""}`,
      };
    },
    newTask: async (goal) => await startAndDriveTask(goal),
    clarify: async (value) => {
      if (!latest) return "No active task. Enter a goal to start one.";
      await appendLocalClarification({ bridge, session: latest, value, stateDirectory: paths.state });
      return "Clarification sent before contract sealing.";
    },
    command: async (command, args) => {
      if (command === "/quit") return { message: "Goodbye.", quit: true };
      if (command === "/help") return { message: commandPalette() };
      if (command === "/new") {
        if (!args) return { message: "Usage: /new <goal>" };
        return { message: await startAndDriveTask(args, true) };
      }
      if (command === "/task") return { message: latest ? `Goal: ${latest.goal}\nContract: ${latest.sealed ? "sealed" : "open"}\nRun: ${latest.run_id ?? "not prepared"}` : "No active task." };
      if (command === "/web") {
        const code = await runWebCommand(args ? [args] : ["status"], webIo);
        await reloadBridge();
        return { message: `Web command finished with exit ${code}.` };
      }
      if (command === "/doctor") {
        const lines: string[] = [];
        const code = await runControlCommand("doctor", ["--state-dir", paths.state, "--config", paths.config], { stdout: (value) => lines.push(value), stderr: (value) => lines.push(value) });
        return { message: `${lines.join("\n")}\nDoctor exit: ${code}` };
      }
      if (command === "/status") {
        if (!latest?.run_id) return { message: latest ? `Authoring state: ${latest.state}` : "No active run." };
        const lines: string[] = [];
        const code = await runControlCommand("status", ["--run-id", latest.run_id, "--state-dir", paths.state], { stdout: (value) => lines.push(value), stderr: (value) => lines.push(value) });
        return { message: lines.join("\n") || `Status exit: ${code}` };
      }
      if (command === "/review") return { message: latest?.run_id ? await reviewSummary(latest.run_id, paths.state) : "No active run." };
      if (command === "/pause" || command === "/resume") {
        if (!latest?.run_id) return { message: "No prepared run to pause/resume." };
        const lines: string[] = [];
        const code = await runControlCommand(command.slice(1), ["--run-id", latest.run_id, "--state-dir", paths.state], { stdout: (value) => lines.push(value), stderr: (value) => lines.push(value) });
        return { message: lines.join("\n") || `Command exit: ${code}` };
      }
      if (command === "/run") {
        if (!latest) return { message: "Enter a task goal first." };
        if (!await ensureWebConnected()) return { message: "Web Architect is not connected." };
        if (latest.state !== "IMPLEMENTATION_REGISTERED") {
          await openWebArchitect();
          await waitForImplementation();
        }
        return { message: await continueThroughFinalReview() };
      }
      if (command === "/uninstall") {
        const answer = (await io.question("Remove WCO-owned local data and uninstall WCO? Your repositories/branches/PRs will be preserved. [y/N] ")).trim();
        if (!/^y(es)?$/i.test(answer)) return { message: "Uninstall cancelled." };
        const code = await runUninstallCommand(["--purge", "--yes"]);
        return { message: code === 0 ? "WCO uninstall scheduled/completed. Goodbye." : `Uninstall failed with exit ${code}.`, quit: code === 0 };
      }
      if (command === "/config") {
        if (args === "web") {
          const code = await runWebCommand(["connect"], webIo);
          await reloadBridge();
          return { message: code === 0 ? configSummary(config, paths, repositoryId) : `Web configuration failed with exit ${code}.` };
        }
        return { message: configSummary(config, paths, repositoryId) };
      }
      if (command === "/history") {
        const previous = await listLocalTaskHistory(paths.state, repositoryId, 10);
        const entries = [...(latest ? [latest] : []), ...previous].slice(0, 10);
        return { message: entries.length ? entries.map((item, index) => `${index + 1}. ${item.goal}\n   ${item.state} · ${item.run_id ?? "not prepared"} · ${item.updated_at}`).join("\n") : "No task history for this repository." };
      }
      return { message: `Unknown command '${command}'. Type / for the command palette.` };
    },
  });
  return 0;
}
