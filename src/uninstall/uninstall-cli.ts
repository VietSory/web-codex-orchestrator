import { access } from "node:fs/promises";
import { loadTrustedConfig } from "../config/config-loader.js";
import { resolveWcoPaths } from "../setup/default-paths.js";
import { purgeWcoHome } from "./purge.js";
import { planSelfUninstall, scheduleSelfUninstall } from "./self-uninstall.js";

export async function runUninstallCommand(args: string[]): Promise<number> {
  const purge = args.includes("--purge"), yes = args.includes("--yes"), json = args.includes("--json");
  if (!purge || args.some((arg) => !["--purge", "--yes", "--json"].includes(arg))) {
    process.stderr.write("Usage: wco uninstall --purge [--yes] [--json]\n");
    return 2;
  }
  const paths = resolveWcoPaths({});
  let config;
  try { await access(paths.config); config = await loadTrustedConfig(paths.config); }
  catch { /* missing config is still uninstallable */ }
  try {
    const selfPlan = planSelfUninstall();
    const plan = await purgeWcoHome({ home: paths.home, ...(config ? { config } : {}), dryRun: !yes });
    if (!yes) {
      if (json) process.stdout.write(`${JSON.stringify({ status: "confirmation_required", inventory: plan, self_uninstall: selfPlan })}\n`);
      else {
        process.stdout.write(`Remove Web Codex Orchestrator?\n\nWCO will remove:\n${plan.owned_paths.map((item) => `  ${item}`).join("\n")}\n\nWCO will NOT remove source repositories, Git history, remote branches, Pull Requests, or deployments.\n\nNothing was removed. Re-run with --yes to confirm.\n`);
      }
      return 1;
    }
    const self = await scheduleSelfUninstall(selfPlan);
    if (json) process.stdout.write(`${JSON.stringify({ status: "purged", inventory: plan, self_uninstall: self })}\n`);
    else {
      process.stdout.write(`Remove Web Codex Orchestrator?\n\nWCO removed its owned local data. Source repositories, Git history, remote branches and Pull Requests were preserved.\n${self.explanation}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\nNo source repository or remote resource was changed.\n`);
    return 1;
  }
}
