import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ExecutionError } from "./errors.js";

export interface BundleSnapshot { sha256: string; files: string[]; }

async function collect(root: string, current = root, result: Array<{ relative: string; hash: string }> = []): Promise<Array<{ relative: string; hash: string }>> {
  const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    const relative = path.relative(root, full).replaceAll(path.sep, "/");
    const info = await lstat(full);
    if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new ExecutionError("BUNDLE_MUTATED", "Accepted bundle contains an unsafe filesystem object.");
    if (info.isDirectory()) await collect(root, full, result);
    else result.push({ relative, hash: createHash("sha256").update(await readFile(full)).digest("hex") });
  }
  return result;
}

export async function snapshotBundle(bundlePath: string): Promise<BundleSnapshot> {
  const files = await collect(path.resolve(bundlePath));
  const sha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { sha256, files: files.map((entry) => `${entry.relative}:${entry.hash}`) };
}

export async function assertBundleUnchanged(bundlePath: string, expected: BundleSnapshot): Promise<void> {
  const actual = await snapshotBundle(bundlePath);
  if (actual.sha256 !== expected.sha256 || actual.files.length !== expected.files.length || actual.files.some((value, index) => value !== expected.files[index])) throw new ExecutionError("BUNDLE_MUTATED", "Accepted bundle changed during execution.");
}
