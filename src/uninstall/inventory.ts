import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { TrustedConfig } from "../config/contracts.js";

export interface UninstallInventory { home: string; owned_paths: string[]; protected_repositories: string[]; warnings: string[]; }
export async function inventoryOwnedResources(home: string, config?: TrustedConfig): Promise<UninstallInventory> { const absolute = path.resolve(home); const stat = await lstat(absolute); if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error("UNINSTALL_HOME_UNSAFE: WCO home is not a canonical directory."); const names = await readdir(absolute); if (names.length > 10_000) throw new Error("UNINSTALL_INVENTORY_LIMIT: WCO home entry count exceeds the safe bound."); const protectedRepositories = config ? await Promise.all(Object.values(config.repositories).map(async (repository) => await realpath(repository.path))) : []; return { home: absolute, owned_paths: names.sort().map((name) => path.join(absolute, name)), protected_repositories: protectedRepositories, warnings: [] }; }
