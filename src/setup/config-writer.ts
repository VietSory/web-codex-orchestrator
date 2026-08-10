import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { loadTrustedConfig } from "../config/config-loader.js";
import type { TrustedConfig } from "../config/contracts.js";

async function ensureRealDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`CONFIG_PATH_UNSAFE: '${current}' is not a real directory.`);
    } else {
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`CONFIG_PATH_UNSAFE: '${current}' could not be created safely.`);
    }
  }
  if (await realpath(resolved) !== resolved) throw new Error("CONFIG_PATH_UNSAFE: config parent resolves through a symbolic link.");
}

export async function writeTrustedConfigAtomic(
  configPath: string,
  config: TrustedConfig,
  options: { overwrite?: boolean; now?: () => Date } = {},
): Promise<{ config: TrustedConfig; backup_path: string | null }> {
  const target = path.resolve(configPath);
  await ensureRealDirectory(path.dirname(target));
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink() || existing && !existing.isFile()) throw new Error("CONFIG_PATH_UNSAFE: config target is not a regular file.");
  if (existing && !options.overwrite) throw new Error("CONFIG_ALREADY_EXISTS: existing config was preserved; explicit overwrite confirmation is required.");
  let backupPath: string | null = null;
  if (existing) {
    await loadTrustedConfig(target);
    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    backupPath = `${target}.backup-${stamp}`;
    await copyFile(target, backupPath, constants.COPYFILE_EXCL);
    await chmod(backupPath, 0o600).catch(() => undefined);
  }
  const bytes = canonicalJsonBuffer(config);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const finalCheck = await lstat(target).catch(() => null);
    if (finalCheck?.isSymbolicLink()) throw new Error("CONFIG_PATH_UNSAFE: config target became a symbolic link.");
    if (!existing && finalCheck) throw new Error("CONFIG_WRITE_CONFLICT: config target appeared during atomic write.");
    if (existing && (!finalCheck || !finalCheck.isFile() || finalCheck.dev !== existing.dev || finalCheck.ino !== existing.ino || finalCheck.size !== existing.size || finalCheck.mtimeMs !== existing.mtimeMs)) throw new Error("CONFIG_WRITE_CONFLICT: existing config changed during atomic write.");
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
    const directory = await open(path.dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    const leftover = await lstat(temporary).catch(() => null);
    if (leftover?.isFile() && !leftover.isSymbolicLink()) {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporary).catch(() => undefined);
    }
  }
  return { config: await loadTrustedConfig(target), backup_path: backupPath };
}
