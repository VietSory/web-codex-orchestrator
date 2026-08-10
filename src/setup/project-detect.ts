import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export interface ProjectDiscovery {
  kinds: Array<"node" | "python" | "go" | "rust" | "dotnet">;
  package_manager: "npm" | "pnpm" | "yarn" | null;
  suggested_commands: Array<{ id: string; executable: string; args: string[] }>;
}

async function regular(root: string, name: string): Promise<boolean> {
  const info = await lstat(path.join(root, name)).catch(() => null);
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

export async function detectProject(root: string): Promise<ProjectDiscovery> {
  const kinds: ProjectDiscovery["kinds"] = [];
  const suggested: ProjectDiscovery["suggested_commands"] = [];
  let packageManager: ProjectDiscovery["package_manager"] = null;
  if (await regular(root, "package.json")) {
    kinds.push("node");
    const info = await lstat(path.join(root, "package.json"));
    if (info.size > 1_048_576) throw new Error("PROJECT_DETECTION_FAILED: package.json exceeds the setup read limit.");
    const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: unknown };
    packageManager = await regular(root, "pnpm-lock.yaml") ? "pnpm" : await regular(root, "yarn.lock") ? "yarn" : "npm";
    const scripts = parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts) ? parsed.scripts as Record<string, unknown> : {};
    for (const id of ["test", "typecheck", "lint", "build"]) if (typeof scripts[id] === "string") suggested.push({ id, executable: packageManager, args: packageManager === "yarn" ? [id] : ["run", id] });
  }
  if (await regular(root, "pyproject.toml") || await regular(root, "requirements.txt")) { kinds.push("python"); suggested.push({ id: "test", executable: "python", args: ["-m", "pytest"] }); }
  if (await regular(root, "go.mod")) { kinds.push("go"); suggested.push({ id: "test", executable: "go", args: ["test", "./..."] }); }
  if (await regular(root, "Cargo.toml")) { kinds.push("rust"); suggested.push({ id: "test", executable: "cargo", args: ["test"] }); }
  if (await regular(root, "global.json") || await regular(root, "Directory.Build.props")) { kinds.push("dotnet"); suggested.push({ id: "test", executable: "dotnet", args: ["test"] }); }
  return { kinds, package_manager: packageManager, suggested_commands: suggested };
}
