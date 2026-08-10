import { fileURLToPath } from "node:url";
import path from "node:path";

export interface SelfUninstallPlan { supported: boolean; command?: string[]; explanation: string; }
export function planSelfUninstall(): SelfUninstallPlan { const current = fileURLToPath(import.meta.url); const normalized = current.replaceAll("\\", "/"); if (normalized.includes("/lib/node_modules/web-codex-orchestrator/") || normalized.includes("/node_modules/web-codex-orchestrator/")) return { supported: true, command: [process.platform === "win32" ? "npm.cmd" : "npm", "uninstall", "-g", "web-codex-orchestrator"], explanation: "Run the global npm uninstall after this WCO process exits." }; return { supported: false, explanation: `This installation appears to be a source checkout or npm link (${path.dirname(current)}). WCO did not delete source; remove the link/package explicitly after reviewing it.` }; }
