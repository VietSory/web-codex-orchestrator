import { access, realpath } from "node:fs/promises";
import { loadTrustedConfig } from "../config/config-loader.js";
import { runControlCommand } from "../orchestration/control-cli.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { detectRepository } from "../setup/repository-detect.js";
import { runSetupCommand } from "../setup/setup-cli.js";
import { runUninstallCommand } from "../uninstall/uninstall-cli.js";
import { advanceLocalWorker, appendLocalClarification, readLocalWorkerSession, startLocalAuthoring } from "../web-bridge/local-worker.js";
import { createConfiguredWebBridge } from "../web-bridge/bridge-factory.js";
import { runWebCommand } from "../web-bridge/web-cli.js";
import { createPendingFinalReview } from "../web-bridge/final-review-service.js";
import { materializeAndSubmitWebVerdict } from "../web-bridge/verdict-materializer.js";
import { commandPalette } from "./slash-commands.js";
import { deriveUserStage } from "./stages.js";
import { runInteractiveSession, terminalIo, type InteractiveIo } from "./session.js";

export async function runInteractiveApp(io: InteractiveIo = terminalIo()): Promise<number> { const paths = resolveWcoPaths({}); try { await access(paths.config); } catch { io.write("First-time setup\n"); const code = await runSetupCommand([], process.cwd()); if (code !== 0) return code; }
  const config = await loadTrustedConfig(paths.config); const detected = await detectRepository(process.cwd()); const root = await realpath(detected.root); const registration = Object.entries(config.repositories).find(([, value]) => value.path === root || value.path.toLowerCase() === root.toLowerCase()); if (!registration) { io.write("This repository is not registered in the trusted WCO config. Run `wco setup` here.\n"); return 1; } const [repositoryId, repositoryConfig] = registration; const bridge = createConfiguredWebBridge(config, paths.bridge); let latest = await readLocalWorkerSession(paths.state, repositoryId);
  await runInteractiveSession(io, {
    state: async () => { latest = await readLocalWorkerSession(paths.state, repositoryId); return { active: Boolean(latest && latest.state !== "BLOCKED"), sealed: latest?.sealed ?? false, summary: `WCO · ${repositoryId}\nRepository   ${detected.base_branch}@${detected.base_commit.slice(0, 7)}\nStatus       ${deriveUserStage(latest)}${latest ? `\nTask         ${latest.goal}` : ""}` }; },
    newTask: async (goal) => { latest = await startLocalAuthoring({ bridge, repository: { repository_id: repositoryId, base_branch: detected.base_branch, base_commit: detected.base_commit }, goal, stateDirectory: paths.state }); return `Web authoring job created: ${latest.job_id}\nUse /web open, then /run to continue.`; },
    clarify: async (value) => { if (!latest) return "No active task. Enter a goal to start one."; await appendLocalClarification({ bridge, session: latest, value, stateDirectory: paths.state }); return "Clarification sent before contract sealing."; },
    command: async (command, args) => {
      if (command === "/quit") return { message: "Goodbye.", quit: true };
      if (command === "/help") return { message: commandPalette() };
      if (command === "/new") { if (!args) return { message: "Usage: /new <goal>" }; latest = await startLocalAuthoring({ bridge, repository: { repository_id: repositoryId, base_branch: detected.base_branch, base_commit: detected.base_commit }, goal: args, stateDirectory: paths.state, replaceExplicit: true }); return { message: `Web authoring job created: ${latest.job_id}` }; }
      if (command === "/task") return { message: latest ? `Goal: ${latest.goal}\nContract: ${latest.sealed ? "sealed" : "open"}\nRun: ${latest.run_id ?? "not prepared"}` : "No active task." };
      if (command === "/web") { const code = await runWebCommand(args ? [args] : ["status"]); return { message: `Web command finished with exit ${code}.` }; }
      if (command === "/doctor") { const lines: string[] = []; const code = await runControlCommand("doctor", ["--state-dir", paths.state, "--config", paths.config], { stdout: (value) => lines.push(value), stderr: (value) => lines.push(value) }); return { message: `${lines.join("\n")}\nDoctor exit: ${code}` }; }
      if (command === "/status" || command === "/review") { if (!latest?.run_id) return { message: latest ? `Authoring state: ${latest.state}` : "No active run." }; const lines: string[] = []; const code = await runControlCommand("status", ["--run-id", latest.run_id, "--state-dir", paths.state], { stdout: (value) => lines.push(value), stderr: (value) => lines.push(value) }); return { message: lines.join("\n") || `Status exit: ${code}` }; }
      if (command === "/pause" || command === "/resume") { if (!latest?.run_id) return { message: "No prepared run to pause/resume." }; const lines: string[] = []; const code = await runControlCommand(command.slice(1), ["--run-id", latest.run_id, "--state-dir", paths.state], { stdout: (value) => lines.push(value), stderr: (value) => lines.push(value) }); return { message: lines.join("\n") || `Command exit: ${code}` }; }
      if (command === "/run") { if (!latest) return { message: "Enter a task goal first." }; latest = await advanceLocalWorker({ bridge, session: latest, repositoryPath: repositoryConfig.path, stateDirectory: paths.state, configPath: paths.config, config }); if (latest.state !== "IMPLEMENTATION_REGISTERED" || !latest.run_id) return { message: `Workflow is waiting at ${latest.state}. Web can continue through the configured bridge.` }; const lines: string[] = []; let code = await runControlCommand("continue", ["--run-id", latest.run_id, "--state-dir", paths.state, "--config", paths.config, "--max-transitions", "8"], { stdout: (value) => lines.push(value), stderr: (value) => lines.push(value) }); try { const review = await createPendingFinalReview({ bridge, runId: latest.run_id, stateDirectory: paths.state }); const verdict = await bridge.waitForVerdict(review.job_id); if (!verdict) return { message: `${lines.join("\n")}\nWaiting for ChatGPT Web final review…` }; const adopted = await materializeAndSubmitWebVerdict({ envelope: verdict, stateDirectory: paths.state, configPath: paths.config }); lines.push(`Web final review: ${adopted.receipt.state}`); code = await runControlCommand("continue", ["--run-id", latest.run_id, "--state-dir", paths.state, "--config", paths.config, "--max-transitions", "8"], { stdout: (value) => lines.push(value), stderr: (value) => lines.push(value) }); } catch (error) { if (!(error instanceof Error) || !error.message.includes("not ready")) throw error; } return { message: `${lines.join("\n")}\nWorkflow exit: ${code}` }; }
      if (command === "/uninstall") { const code = await runUninstallCommand(["--purge"]); return { message: `Uninstall preview exit: ${code}. Use non-interactive \`wco uninstall --purge --yes\` to confirm.` }; }
      if (command === "/config") return { message: `Config: ${paths.config}\nState: ${paths.state}` };
      if (command === "/history") return { message: latest ? `Latest task: ${latest.goal}\nRun: ${latest.run_id ?? "not prepared"}` : "No local task history for this repository." };
      return { message: `Unknown command '${command}'. Type / for the command palette.` };
    },
  }); return 0;
}
